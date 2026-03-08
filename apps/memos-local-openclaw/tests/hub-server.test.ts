import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SqliteStore } from "../src/storage/sqlite";
import { HubServer } from "../src/hub/server";

const noopLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const servers: HubServer[] = [];
const stores: SqliteStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hub server", () => {
  it("should preserve bootstrap admin token across restart", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-auth-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "test.db");

    const store1 = new SqliteStore(dbPath, noopLog);
    stores.push(store1);
    const server1 = new HubServer({
      store: store1,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18912, teamName: "Persist", teamToken: "persist-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server1);
    await server1.start();

    const authPath = path.join(dir, "hub-auth.json");
    const firstState = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const firstToken = firstState.bootstrapAdminToken;
    expect(firstToken).toBeTruthy();

    const firstMe = await fetch("http://127.0.0.1:18912/api/v1/hub/me", {
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(firstMe.status).toBe(200);

    await server1.stop();
    servers.pop();
    store1.close();
    stores.pop();

    const store2 = new SqliteStore(dbPath, noopLog);
    stores.push(store2);
    const server2 = new HubServer({
      store: store2,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18912, teamName: "Persist", teamToken: "persist-secret" } } },
      dataDir: dir,
    } as any);
    servers.push(server2);
    await server2.start();

    const secondMe = await fetch("http://127.0.0.1:18912/api/v1/hub/me", {
      headers: { authorization: `Bearer ${firstToken}` },
    });
    expect(secondMe.status).toBe(200);
  });

  it("should recover bootstrap metadata for legacy hubs with an existing admin", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-legacy-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "test.db");
    const authPath = path.join(dir, "hub-auth.json");

    const store = new SqliteStore(dbPath, noopLog);
    stores.push(store);
    store.upsertHubUser({
      id: "legacy-admin",
      username: "legacy",
      deviceName: "hub",
      role: "admin",
      status: "active",
      groups: [],
      tokenHash: "",
      createdAt: 1,
      approvedAt: 1,
    });
    fs.writeFileSync(authPath, JSON.stringify({ authSecret: "legacy-secret" }, null, 2), "utf8");

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18913, teamName: "Legacy", teamToken: "legacy-team-token" } } },
      dataDir: dir,
    } as any);
    servers.push(server);
    await server.start();

    const state = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(state.bootstrapAdminUserId).toBe("legacy-admin");
    expect(state.bootstrapAdminToken).toBeTruthy();

    const me = await fetch("http://127.0.0.1:18913/api/v1/hub/me", {
      headers: { authorization: `Bearer ${state.bootstrapAdminToken}` },
    });
    expect(me.status).toBe(200);
  });

  it("should refuse to start hub mode without a team token", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-no-token-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.db"), noopLog);
    stores.push(store);

    const server = new HubServer({
      store,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18914, teamName: "NoToken", teamToken: "" } } },
      dataDir: dir,
    } as any);
    servers.push(server);

    await expect(server.start()).rejects.toThrow(/team token/i);
  });

  it("should fail cleanly on port conflict", async () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-1-"));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "memos-hub-2-"));
    dirs.push(dir1, dir2);

    const store1 = new SqliteStore(path.join(dir1, "test.db"), noopLog);
    const store2 = new SqliteStore(path.join(dir2, "test.db"), noopLog);
    stores.push(store1, store2);

    const server1 = new HubServer({
      store: store1,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18911, teamName: "A", teamToken: "secret-a" } } },
      dataDir: dir1,
    } as any);
    const server2 = new HubServer({
      store: store2,
      log: noopLog,
      config: { sharing: { enabled: true, role: "hub", hub: { port: 18911, teamName: "B", teamToken: "secret-b" } } },
      dataDir: dir2,
    } as any);
    servers.push(server1, server2);

    await server1.start();
    await expect(server2.start()).rejects.toThrow();
  });
});
