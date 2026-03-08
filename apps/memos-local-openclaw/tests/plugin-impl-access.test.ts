import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import plugin from "../plugin-impl";
import { SqliteStore } from "../src/storage/sqlite";
import { issueUserToken } from "../src/hub/auth";

function makeApi(stateDir: string, pluginConfig: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  const events = new Map<string, Function>();
  let service: any;

  const api = {
    pluginConfig,
    resolvePath(input: string) {
      return input === "~/.openclaw" ? stateDir : input;
    },
    logger: {
      info: () => {},
      warn: () => {},
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerService(def: any) {
      service = def;
    },
    on(eventName: string, handler: Function) {
      events.set(eventName, handler);
    },
  } as any;

  plugin.register(api);

  return { tools, events, service };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for condition");
}

describe("plugin-impl hub service skeleton", () => {
  let tmpDir: string;
  let service: any;
  let port: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-plugin-impl-hub-"));
    port = 18901 + Math.floor(Math.random() * 2000);
    ({ service } = makeApi(tmpDir, {
      sharing: {
        enabled: true,
        role: "hub",
        hub: {
          port,
          teamName: "Core Team",
          teamToken: "team-secret",
        },
      },
    }));
  });

  afterEach(async () => {
    await service?.stop?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should start hub service and expose info/join skeleton routes", async () => {
    await service.start();

    const dbPath = path.join(tmpDir, "memos-local", "memos.db");
    const store = new SqliteStore(dbPath, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
    const admins = store.listHubUsers().filter((user) => user.role === "admin" && user.status === "active");
    expect(admins.length).toBeGreaterThanOrEqual(1);
    store.close();

    const info = await fetch(`http://127.0.0.1:${port}/api/v1/hub/info`);
    expect(info.status).toBe(200);
    const infoJson = await info.json();
    expect(infoJson.teamName).toBe("Core Team");
    expect(infoJson.apiVersion).toBe("v1");

    const me = await fetch(`http://127.0.0.1:${port}/api/v1/hub/me`);
    expect(me.status).toBe(401);

    const join = await fetch(`http://127.0.0.1:${port}/api/v1/hub/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "bob",
        deviceName: "Bob Mac",
        teamToken: "team-secret",
      }),
    });
    expect(join.status).toBe(202);
    const joinJson = await join.json();
    expect(joinJson.status).toBe("pending");
    expect(joinJson.userId).toBeTruthy();
  });

  it("should reject forged admin tokens derived from the team token", async () => {
    await service.start();

    const forged = issueUserToken(
      {
        userId: "forged-admin",
        username: "mallory",
        role: "admin",
        status: "active",
      },
      "team-secret",
      60_000,
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/v1/hub/admin/pending-users`, {
      headers: {
        authorization: `Bearer ${forged}`,
      },
    });

    expect([401, 403]).toContain(res.status);
  });
});

describe("plugin-impl owner isolation", () => {
  let tmpDir: string;
  let tools: Map<string, any>;
  let events: Map<string, Function>;
  let service: any;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-plugin-impl-access-"));
    ({ tools, events, service } = makeApi(tmpDir));

    const agentEnd = events.get("agent_end")!;

    await agentEnd({
      success: true,
      agentId: "alpha",
      sessionKey: "alpha-session",
      messages: [
        { role: "user", content: "alpha private marker deployment guide" },
        { role: "assistant", content: "alpha private marker response" },
      ],
    });

    await agentEnd({
      success: true,
      agentId: "beta",
      sessionKey: "beta-session",
      messages: [
        { role: "user", content: "beta private marker rollback guide" },
        { role: "assistant", content: "beta private marker response" },
      ],
    });

    const publicWrite = tools.get("memory_write_public");
    await publicWrite.execute("call-public", { content: "shared public marker convention" }, { agentId: "alpha" });

    const search = tools.get("memory_search");
    await waitFor(async () => {
      const result = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
      return (result?.details?.hits?.length ?? 0) > 0;
    });
  });

  afterEach(() => {
    service?.stop?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("memory_search should scope results by agentId", async () => {
    const search = tools.get("memory_search");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const beta = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "beta" });
    const publicHit = await search.execute("call-search", { query: "shared public marker", maxResults: 5, minScore: 0.1 }, { agentId: "beta" });

    expect(alpha.details.hits.length).toBeGreaterThan(0);
    expect(beta.details?.hits ?? []).toEqual([]);
    expect(publicHit.details.hits.length).toBeGreaterThan(0);
  });

  it("memory_timeline should not leak another agent's private neighbors", async () => {
    const search = tools.get("memory_search");
    const timeline = tools.get("memory_timeline");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const ref = alpha.details.hits[0].ref;
    const betaTimeline = await timeline.execute("call-timeline", ref, { agentId: "beta" });

    expect(betaTimeline.details.entries).toEqual([]);
  });

  it("memory_get should not return another agent's private chunk", async () => {
    const search = tools.get("memory_search");
    const getTool = tools.get("memory_get");

    const alpha = await search.execute("call-search", { query: "alpha private marker", maxResults: 5, minScore: 0.1 }, { agentId: "alpha" });
    const ref = alpha.details.hits[0].ref;
    const betaGet = await getTool.execute("call-get", { chunkId: ref.chunkId }, { agentId: "beta" });

    expect(betaGet.details.error).toBe("not_found");
  });
});
