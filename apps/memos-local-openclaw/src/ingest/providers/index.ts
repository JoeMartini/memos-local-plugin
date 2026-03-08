import type { SummarizerConfig, Logger } from "../../types";
import { summarizeOpenAI, summarizeTaskOpenAI, judgeNewTopicOpenAI, filterRelevantOpenAI, judgeDedupOpenAI } from "./openai";
import type { FilterResult, DedupResult } from "./openai";
export type { FilterResult, DedupResult } from "./openai";
import { summarizeAnthropic, summarizeTaskAnthropic, judgeNewTopicAnthropic, filterRelevantAnthropic, judgeDedupAnthropic } from "./anthropic";
import { summarizeGemini, summarizeTaskGemini, judgeNewTopicGemini, filterRelevantGemini, judgeDedupGemini } from "./gemini";
import { summarizeBedrock, summarizeTaskBedrock, judgeNewTopicBedrock, filterRelevantBedrock, judgeDedupBedrock } from "./bedrock";

export class Summarizer {
  constructor(
    private cfg: SummarizerConfig | undefined,
    private log: Logger,
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
        throw new Error("OpenClaw host completion is not available in this sidecar build");
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
        throw new Error("OpenClaw host completion is not available in this sidecar build");
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
        throw new Error("OpenClaw host completion is not available in this sidecar build");
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
        throw new Error("OpenClaw host completion is not available in this sidecar build");
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
        throw new Error("OpenClaw host completion is not available in this sidecar build");
      default:
        throw new Error(`Unknown summarizer provider: ${cfg.provider}`);
    }
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
