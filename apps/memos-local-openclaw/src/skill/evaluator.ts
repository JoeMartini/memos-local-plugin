import type { Chunk, Task, Skill, PluginContext, SummarizerConfig } from "../types";
import { DEFAULTS } from "../types";

export interface CreateEvalResult {
  shouldGenerate: boolean;
  reason: string;
  suggestedName: string;
  suggestedTags: string[];
  confidence: number;
}

export interface UpgradeEvalResult {
  shouldUpgrade: boolean;
  upgradeType: "refine" | "extend" | "fix";
  dimensions: string[];
  reason: string;
  mergeStrategy: string;
  confidence: number;
}

const CREATE_EVAL_PROMPT = `You are an experience evaluation expert. Based on the completed task record below, decide whether this task contains reusable experience worth distilling into a "skill".

A skill is a reusable guide that helps an AI agent handle similar tasks better in the future.

Worth distilling (any ONE qualifies):
- Contains concrete steps, commands, code, or configuration
- Solves a recurring problem with a specific approach/workflow
- Went through trial-and-error (wrong approach then corrected)
- Involves non-obvious usage of specific tools, APIs, or frameworks
- Contains debugging/troubleshooting with diagnostic reasoning
- Demonstrates a multi-step workflow using external tools (browser, search, file system, etc.)
- Reveals user preferences or style requirements that should be remembered
- Shows how to combine multiple tools/services to accomplish a goal
- Contains a process that required specific parameter tuning or configuration

NOT worth distilling:
- Pure factual Q&A with no process ("what is TCP", "what's the capital of France")
- Single-turn simple answers with no workflow
- Conversation too fragmented or incoherent to extract a clear process

Task title: {TITLE}
Task summary:
{SUMMARY}

Reply in JSON only, no extra text:
{
  "shouldGenerate": boolean,
  "reason": "brief explanation",
  "suggestedName": "kebab-case-name",
  "suggestedTags": ["tag1", "tag2"],
  "confidence": 0.0-1.0
}`;

const UPGRADE_EVAL_PROMPT = `You are a skill upgrade evaluation expert.

Existing skill (v{VERSION}):
Name: {SKILL_NAME}
Content:
{SKILL_CONTENT}

Newly completed task:
Title: {TITLE}
Summary:
{SUMMARY}

Does the new task bring substantive improvements to the existing skill?

Worth upgrading (any one qualifies):
1. Faster — shorter path discovered
2. More elegant — cleaner, follows best practices better
3. More convenient — fewer dependencies or complexity
4. Fewer tokens — less exploration/trial-and-error needed
5. More accurate — corrects wrong parameters/steps in old skill
6. More robust — adds edge cases, error handling
7. New scenario — covers a variant the old skill didn't
8. Fixes outdated info — old skill has stale information

NOT worth upgrading:
- New task is identical to existing skill
- New task's approach is worse than existing skill
- Differences are trivial

Reply in JSON only, no extra text:
{
  "shouldUpgrade": boolean,
  "upgradeType": "refine" | "extend" | "fix",
  "dimensions": ["faster", "more_elegant", "more_convenient", "fewer_tokens", "more_accurate", "more_robust", "new_scenario", "fix_outdated"],
  "reason": "what new value the task brings",
  "mergeStrategy": "which specific parts need updating",
  "confidence": 0.0-1.0
}`;

export class SkillEvaluator {
  constructor(private ctx: PluginContext) {}

  passesRuleFilter(chunks: Chunk[], task: Task): { pass: boolean; skipReason: string } {
    const minChunks = this.ctx.config.skillEvolution?.minChunksForEval ?? DEFAULTS.skillMinChunksForEval;
    if (chunks.length < minChunks) {
      return { pass: false, skipReason: `chunks不足 (${chunks.length} < ${minChunks})` };
    }

    if (task.status === "skipped") {
      return { pass: false, skipReason: "task状态为skipped" };
    }

    if (task.summary.length < 100) {
      return { pass: false, skipReason: `summary过短 (${task.summary.length} < 100)` };
    }

    const userChunks = chunks.filter(c => c.role === "user");
    if (userChunks.length === 0) {
      return { pass: false, skipReason: "无用户消息" };
    }

    const assistantChunks = chunks.filter(c => c.role === "assistant");
    if (assistantChunks.length === 0) {
      return { pass: false, skipReason: "无助手回复" };
    }

    return { pass: true, skipReason: "" };
  }

  async evaluateCreate(task: Task): Promise<CreateEvalResult> {
    const cfg = this.getProviderConfig();
    if (!cfg) {
      return { shouldGenerate: false, reason: "no LLM configured", suggestedName: "", suggestedTags: [], confidence: 0 };
    }

    const prompt = CREATE_EVAL_PROMPT
      .replace("{TITLE}", task.title)
      .replace("{SUMMARY}", task.summary.slice(0, 3000));

    try {
      const raw = await this.callLLM(cfg, prompt);
      return this.parseJSON<CreateEvalResult>(raw, {
        shouldGenerate: false, reason: "parse failed", suggestedName: "", suggestedTags: [], confidence: 0,
      });
    } catch (err) {
      this.ctx.log.warn(`SkillEvaluator.evaluateCreate failed: ${err}`);
      return { shouldGenerate: false, reason: `error: ${err}`, suggestedName: "", suggestedTags: [], confidence: 0 };
    }
  }

  async evaluateUpgrade(task: Task, skill: Skill, skillContent: string): Promise<UpgradeEvalResult> {
    const cfg = this.getProviderConfig();
    if (!cfg) {
      return { shouldUpgrade: false, upgradeType: "refine", dimensions: [], reason: "no LLM configured", mergeStrategy: "", confidence: 0 };
    }

    const prompt = UPGRADE_EVAL_PROMPT
      .replace("{VERSION}", String(skill.version))
      .replace("{SKILL_NAME}", skill.name)
      .replace("{SKILL_CONTENT}", skillContent.slice(0, 4000))
      .replace("{TITLE}", task.title)
      .replace("{SUMMARY}", task.summary.slice(0, 3000));

    try {
      const raw = await this.callLLM(cfg, prompt);
      return this.parseJSON<UpgradeEvalResult>(raw, {
        shouldUpgrade: false, upgradeType: "refine", dimensions: [], reason: "parse failed", mergeStrategy: "", confidence: 0,
      });
    } catch (err) {
      this.ctx.log.warn(`SkillEvaluator.evaluateUpgrade failed: ${err}`);
      return { shouldUpgrade: false, upgradeType: "refine", dimensions: [], reason: `error: ${err}`, mergeStrategy: "", confidence: 0 };
    }
  }

  private getProviderConfig(): SummarizerConfig | undefined {
    return this.ctx.config.summarizer;
  }

  private async callLLM(cfg: SummarizerConfig, userContent: string): Promise<string> {
    const endpoint = this.normalizeEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
    const model = cfg.model ?? "gpt-4o-mini";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
      ...cfg.headers,
    };

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: cfg.temperature ?? 0.1,
        max_tokens: 1024,
        messages: [
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`LLM call failed (${resp.status}): ${body}`);
    }

    const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    return json.choices[0]?.message?.content?.trim() ?? "";
  }

  private parseJSON<T>(raw: string, fallback: T): T {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;
    try {
      return JSON.parse(jsonMatch[0]) as T;
    } catch {
      return fallback;
    }
  }

  private normalizeEndpoint(url: string): string {
    const stripped = url.replace(/\/+$/, "");
    if (stripped.endsWith("/chat/completions")) return stripped;
    if (stripped.endsWith("/completions")) return stripped;
    return `${stripped}/chat/completions`;
  }
}
