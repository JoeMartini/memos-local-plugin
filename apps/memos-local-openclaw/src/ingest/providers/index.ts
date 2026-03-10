import * as fs from "fs";
import * as path from "path";
import type { SummarizerConfig, Logger, OpenClawAPI } from "../../types";
import { summarizeOpenAI, summarizeTaskOpenAI, judgeNewTopicOpenAI, filterRelevantOpenAI, judgeDedupOpenAI, parseFilterResult, parseDedupResult } from "./openai";
import type { FilterResult, DedupResult } from "./openai";
export type { FilterResult, DedupResult } from "./openai";
import { summarizeAnthropic, summarizeTaskAnthropic, judgeNewTopicAnthropic, filterRelevantAnthropic, judgeDedupAnthropic } from "./anthropic";
import { summarizeGemini, summarizeTaskGemini, judgeNewTopicGemini, filterRelevantGemini, judgeDedupGemini } from "./gemini";
import { summarizeBedrock, summarizeTaskBedrock, judgeNewTopicBedrock, filterRelevantBedrock, judgeDedupBedrock } from "./bedrock";

/**
 * Build a SummarizerConfig from OpenClaw's native model configuration (openclaw.json).
 * This serves as the final fallback when both strongCfg and plugin summarizer fail or are absent.
 */
function loadOpenClawFallbackConfig(log: Logger): SummarizerConfig | undefined {
  try {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const cfgPath = path.join(home, ".openclaw", "openclaw.json");
    if (!fs.existsSync(cfgPath)) return undefined;

    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));

    const agentModel: string | undefined = raw?.agents?.defaults?.model?.primary;
    if (!agentModel) return undefined;

    const [providerKey, modelId] = agentModel.includes("/")
      ? agentModel.split("/", 2)
      : [undefined, agentModel];

    const providerCfg = providerKey
      ? raw?.models?.providers?.[providerKey]
      : Object.values(raw?.models?.providers ?? {})[0] as any;
    if (!providerCfg) return undefined;

    const baseUrl: string | undefined = providerCfg.baseUrl;
    const apiKey: string | undefined = providerCfg.apiKey;
    if (!baseUrl || !apiKey) return undefined;

    const endpoint = baseUrl.endsWith("/chat/completions")
      ? baseUrl
      : baseUrl.replace(/\/+$/, "") + "/chat/completions";

    log.debug(`OpenClaw fallback model: ${modelId} via ${baseUrl}`);
    return {
      provider: "openai_compatible",
      endpoint,
      apiKey,
      model: modelId,
    };
  } catch (err) {
    log.debug(`Failed to load OpenClaw fallback config: ${err}`);
    return undefined;
  }
}

export class Summarizer {
  private strongCfg: SummarizerConfig | undefined;
  private fallbackCfg: SummarizerConfig | undefined;

  constructor(
    private cfg: SummarizerConfig | undefined,
    private log: Logger,
    private openclawAPI?: OpenClawAPI,
    strongCfg?: SummarizerConfig,
  ) {
    this.strongCfg = strongCfg;
    this.fallbackCfg = loadOpenClawFallbackConfig(log);
  }

  /**
   * Ordered config chain: strongCfg → cfg → fallbackCfg (OpenClaw native model).
   * Returns configs that are defined, in priority order.
   * Openclaw configs without hostCompletion capability or without openclawAPI are excluded.
   */
  private getConfigChain(): SummarizerConfig[] {
    const chain: SummarizerConfig[] = [];
    if (this.strongCfg) chain.push(this.strongCfg);
    if (this.cfg) {
      if (this.cfg.provider === "openclaw") {
        if (this.cfg.capabilities?.hostCompletion === true && this.openclawAPI) {
          chain.push(this.cfg);
        }
      } else {
        chain.push(this.cfg);
      }
    }
    if (this.fallbackCfg) chain.push(this.fallbackCfg);
    return chain;
  }

  /**
   * Try calling fn with each config in the chain until one succeeds.
   * Returns undefined if all fail.
   */
  private async tryChain<T>(
    label: string,
    fn: (cfg: SummarizerConfig) => Promise<T>,
  ): Promise<T | undefined> {
    const chain = this.getConfigChain();
    for (let i = 0; i < chain.length; i++) {
      try {
        return await fn(chain[i]);
      } catch (err) {
        const level = i < chain.length - 1 ? "warn" : "error";
        const modelInfo = `${chain[i].provider}/${chain[i].model ?? "?"}`;
        this.log[level](`${label} failed (${modelInfo}), ${i < chain.length - 1 ? "trying next" : "no more fallbacks"}: ${err}`);
      }
    }
    return undefined;
  }

  async summarize(text: string): Promise<string> {
    if (!this.cfg && !this.fallbackCfg) {
      return ruleFallback(text);
    }

    const result = await this.tryChain("summarize", (cfg) =>
      cfg.provider === "openclaw" ? this.summarizeOpenClaw(text) : callSummarize(cfg, text, this.log),
    );
    return result ?? ruleFallback(text);
  }

  async summarizeTask(text: string): Promise<string> {
    if (!this.cfg && !this.fallbackCfg) {
      return taskFallback(text);
    }

    const result = await this.tryChain("summarizeTask", (cfg) =>
      cfg.provider === "openclaw" ? this.summarizeTaskOpenClaw(text) : callSummarizeTask(cfg, text, this.log),
    );
    return result ?? taskFallback(text);
  }

  async judgeNewTopic(currentContext: string, newMessage: string): Promise<boolean | null> {
    if (!this.cfg && !this.fallbackCfg) return null;

    const result = await this.tryChain("judgeNewTopic", (cfg) =>
      cfg.provider === "openclaw"
        ? this.judgeNewTopicOpenClaw(currentContext, newMessage)
        : callTopicJudge(cfg, currentContext, newMessage, this.log),
    );
    return result ?? null;
  }

  async filterRelevant(
    query: string,
    candidates: Array<{ index: number; summary: string; role: string }>,
  ): Promise<FilterResult | null> {
    if (!this.cfg && !this.fallbackCfg) return null;
    if (candidates.length === 0) return { relevant: [], sufficient: true };

    const result = await this.tryChain("filterRelevant", (cfg) =>
      cfg.provider === "openclaw"
        ? this.filterRelevantOpenClaw(query, candidates)
        : callFilterRelevant(cfg, query, candidates, this.log),
    );
    return result ?? null;
  }

  async judgeDedup(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult | null> {
    if (!this.cfg && !this.fallbackCfg) return null;
    if (candidates.length === 0) return null;

    const result = await this.tryChain("judgeDedup", (cfg) =>
      cfg.provider === "openclaw"
        ? this.judgeDedupOpenClaw(newSummary, candidates)
        : callJudgeDedup(cfg, newSummary, candidates, this.log),
    );
    return result ?? { action: "NEW", reason: "all_models_failed" };
  }

  getStrongConfig(): SummarizerConfig | undefined {
    return this.strongCfg;
  }

  // ─── OpenClaw API Implementation ───

  private requireOpenClawAPI(): void {
    if (!this.openclawAPI) {
      throw new Error(
        "OpenClaw API not available. Ensure sharing.capabilities.hostCompletion is enabled in config."
      );
    }
  }

  private async summarizeOpenClaw(text: string): Promise<string> {
    this.requireOpenClawAPI();
    const prompt = [
      `Summarize the text in ONE concise sentence (max 120 characters). IMPORTANT: Use the SAME language as the input text — if the input is Chinese, write Chinese; if English, write English. Preserve exact names, commands, error codes. No bullet points, no preamble — output only the sentence.`,
      ``,
      text.slice(0, 2000),
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 100,
      temperature: 0,
      model: this.cfg?.model,
    });

    return response.text.trim().slice(0, 200);
  }

  private async summarizeTaskOpenClaw(text: string): Promise<string> {
    this.requireOpenClawAPI();
    const prompt = [
      OPENCLAW_TASK_SUMMARY_PROMPT,
      ``,
      text,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 4096,
      temperature: 0.1,
      model: this.cfg?.model,
    });

    return response.text.trim();
  }

  private async judgeNewTopicOpenClaw(currentContext: string, newMessage: string): Promise<boolean> {
    this.requireOpenClawAPI();
    const prompt = [
      OPENCLAW_TOPIC_JUDGE_PROMPT,
      ``,
      `CURRENT CONVERSATION SUMMARY:`,
      currentContext,
      ``,
      `NEW USER MESSAGE:`,
      newMessage,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 10,
      temperature: 0,
      model: this.cfg?.model,
    });

    const answer = response.text.trim().toUpperCase();
    this.log.debug(`Topic judge result: "${answer}"`);
    return answer.startsWith("NEW");
  }

  private async filterRelevantOpenClaw(
    query: string,
    candidates: Array<{ index: number; summary: string; role: string }>,
  ): Promise<FilterResult> {
    this.requireOpenClawAPI();
    const candidateText = candidates
      .map((c) => `${c.index}. [${c.role}] ${c.summary}`)
      .join("\n");

    const prompt = [
      OPENCLAW_FILTER_RELEVANT_PROMPT,
      ``,
      `QUERY: ${query}`,
      ``,
      `CANDIDATES:`,
      candidateText,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 200,
      temperature: 0,
      model: this.cfg?.model,
    });

    return parseFilterResult(response.text.trim(), this.log);
  }

  private async judgeDedupOpenClaw(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult> {
    this.requireOpenClawAPI();
    const candidateText = candidates
      .map((c) => `${c.index}. ${c.summary}`)
      .join("\n");

    const prompt = [
      OPENCLAW_DEDUP_JUDGE_PROMPT,
      ``,
      `NEW MEMORY:`,
      newSummary,
      ``,
      `EXISTING MEMORIES:`,
      candidateText,
    ].join("\n");

    const response = await this.openclawAPI!.complete({
      prompt,
      maxTokens: 300,
      temperature: 0,
      model: this.cfg?.model,
    });

    return parseDedupResult(response.text.trim(), this.log);
  }
}

// ─── Dispatch helpers ───

function callSummarize(cfg: SummarizerConfig, text: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
      return summarizeOpenAI(text, cfg, log);
    case "anthropic":
      return summarizeAnthropic(text, cfg, log);
    case "gemini":
      return summarizeGemini(text, cfg, log);
    case "bedrock":
      return summarizeBedrock(text, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callSummarizeTask(cfg: SummarizerConfig, text: string, log: Logger): Promise<string> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
      return summarizeTaskOpenAI(text, cfg, log);
    case "anthropic":
      return summarizeTaskAnthropic(text, cfg, log);
    case "gemini":
      return summarizeTaskGemini(text, cfg, log);
    case "bedrock":
      return summarizeTaskBedrock(text, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callTopicJudge(cfg: SummarizerConfig, currentContext: string, newMessage: string, log: Logger): Promise<boolean> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
      return judgeNewTopicOpenAI(currentContext, newMessage, cfg, log);
    case "anthropic":
      return judgeNewTopicAnthropic(currentContext, newMessage, cfg, log);
    case "gemini":
      return judgeNewTopicGemini(currentContext, newMessage, cfg, log);
    case "bedrock":
      return judgeNewTopicBedrock(currentContext, newMessage, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callFilterRelevant(cfg: SummarizerConfig, query: string, candidates: Array<{ index: number; summary: string; role: string }>, log: Logger): Promise<FilterResult> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
      return filterRelevantOpenAI(query, candidates, cfg, log);
    case "anthropic":
      return filterRelevantAnthropic(query, candidates, cfg, log);
    case "gemini":
      return filterRelevantGemini(query, candidates, cfg, log);
    case "bedrock":
      return filterRelevantBedrock(query, candidates, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

function callJudgeDedup(cfg: SummarizerConfig, newSummary: string, candidates: Array<{ index: number; summary: string; chunkId: string }>, log: Logger): Promise<DedupResult> {
  switch (cfg.provider) {
    case "openai":
    case "openai_compatible":
    case "azure_openai":
      return judgeDedupOpenAI(newSummary, candidates, cfg, log);
    case "anthropic":
      return judgeDedupAnthropic(newSummary, candidates, cfg, log);
    case "gemini":
      return judgeDedupGemini(newSummary, candidates, cfg, log);
    case "bedrock":
      return judgeDedupBedrock(newSummary, candidates, cfg, log);
    default:
      throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
  }
}

// ─── Fallbacks ───

function taskFallback(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  return lines.slice(0, 30).join("\n").slice(0, 2000);
}

function ruleFallback(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 10);
  const first = (lines[0] ?? text).trim();

  const entityRe = [/`[^`]+`/g, /\b(?:error|Error|ERROR)\s*[:：]\s*.{5,60}/g];
  const entities: string[] = [];
  for (const re of entityRe) {
    for (const m of text.matchAll(re)) {
      if (entities.length < 3) entities.push(m[0].slice(0, 50));
    }
  }

  let summary = first.length > 120 ? first.slice(0, 117) + "..." : first;
  if (entities.length > 0) {
    summary += ` (${entities.join(", ")})`;
  }
  return summary.slice(0, 200);
}

// ─── OpenClaw Prompt Templates (aligned with openai.ts) ───

const OPENCLAW_TASK_SUMMARY_PROMPT = `You create a DETAILED task summary from a multi-turn conversation. This summary will be the ONLY record of this conversation, so it must preserve ALL important information.

CRITICAL LANGUAGE RULE: You MUST write in the SAME language as the user's messages. Chinese input → Chinese output. English input → English output. NEVER mix languages.

Output EXACTLY this structure:

📌 Title
A short, descriptive title (10-30 characters). Like a chat group name.

🎯 Goal
One sentence: what the user wanted to accomplish.

📋 Key Steps
- Describe each meaningful step in detail
- Include the ACTUAL content produced: code snippets, commands, config blocks, formulas, key paragraphs
- For code: include the function signature and core logic (up to ~30 lines per block), use fenced code blocks
- For configs: include the actual config values and structure
- For lists/instructions: include the actual items, not just "provided a list"
- Merge only truly trivial back-and-forth (like "ok" / "sure")
- Do NOT over-summarize: "provided a function" is BAD; show the actual function

✅ Result
What was the final outcome? Include the final version of any code/config/content produced.

💡 Key Details
- Decisions made, trade-offs discussed, caveats noted, alternative approaches mentioned
- Specific values: numbers, versions, thresholds, URLs, file paths, model names
- Omit this section only if there truly are no noteworthy details

RULES:
- This summary is a KNOWLEDGE BASE ENTRY, not a brief note. Be thorough.
- PRESERVE verbatim: code, commands, URLs, file paths, error messages, config values, version numbers, names, amounts
- DISCARD only: greetings, filler, the assistant explaining what it will do before doing it
- Replace secrets (API keys, tokens, passwords) with [REDACTED]
- Target length: 30-50% of the original conversation length. Longer conversations need longer summaries.
- Output summary only, no preamble.`;

const OPENCLAW_TOPIC_JUDGE_PROMPT = `You are a conversation topic boundary detector. Given a summary of the CURRENT conversation and a NEW user message, determine if the new message starts a DIFFERENT topic/task.

Answer ONLY "NEW" or "SAME".

Rules:
- "NEW" = the new message is about a completely different subject, project, or task
- "SAME" = the new message continues, follows up on, or is closely related to the current topic
- Follow-up questions, clarifications, refinements, bug fixes, or next steps on the same task = SAME
- Greetings or meta-questions like "你好" or "谢谢" without new substance = SAME
- A clearly unrelated request (e.g., current topic is deployment, new message asks about cooking) = NEW

Output exactly one word: NEW or SAME`;

const OPENCLAW_FILTER_RELEVANT_PROMPT = `You are a memory relevance judge. Given a user's QUERY and a list of CANDIDATE memory summaries, do two things:

1. Select ALL candidates that could be useful for answering the query. When in doubt, INCLUDE the candidate.
   - For questions about lists, history, or "what/where/who" across multiple items, include ALL matching items.
   - For factual lookups, a single direct answer is enough.
2. Judge whether the selected memories are SUFFICIENT to fully answer the query WITHOUT fetching additional context.

IMPORTANT for "sufficient" judgment:
- sufficient=true ONLY when the memories contain a concrete ANSWER, fact, decision, or actionable information that directly addresses the query.
- sufficient=false when the memories only repeat the question, show related topics but lack the specific detail, or contain partial information.

Output a JSON object with exactly two fields:
{"relevant":[1,3,5],"sufficient":true}

- "relevant": array of candidate numbers that are useful. Empty array [] if none are relevant.
- "sufficient": true ONLY if the memories contain a direct answer; false otherwise.

Output ONLY the JSON object, nothing else.`;

const OPENCLAW_DEDUP_JUDGE_PROMPT = `You are a memory deduplication system. Given a NEW memory summary and several EXISTING memory summaries, determine the relationship.

For each EXISTING memory, the NEW memory is either:
- "DUPLICATE": NEW is fully covered by an EXISTING memory — no new information at all
- "UPDATE": NEW contains information that supplements or updates an EXISTING memory (new data, status change, additional detail)
- "NEW": NEW is a different topic/event despite surface similarity

Pick the BEST match among all candidates. If none match well, choose "NEW".

Output a single JSON object:
- If DUPLICATE: {"action":"DUPLICATE","targetIndex":2,"reason":"..."}
- If UPDATE: {"action":"UPDATE","targetIndex":3,"reason":"...","mergedSummary":"a combined summary preserving all info from both old and new, same language as input"}
- If NEW: {"action":"NEW","reason":"..."}

CRITICAL: mergedSummary must use the SAME language as the input. Output ONLY the JSON object.`;
