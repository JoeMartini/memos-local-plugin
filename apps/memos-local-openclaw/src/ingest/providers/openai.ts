import type { SummarizerConfig, Logger } from "../../types";

const SYSTEM_PROMPT = `Summarize the text in ONE concise sentence (max 120 characters). IMPORTANT: Use the SAME language as the input text — if the input is Chinese, write Chinese; if English, write English. Preserve exact names, commands, error codes. No bullet points, no preamble — output only the sentence.`;

const TASK_SUMMARY_PROMPT = `You create a DETAILED task summary from a multi-turn conversation. This summary will be the ONLY record of this conversation, so it must preserve ALL important information.

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

export async function summarizeTaskOpenAI(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
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
      max_tokens: 4096,
      messages: [
        { role: "system", content: TASK_SUMMARY_PROMPT },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI task-summarize failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  return json.choices[0]?.message?.content?.trim() ?? "";
}

export async function summarizeOpenAI(
  text: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<string> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
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
      temperature: cfg.temperature ?? 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI summarize failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return json.choices[0]?.message?.content?.trim() ?? "";
}

const TOPIC_JUDGE_PROMPT = `You are a conversation topic boundary detector. Given a summary of the CURRENT conversation and a NEW user message, determine if the new message starts a DIFFERENT topic/task.

Answer ONLY "NEW" or "SAME".

Rules:
- "NEW" = the new message is about a completely different subject, project, or task
- "SAME" = the new message continues, follows up on, or is closely related to the current topic
- Follow-up questions, clarifications, refinements, bug fixes, or next steps on the same task = SAME
- Greetings or meta-questions like "你好" or "谢谢" without new substance = SAME
- A clearly unrelated request (e.g., current topic is deployment, new message asks about cooking) = NEW

Output exactly one word: NEW or SAME`;

export async function judgeNewTopicOpenAI(
  currentContext: string,
  newMessage: string,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<boolean> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const userContent = `CURRENT CONVERSATION SUMMARY:\n${currentContext}\n\nNEW USER MESSAGE:\n${newMessage}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 10,
      messages: [
        { role: "system", content: TOPIC_JUDGE_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI topic-judge failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const answer = json.choices[0]?.message?.content?.trim().toUpperCase() ?? "";
  log.debug(`Topic judge result: "${answer}"`);
  return answer.startsWith("NEW");
}

const FILTER_RELEVANT_PROMPT = `You are a memory relevance judge. Given a user's QUERY and a list of CANDIDATE memory summaries, do two things:

1. Select ALL candidates that could be useful for answering the query. When in doubt, INCLUDE the candidate.
   - For questions about lists, history, or "what/where/who" across multiple items (e.g. "which companies did I work at"), include ALL matching items — do NOT stop at the first match.
   - For factual lookups (e.g. "what is the SSH port"), a single direct answer is enough.
2. Judge whether the selected memories are SUFFICIENT to fully answer the query WITHOUT fetching additional context.

IMPORTANT for "sufficient" judgment:
- sufficient=true ONLY when the memories contain a concrete ANSWER, fact, decision, or actionable information that directly addresses the query.
- sufficient=false when:
  - The memories only repeat the same question the user asked before (echo, not answer).
  - The memories show related topics but lack the specific detail needed.
  - The memories contain partial information that would benefit from full task context, timeline, or related skills.

Output a JSON object with exactly two fields:
{"relevant":[1,3,5],"sufficient":true}

- "relevant": array of candidate numbers that are useful. Empty array [] if none are relevant.
- "sufficient": true ONLY if the memories contain a direct answer; false otherwise.

Output ONLY the JSON object, nothing else.`;

export interface FilterResult {
  relevant: number[];
  sufficient: boolean;
}

export async function filterRelevantOpenAI(
  query: string,
  candidates: Array<{ index: number; summary: string; role: string }>,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<FilterResult> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const candidateText = candidates
    .map((c) => `${c.index}. [${c.role}] ${c.summary}`)
    .join("\n");

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: "system", content: FILTER_RELEVANT_PROMPT },
        { role: "user", content: `QUERY: ${query}\n\nCANDIDATES:\n${candidateText}` },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI filter-relevant failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "{}";
  return parseFilterResult(raw, log);
}

function parseFilterResult(raw: string, log: Logger): FilterResult {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      if (obj && Array.isArray(obj.relevant)) {
        return {
          relevant: obj.relevant.filter((n: any) => typeof n === "number"),
          sufficient: obj.sufficient === true,
        };
      }
    }
  } catch {}
  log.warn(`filterRelevant: failed to parse LLM output: "${raw}", fallback to all+insufficient`);
  return { relevant: [], sufficient: false };
}

// ─── Smart Dedup: judge whether new memory is DUPLICATE / UPDATE / NEW ───

export const DEDUP_JUDGE_PROMPT = `You are a memory deduplication system. Given a NEW memory summary and several EXISTING memory summaries, determine the relationship.

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

export interface DedupResult {
  action: "DUPLICATE" | "UPDATE" | "NEW";
  targetIndex?: number;
  reason: string;
  mergedSummary?: string;
}

export async function judgeDedupOpenAI(
  newSummary: string,
  candidates: Array<{ index: number; summary: string; chunkId: string }>,
  cfg: SummarizerConfig,
  log: Logger,
): Promise<DedupResult> {
  const endpoint = normalizeChatEndpoint(cfg.endpoint ?? "https://api.openai.com/v1/chat/completions");
  const model = cfg.model ?? "gpt-4o-mini";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.headers,
  };

  const candidateText = candidates
    .map((c) => `${c.index}. ${c.summary}`)
    .join("\n");

  const resp = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: DEDUP_JUDGE_PROMPT },
        { role: "user", content: `NEW MEMORY:\n${newSummary}\n\nEXISTING MEMORIES:\n${candidateText}` },
      ],
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI dedup-judge failed (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const raw = json.choices[0]?.message?.content?.trim() ?? "{}";
  return parseDedupResult(raw, log);
}

export function parseDedupResult(raw: string, log: Logger): DedupResult {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]);
      if (obj && typeof obj.action === "string") {
        return {
          action: obj.action as DedupResult["action"],
          targetIndex: typeof obj.targetIndex === "number" ? obj.targetIndex : undefined,
          reason: obj.reason || "",
          mergedSummary: obj.mergedSummary || undefined,
        };
      }
    }
  } catch {}
  log.warn(`judgeDedup: failed to parse LLM output: "${raw}", fallback to NEW`);
  return { action: "NEW", reason: "parse_failed" };
}

function normalizeChatEndpoint(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (stripped.endsWith("/chat/completions")) return stripped;
  if (stripped.endsWith("/completions")) return stripped;
  return `${stripped}/chat/completions`;
}
