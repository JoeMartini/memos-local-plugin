import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { ViewerServer } from "../src/viewer/server";
import { HubServer } from "../src/hub/server";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let tmpDirs: string[] = [];
let stores: SqliteStore[] = [];
let viewer: ViewerServer | null = null;
let hub: HubServer | null = null;

async function viewerAuthCookie(baseUrl: string) {
  const res = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "passw0rd" }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

afterEach(async () => {
  viewer?.stop();
  viewer = null;
  await hub?.stop();
  hub = null;
  for (const store of stores.splice(0)) store.close();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("viewer sharing endpoints", () => {
  it("serves sharing status and admin pending users", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-sharing-hub-"));
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-sharing-viewer-"));
    tmpDirs.push(hubDir, viewerDir);

    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog);
    const viewerStore = new SqliteStore(path.join(viewerDir, "viewer.db"), noopLog);
    stores.push(hubStore, viewerStore);

    hub = new HubServer({
      store: hubStore,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 19831, teamName: "Viewer Team", teamToken: "viewer-secret" } } } as any,
      dataDir: hubDir,
    } as any);
    await hub.start();

    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const adminToken = authState.bootstrapAdminToken as string;

    const join = await fetch("http://127.0.0.1:19831/api/v1/hub/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", deviceName: "Bob Mac", teamToken: "viewer-secret" }),
    });
    const pending = await join.json();

    viewer = new ViewerServer({
      store: viewerStore,
      embedder: { provider: "local", embedQuery: async () => { throw new Error("skip vec"); } } as any,
      port: 19832,
      log: noopLog,
      dataDir: viewerDir,
      ctx: {
        stateDir: viewerDir,
        workspaceDir: viewerDir,
        config: {
          sharing: { enabled: true, role: "client", client: { hubAddress: "127.0.0.1:19831", userToken: adminToken } },
        } as any,
        log: noopLog,
      },
    });
    const viewerUrl = await viewer.start();
    const cookie = await viewerAuthCookie(viewerUrl);

    const statusRes = await fetch(`${viewerUrl}/api/sharing/status`, { headers: { cookie } });
    const statusJson = await statusRes.json();
    expect(statusJson.enabled).toBe(true);
    expect(statusJson.connection.connected).toBe(true);
    expect(statusJson.connection.user.role).toBe("admin");
    expect(statusJson.admin.canManageUsers).toBe(true);
    expect(statusJson.admin.rejectSupported).toBe(true);

    const pendingRes = await fetch(`${viewerUrl}/api/sharing/pending-users`, { headers: { cookie } });
    const pendingJson = await pendingRes.json();
    expect(pendingJson.users.length).toBeGreaterThan(0);
    expect(pendingJson.users[0].id).toBe(pending.userId);

    const approveRes = await fetch(`${viewerUrl}/api/sharing/approve-user`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: pending.userId, username: "bob" }),
    });
    const approveJson = await approveRes.json();
    expect(approveJson.ok).toBe(true);

    const joinReject = await fetch("http://127.0.0.1:19831/api/v1/hub/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "eve", deviceName: "Eve Mac", teamToken: "viewer-secret" }),
    });
    const rejectPending = await joinReject.json();
    const rejectRes = await fetch(`${viewerUrl}/api/sharing/reject-user`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ userId: rejectPending.userId, username: "eve" }),
    });
    const rejectJson = await rejectRes.json();
    expect(rejectJson.ok).toBe(true);
  });

  it("serves split sharing memory and skill search payloads", async () => {
    const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-search-hub-"));
    const viewerDir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-viewer-search-viewer-"));
    tmpDirs.push(hubDir, viewerDir);

    const hubStore = new SqliteStore(path.join(hubDir, "hub.db"), noopLog);
    const viewerStore = new SqliteStore(path.join(viewerDir, "viewer.db"), noopLog);
    stores.push(hubStore, viewerStore);

    hub = new HubServer({
      store: hubStore,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 19833, teamName: "Viewer Search", teamToken: "viewer-search-secret" } } } as any,
      dataDir: hubDir,
    } as any);
    await hub.start();

    const authState = JSON.parse(fs.readFileSync(path.join(hubDir, "hub-auth.json"), "utf8"));
    const adminToken = authState.bootstrapAdminToken as string;
    const adminUserId = authState.bootstrapAdminUserId as string;

    hubStore.upsertHubTask({ id: "hub-task-1", sourceTaskId: "task-1", sourceUserId: adminUserId, title: "Hub rollout", summary: "Hub rollout", groupId: null, visibility: "public", createdAt: 1, updatedAt: 1 });
    hubStore.upsertHubChunk({ id: "hub-chunk-1", hubTaskId: "hub-task-1", sourceTaskId: "task-1", sourceChunkId: "chunk-1", sourceUserId: adminUserId, role: "assistant", content: "Hub rollout checklist with nginx canary.", summary: "Hub rollout checklist", kind: "paragraph", createdAt: 2 });
    hubStore.upsertHubSkill({ id: "hub-skill-1", sourceSkillId: "skill-1", sourceUserId: adminUserId, name: "nginx-rollout", description: "Rollout nginx safely", version: 1, groupId: null, visibility: "public", bundle: JSON.stringify({ skill_md: "# Nginx Rollout", scripts: [], references: [], evals: [] }), qualityScore: 0.9, createdAt: 1, updatedAt: 1 });

    viewerStore.insertTask({ id: "local-task-1", sessionKey: "local-session", title: "Local rollout", summary: "Local rollout", status: "completed", owner: "agent:main", startedAt: 1, endedAt: 2, updatedAt: 2 });
    viewerStore.insertChunk({ id: "local-chunk-1", sessionKey: "local-session", turnId: "turn-1", seq: 0, role: "assistant", content: "Local rollout checklist with smoke test.", kind: "paragraph", summary: "Local rollout checklist", embedding: null, taskId: "local-task-1", skillId: null, owner: "agent:main", dedupStatus: "active", dedupTarget: null, dedupReason: null, mergeCount: 0, lastHitAt: null, mergeHistory: "[]", createdAt: 3, updatedAt: 3 });
    viewerStore.insertSkill({ id: "local-skill-1", name: "local-rollout", description: "Local rollout helper", version: 1, status: "active", tags: "[]", sourceType: "manual", dirPath: viewerDir, installed: 0, owner: "agent:main", visibility: "private", qualityScore: 0.8, createdAt: 1, updatedAt: 1 });

    viewer = new ViewerServer({
      store: viewerStore,
      embedder: { provider: "local", embedQuery: async () => { throw new Error("skip vec"); } } as any,
      port: 19834,
      log: noopLog,
      dataDir: viewerDir,
      ctx: {
        stateDir: viewerDir,
        workspaceDir: viewerDir,
        config: {
          sharing: { enabled: true, role: "client", client: { hubAddress: "127.0.0.1:19833", userToken: adminToken } },
        } as any,
        log: noopLog,
      },
    });
    const viewerUrl = await viewer.start();
    const cookie = await viewerAuthCookie(viewerUrl);

    const memRes = await fetch(`${viewerUrl}/api/sharing/search/memories`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ query: "rollout checklist", scope: "all", maxResults: 5 }),
    });
    const memJson = await memRes.json();
    expect(memJson.local.hits.length).toBeGreaterThan(0);
    expect(memJson.hub.hits.length).toBeGreaterThan(0);

    const skillRes = await fetch(`${viewerUrl}/api/sharing/search/skills?query=rollout&scope=all`, { headers: { cookie } });
    const skillJson = await skillRes.json();
    expect(skillJson.local.hits.length).toBeGreaterThan(0);
    expect(skillJson.hub.hits.length).toBeGreaterThan(0);

    const shareTaskRes = await fetch(`${viewerUrl}/api/sharing/tasks/share`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "local-task-1", visibility: "public" }),
    });
    const shareTaskJson = await shareTaskRes.json();
    expect(shareTaskJson.ok).toBe(true);
    expect(hubStore.getHubTaskBySource(adminUserId, "local-task-1")).not.toBeNull();
    expect(viewerStore.getHubTaskBySource(adminUserId, "local-task-1")?.visibility).toBe("public");

    const taskDetailRes = await fetch(`${viewerUrl}/api/task/local-task-1`, { headers: { cookie } });
    const taskDetailJson = await taskDetailRes.json();
    expect(taskDetailJson.sharingVisibility).toBe("public");

    const pullRes = await fetch(`${viewerUrl}/api/sharing/skills/pull`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ skillId: skillJson.hub.hits[0].skillId }),
    });
    const pullJson = await pullRes.json();
    expect(pullJson.ok).toBe(true);
    expect(viewerStore.getSkill(pullJson.localSkillId)).not.toBeNull();

    const unshareTaskRes = await fetch(`${viewerUrl}/api/sharing/tasks/unshare`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ taskId: "local-task-1" }),
    });
    const unshareTaskJson = await unshareTaskRes.json();
    expect(unshareTaskJson.ok).toBe(true);
    expect(hubStore.getHubTaskBySource(adminUserId, "local-task-1")).toBeNull();
    expect(viewerStore.getHubTaskBySource(adminUserId, "local-task-1")).toBeNull();
  });
});
