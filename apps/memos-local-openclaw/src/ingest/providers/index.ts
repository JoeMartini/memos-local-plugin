import type { SummarizerConfig, Logger, OpenClawAPI } from "../../types";
import { summarizeOpenAI, summarizeTaskOpenAI, judgeNewTopicOpenAI, filterRelevantOpenAI, judgeDedupOpenAI, parseFilterResult, parseDedupResult } from "./openai";
import type { FilterResult, DedupResult } from "./openai";
export type { FilterResult, DedupResult } from "./openai";
import { summarizeAnthropic, summarizeTaskAnthropic, judgeNewTopicAnthropic, filterRelevantAnthropic, judgeDedupAnthropic } from "./anthropic";
import { summarizeGemini, summarizeTaskGemini, judgeNewTopicGemini, filterRelevantGemini, judgeDedupGemini } from "./gemini";
import { summarizeBedrock, summarizeTaskBedrock, judgeNewTopicBedrock, filterRelevantBedrock, judgeDedupBedrock } from "./bedrock";

export class Summarizer {
  constructor(
    private cfg: SummarizerConfig | undefined,
    private log: Logger,
    private openclawAPI?: OpenClawAPI,
  ) {}

  private get provider(): SummarizerConfig["provider"] | undefined {
    if (!this.cfg) {
      return undefined;
    }
    if (this.cfg.provider === "openclaw" && this.cfg.capabilities?.hostCompletion !== true) {
      return undefined;
    }
    return this.cfg.provider;
  }

  async summarize(text: string): Promise<string> {
    if (!this.provider) {
      return ruleFallback(text);
    }

    try {
      return await this.callProvider(text);
    } catch (err) {
      this.log.warn(`Summarizer provider failed, using rule fallback: ${err}`);
      return ruleFallback(text);
    }
  }

  async summarizeTask(text: string): Promise<string> {
    if (!this.provider) {
      return taskFallback(text);
    }

    try {
      return await this.callTaskProvider(text);
    } catch (err) {
      this.log.warn(`Task summarizer failed, using fallback: ${err}`);
      return taskFallback(text);
    }
  }

  private async callProvider(text: string): Promise<string> {
    const cfg = this.cfg!;
    switch (this.provider) {
      case "openai":
      case "openai_compatible":
        return summarizeOpenAI(text, cfg, this.log);
      case "anthropic":
        return summarizeAnthropic(text, cfg, this.log);
      case "gemini":
        return summarizeGemini(text, cfg, this.log);
      case "azure_openai":
        return summarizeOpenAI(text, cfg, this.log);
      case "bedrock":
        return summarizeBedrock(text, cfg, this.log);
      case "openclaw":
        return await this.summarizeOpenClaw(text);
      default:
        throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
    }
  }

  /**
   * Ask the LLM whether the new message starts a different topic from the current conversation.
   * Returns true if it's a new topic, false if it continues the current one.
   * Returns null if no summarizer is configured (caller should fall back to heuristic).
   */
  async judgeNewTopic(currentContext: string, newMessage: string): Promise<boolean | null> {
    if (!this.provider) return null;

    try {
      return await this.callTopicJudge(currentContext, newMessage);
    } catch (err) {
      this.log.warn(`Topic judge failed: ${err}`);
      return null;
    }
  }

  private async callTopicJudge(currentContext: string, newMessage: string): Promise<boolean> {
    const cfg = this.cfg!;
    switch (this.provider) {
      case "openai":
      case "openai_compatible":
      case "azure_openai":
        return judgeNewTopicOpenAI(currentContext, newMessage, cfg, this.log);
      case "anthropic":
        return judgeNewTopicAnthropic(currentContext, newMessage, cfg, this.log);
      case "gemini":
        return judgeNewTopicGemini(currentContext, newMessage, cfg, this.log);
      case "bedrock":
        return judgeNewTopicBedrock(currentContext, newMessage, cfg, this.log);
      case "openclaw":
        return await this.judgeNewTopicOpenClaw(currentContext, newMessage);
      default:
        throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
    }
  }

  /**
   * Filter search results by LLM relevance judgment.
   * Returns { relevant: number[], sufficient: boolean } or null if no summarizer configured.
   */
  async filterRelevant(
    query: string,
    candidates: Array<{ index: number; summary: string; role: string }>,
  ): Promise<FilterResult | null> {
    if (!this.provider) return null;
    if (candidates.length === 0) return { relevant: [], sufficient: true };

    try {
      return await this.callFilterRelevant(query, candidates);
    } catch (err) {
      this.log.warn(`filterRelevant failed, returning all candidates: ${err}`);
      return null;
    }
  }

  private async callFilterRelevant(
    query: string,
    candidates: Array<{ index: number; summary: string; role: string }>,
  ): Promise<FilterResult> {
    const cfg = this.cfg!;
    switch (this.provider) {
      case "openai":
      case "openai_compatible":
      case "azure_openai":
        return filterRelevantOpenAI(query, candidates, cfg, this.log);
      case "anthropic":
        return filterRelevantAnthropic(query, candidates, cfg, this.log);
      case "gemini":
        return filterRelevantGemini(query, candidates, cfg, this.log);
      case "bedrock":
        return filterRelevantBedrock(query, candidates, cfg, this.log);
      case "openclaw":
        return await this.filterRelevantOpenClaw(query, candidates);
      default:
        throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
    }
  }

  /**
   * Judge whether a new memory is DUPLICATE / UPDATE / NEW relative to similar existing memories.
   * Returns null if no summarizer configured (caller should treat as NEW).
   */
  async judgeDedup(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult | null> {
    if (!this.provider) return null;
    if (candidates.length === 0) return null;

    try {
      return await this.callJudgeDedup(newSummary, candidates);
    } catch (err) {
      this.log.warn(`judgeDedup failed, treating as NEW: ${err}`);
      return { action: "NEW", reason: "llm_error" };
    }
  }

  private async callJudgeDedup(
    newSummary: string,
    candidates: Array<{ index: number; summary: string; chunkId: string }>,
  ): Promise<DedupResult> {
    const cfg = this.cfg!;
    switch (this.provider) {
      case "openai":
      case "openai_compatible":
      case "azure_openai":
        return judgeDedupOpenAI(newSummary, candidates, cfg, this.log);
      case "anthropic":
        return judgeDedupAnthropic(newSummary, candidates, cfg, this.log);
      case "gemini":
        return judgeDedupGemini(newSummary, candidates, cfg, this.log);
      case "bedrock":
        return judgeDedupBedrock(newSummary, candidates, cfg, this.log);
      case "openclaw":
        return await this.judgeDedupOpenClaw(newSummary, candidates);
      default:
        throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
    }
  }

  private async callTaskProvider(text: string): Promise<string> {
    const cfg = this.cfg!;
    switch (this.provider) {
      case "openai":
      case "openai_compatible":
      case "azure_openai":
        return summarizeTaskOpenAI(text, cfg, this.log);
      case "anthropic":
        return summarizeTaskAnthropic(text, cfg, this.log);
      case "gemini":
        return summarizeTaskGemini(text, cfg, this.log);
      case "bedrock":
        return summarizeTaskBedrock(text, cfg, this.log);
      case "openclaw":
        return await this.summarizeTaskOpenClaw(text);
      default:
        throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
    }
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
