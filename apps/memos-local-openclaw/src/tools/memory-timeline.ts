import type { SqliteStore } from "../storage/sqlite";
import type { ToolDefinition, TimelineResult, TimelineEntry, ChunkRef } from "../types";
import { DEFAULTS } from "../types";

export function createMemoryTimelineTool(store: SqliteStore): ToolDefinition {
  return {
    name: "memory_timeline",
    description:
      "Retrieve neighboring context around a memory reference. Use after memory_search to expand context " +
      "around a specific hit. Provides adjacent conversation chunks marked as before/current/after.",
    inputSchema: {
      type: "object",
      properties: {
        ref: {
          type: "object",
          description: "Reference object from a memory_search hit (must contain sessionKey, chunkId, turnId, seq).",
          properties: {
            sessionKey: { type: "string" },
            chunkId: { type: "string" },
            turnId: { type: "string" },
            seq: { type: "number" },
          },
          required: ["sessionKey", "chunkId", "turnId", "seq"],
        },
        window: {
          type: "number",
          description: "Number of turns/chunks to include before and after (default ±2).",
        },
      },
      required: ["ref"],
    },
    handler: async (input) => {
      const ref = input.ref as ChunkRef;
      const window = (input.window as number) ?? DEFAULTS.timelineWindowDefault;

      const neighbors = store.getNeighborChunks(
        ref.sessionKey,
        ref.turnId,
        ref.seq,
        window,
      );

      const entries: TimelineEntry[] = neighbors.map((chunk) => {
        let relation: TimelineEntry["relation"] = "before";
        if (chunk.id === ref.chunkId) {
          relation = "current";
        } else if (chunk.createdAt > (store.getChunk(ref.chunkId)?.createdAt ?? 0)) {
          relation = "after";
        }

        return {
          excerpt: chunk.content.slice(0, DEFAULTS.excerptMaxChars),
          ref: {
            sessionKey: chunk.sessionKey,
            chunkId: chunk.id,
            turnId: chunk.turnId,
            seq: chunk.seq,
          },
          role: chunk.role,
          ts: chunk.createdAt,
          relation,
        };
      });

      const result: TimelineResult = {
        entries,
        anchorRef: ref,
      };

      return result;
    },
  };
}
