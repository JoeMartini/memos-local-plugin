import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";
import type { SqliteStore } from "../storage/sqlite";
import type { Embedder } from "../embedding";
import type { Logger, MemosLocalConfig } from "../types";
import { issueUserToken, verifyUserToken } from "./auth";
import { HubUserManager } from "./user-manager";

type HubServerOptions = {
  store: SqliteStore;
  log: Logger;
  config: MemosLocalConfig;
  dataDir: string;
  embedder?: Embedder;
};

type HubAuthState = {
  authSecret: string;
  bootstrapAdminUserId?: string;
  bootstrapAdminToken?: string;
};

export class HubServer {
  private server?: http.Server;
  private remoteHitMap = new Map<string, { chunkId: string; expiresAt: number; requesterUserId: string }>();
  private readonly userManager: HubUserManager;
  private readonly authStatePath: string;
  private authState: HubAuthState;

  private static readonly RATE_WINDOW_MS = 60_000;
  private static readonly RATE_LIMIT_DEFAULT = 60;
  private static readonly RATE_LIMIT_SEARCH = 30;
  private rateBuckets = new Map<string, { count: number; windowStart: number }>();

  constructor(private opts: HubServerOptions) {
    this.userManager = new HubUserManager(opts.store, opts.log);
    this.authStatePath = path.join(opts.dataDir, "hub-auth.json");
    this.authState = this.loadAuthState();
  }

  private checkRateLimit(userId: string, endpoint: string): boolean {
    const key = `${userId}:${endpoint}`;
    const now = Date.now();
    const limit = endpoint === "search" ? HubServer.RATE_LIMIT_SEARCH : HubServer.RATE_LIMIT_DEFAULT;
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart > HubServer.RATE_WINDOW_MS) {
      this.rateBuckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    bucket.count++;
    return bucket.count <= limit;
  }

  async start(): Promise<string> {
    if (!this.teamToken) {
      throw new Error("team token is required to start hub mode");
    }
    if (this.server?.listening) {
      return `http://127.0.0.1:${this.port}`;
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (err: any) {
        const code = err?.statusCode ?? 500;
        const message = code === 413 ? "request_body_too_large" : "internal_error";
        this.opts.log.warn(`hub server error: ${String(err)}`);
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: message }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(this.port, "0.0.0.0");
    });

    const bootstrap = this.userManager.ensureBootstrapAdmin(
      this.authSecret,
      "admin",
      this.authState.bootstrapAdminUserId,
      this.authState.bootstrapAdminToken,
    );
    if (bootstrap.token) {
      this.authState.bootstrapAdminUserId = bootstrap.user.id;
      this.authState.bootstrapAdminToken = bootstrap.token;
      this.saveAuthState();
      this.opts.log.info(`memos-local: bootstrap admin token persisted to ${this.authStatePath}`);
    }

    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private get port(): number {
    return this.opts.config.sharing?.hub?.port ?? 18800;
  }

  private get teamName(): string {
    return this.opts.config.sharing?.hub?.teamName ?? "";
  }

  private get teamToken(): string {
    return this.opts.config.sharing?.hub?.teamToken ?? "";
  }

  private get authSecret(): string {
    return this.authState.authSecret;
  }

  private loadAuthState(): HubAuthState {
    try {
      const raw = fs.readFileSync(this.authStatePath, "utf8");
      const parsed = JSON.parse(raw) as HubAuthState;
      if (parsed.authSecret) return parsed;
    } catch {}
    const initial = { authSecret: randomBytes(32).toString("hex") } as HubAuthState;
    fs.mkdirSync(path.dirname(this.authStatePath), { recursive: true });
    fs.writeFileSync(this.authStatePath, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  private saveAuthState(): void {
    fs.mkdirSync(path.dirname(this.authStatePath), { recursive: true });
    fs.writeFileSync(this.authStatePath, JSON.stringify(this.authState, null, 2), "utf8");
  }

  private embedChunksAsync(chunkIds: string[], chunks: Array<{ id: string; summary?: string; content?: string }>): void {
    const embedder = this.opts.embedder;
    if (!embedder) return;
    const texts = chunks.map(c => c.summary || (c.content ? c.content.slice(0, 500) : ""));
    embedder.embed(texts).then((vectors) => {
      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i]) {
          this.opts.store.upsertHubEmbedding(chunkIds[i], new Float32Array(vectors[i]));
        }
      }
      this.opts.log.info(`hub: embedded ${vectors.filter(Boolean).length}/${chunkIds.length} shared chunks`);
    }).catch((err) => {
      this.opts.log.warn(`hub: embedding shared chunks failed: ${err}`);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const routePath = url.pathname;

    if (req.method === "GET" && routePath === "/api/v1/hub/info") {
      return this.json(res, 200, {
        teamName: this.teamName,
        version: "0.0.0",
        apiVersion: "v1",
      });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/join") {
      const body = await this.readJson(req);
      if (!body || body.teamToken !== this.teamToken) {
        return this.json(res, 403, { error: "invalid_team_token" });
      }
      const pending = this.userManager.createPendingUser({
        username: String(body.username || `user-${randomUUID().slice(0, 8)}`),
        deviceName: typeof body.deviceName === "string" ? body.deviceName : undefined,
      });
      return this.json(res, 202, { status: "pending", userId: pending.id });
    }

    // All endpoints below require authentication + rate limiting
    const auth = this.authenticate(req);
    if (!auth) return this.json(res, 401, { error: "unauthorized" });

    const endpointKey = routePath.replace(/^\/api\/v1\/hub\//, "").replace(/\/[^/]+\/bundle$/, "/bundle");
    if (!this.checkRateLimit(auth.userId, endpointKey)) {
      return this.json(res, 429, { error: "rate_limit_exceeded", retryAfterMs: HubServer.RATE_WINDOW_MS });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/me") {
      const user = this.opts.store.getHubUser(auth.userId);
      if (!user) return this.json(res, 401, { error: "unauthorized" });
      return this.json(res, 200, user);
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/pending-users") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      return this.json(res, 200, { users: this.userManager.listPendingUsers() });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/approve-user") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const token = issueUserToken({ userId: String(body.userId), username: String(body.username || ""), role: "member", status: "active" }, this.authSecret);
      const approved = this.userManager.approveUser(String(body.userId), token);
      if (!approved) return this.json(res, 404, { error: "not_found" });
      return this.json(res, 200, { status: "active", token });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/admin/reject-user") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const rejected = this.userManager.rejectUser(String(body.userId));
      if (!rejected) return this.json(res, 404, { error: "not_found" });
      return this.json(res, 200, { status: "rejected" });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/admin/users") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const users = this.opts.store.listHubUsers().filter(u => u.status === "active");
      return this.json(res, 200, { users: users.map(u => ({ id: u.id, username: u.username, role: u.role, status: u.status })) });
    }

    // ── Group management ──

    if (req.method === "GET" && routePath === "/api/v1/hub/groups") {
      const groups = this.opts.store.listHubGroups();
      return this.json(res, 200, { groups });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/groups") {
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const name = String(body.name || "").trim();
      if (!name) return this.json(res, 400, { error: "name_required" });
      const groupId = randomUUID();
      this.opts.store.upsertHubGroup({
        id: groupId,
        name,
        description: String(body.description || ""),
        createdAt: Date.now(),
      });
      return this.json(res, 201, { id: groupId, name });
    }

    const groupDetailMatch = routePath.match(/^\/api\/v1\/hub\/groups\/([^/]+)$/);
    if (groupDetailMatch) {
      const groupId = decodeURIComponent(groupDetailMatch[1]);

      if (req.method === "GET") {
        const group = this.opts.store.getHubGroupById(groupId);
        if (!group) return this.json(res, 404, { error: "not_found" });
        const members = this.opts.store.listHubGroupMembers(groupId);
        return this.json(res, 200, { ...group, members });
      }

      if (req.method === "PUT") {
        if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
        const existing = this.opts.store.getHubGroupById(groupId);
        if (!existing) return this.json(res, 404, { error: "not_found" });
        const body = await this.readJson(req);
        this.opts.store.upsertHubGroup({
          id: groupId,
          name: String(body.name || existing.name).trim(),
          description: String(body.description ?? existing.description),
          createdAt: existing.createdAt,
        });
        return this.json(res, 200, { ok: true });
      }

      if (req.method === "DELETE") {
        if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
        const deleted = this.opts.store.deleteHubGroup(groupId);
        if (!deleted) return this.json(res, 404, { error: "not_found" });
        return this.json(res, 200, { ok: true });
      }
    }

    const groupMembersMatch = routePath.match(/^\/api\/v1\/hub\/groups\/([^/]+)\/members$/);
    if (groupMembersMatch) {
      const groupId = decodeURIComponent(groupMembersMatch[1]);

      if (req.method === "POST") {
        if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
        const group = this.opts.store.getHubGroupById(groupId);
        if (!group) return this.json(res, 404, { error: "group_not_found" });
        const body = await this.readJson(req);
        const userId = String(body.userId || "");
        if (!userId) return this.json(res, 400, { error: "userId_required" });
        const user = this.opts.store.getHubUser(userId);
        if (!user) return this.json(res, 404, { error: "user_not_found" });
        this.opts.store.addHubGroupMember(groupId, userId);
        return this.json(res, 200, { ok: true });
      }

      if (req.method === "DELETE") {
        if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
        const body = await this.readJson(req);
        const userId = String(body.userId || "");
        if (!userId) return this.json(res, 400, { error: "userId_required" });
        this.opts.store.removeHubGroupMember(groupId, userId);
        return this.json(res, 200, { ok: true });
      }
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/tasks/share") {
      const body = await this.readJson(req);
      if (!body?.task) return this.json(res, 400, { error: "invalid_payload" });
      const task = { ...body.task, sourceUserId: auth.userId };
      this.opts.store.upsertHubTask(task);
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];
      const chunkIds: string[] = [];
      for (const chunk of chunks) {
        this.opts.store.upsertHubChunk({ ...chunk, sourceUserId: auth.userId });
        chunkIds.push(chunk.id);
      }
      // Async embedding: don't block the response
      if (this.opts.embedder && chunkIds.length > 0) {
        this.embedChunksAsync(chunkIds, chunks);
      }
      return this.json(res, 200, { ok: true, chunks: chunkIds.length });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/tasks/unshare") {
      const body = await this.readJson(req);
      this.opts.store.deleteHubTaskBySource(auth.userId, String(body.sourceTaskId));
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/search") {
      const body = await this.readJson(req);
      const query = String(body.query || "");
      const maxResults = Number(body.maxResults || 10);
      const ftsHits = this.opts.store.searchHubChunks(query, { userId: auth.userId, maxResults: maxResults * 2 });

      // Attempt vector search and RRF merge if embedder is available
      let mergedIds: string[];
      if (this.opts.embedder) {
        try {
          const [queryVec] = await this.opts.embedder.embed([query]);
          if (queryVec) {
            const allEmb = this.opts.store.getVisibleHubEmbeddings(auth.userId);
            const scored = allEmb.map(e => {
              let dot = 0, nA = 0, nB = 0;
              for (let i = 0; i < queryVec.length && i < e.vector.length; i++) {
                dot += queryVec[i] * e.vector[i];
                nA += queryVec[i] * queryVec[i];
                nB += e.vector[i] * e.vector[i];
              }
              const sim = nA > 0 && nB > 0 ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0;
              return { chunkId: e.chunkId, score: sim };
            }).sort((a, b) => b.score - a.score).slice(0, maxResults * 2);

            const K = 60;
            const rrfScores = new Map<string, number>();
            ftsHits.forEach(({ hit }, idx) => {
              rrfScores.set(hit.id, (rrfScores.get(hit.id) ?? 0) + 1 / (K + idx + 1));
            });
            scored.forEach(({ chunkId }, idx) => {
              rrfScores.set(chunkId, (rrfScores.get(chunkId) ?? 0) + 1 / (K + idx + 1));
            });
            mergedIds = [...rrfScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxResults).map(([id]) => id);
          } else {
            mergedIds = ftsHits.slice(0, maxResults).map(({ hit }) => hit.id);
          }
        } catch {
          mergedIds = ftsHits.slice(0, maxResults).map(({ hit }) => hit.id);
        }
      } else {
        mergedIds = ftsHits.slice(0, maxResults).map(({ hit }) => hit.id);
      }

      const ftsMap = new Map(ftsHits.map(({ hit }) => [hit.id, hit]));
      const hits = mergedIds.map((id, rank) => {
        let hit = ftsMap.get(id);
        if (!hit) {
          const visibleHit = this.opts.store.getVisibleHubSearchHitByChunkId(id, auth.userId);
          if (!visibleHit) return null;
          hit = visibleHit as any;
        }
        const remoteHitId = randomUUID();
        this.remoteHitMap.set(remoteHitId, { chunkId: id, expiresAt: Date.now() + 10 * 60 * 1000, requesterUserId: auth.userId });
        return {
          remoteHitId,
          summary: hit!.summary,
          excerpt: hit!.content.slice(0, 240),
          hubRank: rank + 1,
          taskTitle: hit!.task_title,
          ownerName: hit!.owner_name || "unknown",
          groupName: hit!.group_name,
          visibility: hit!.visibility,
          source: { ts: hit!.created_at, role: hit!.role },
        };
      }).filter(Boolean);
      return this.json(res, 200, { hits, meta: { totalCandidates: hits.length, searchedGroups: [], includedPublic: true } });
    }

    if (req.method === "GET" && routePath === "/api/v1/hub/skills") {
      const hits = this.opts.store.searchHubSkills(String(url.searchParams.get("query") || ""), {
        userId: auth.userId,
        maxResults: Number(url.searchParams.get("maxResults") || 10),
      }).map(({ hit }) => ({
        skillId: hit.id,
        name: hit.name,
        description: hit.description,
        version: hit.version,
        visibility: hit.visibility,
        groupName: hit.group_name,
        ownerName: hit.owner_name || "unknown",
        qualityScore: hit.quality_score,
      }));
      return this.json(res, 200, { hits });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/skills/publish") {
      const body = await this.readJson(req);
      const metadata = body?.metadata ?? {};
      const sourceSkillId = String(metadata.id || "");
      if (!sourceSkillId) return this.json(res, 400, { error: "missing_skill_id" });
      const existing = this.opts.store.getHubSkillBySource(auth.userId, sourceSkillId);
      const skillId = existing?.id ?? randomUUID();
      const visibility = body?.visibility === "group" ? "group" : "public";
      this.opts.store.upsertHubSkill({
        id: skillId,
        sourceSkillId,
        sourceUserId: auth.userId,
        name: String(metadata.name || sourceSkillId),
        description: String(metadata.description || ""),
        version: Number(metadata.version || 1),
        groupId: visibility === "group" ? String(body?.groupId || "") || null : null,
        visibility,
        bundle: JSON.stringify(body?.bundle ?? {}),
        qualityScore: metadata.qualityScore == null ? null : Number(metadata.qualityScore),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      return this.json(res, 200, { ok: true, skillId, visibility });
    }

    const skillBundleMatch = req.method === "GET" ? routePath.match(/^\/api\/v1\/hub\/skills\/([^/]+)\/bundle$/) : null;
    if (skillBundleMatch) {
      const skill = this.opts.store.getHubSkillById(decodeURIComponent(skillBundleMatch[1]));
      if (!skill) return this.json(res, 404, { error: "not_found" });
      const user = this.opts.store.getHubUser(auth.userId);
      const groups = new Set((user?.groups ?? []).map((group) => group.id));
      const allowed = skill.visibility === "public" || (skill.groupId != null && groups.has(skill.groupId));
      if (!allowed) return this.json(res, 403, { error: "forbidden" });
      return this.json(res, 200, {
        skillId: skill.id,
        metadata: {
          id: skill.sourceSkillId,
          name: skill.name,
          description: skill.description,
          version: skill.version,
          qualityScore: skill.qualityScore,
        },
        bundle: JSON.parse(skill.bundle),
      });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/skills/unpublish") {
      const body = await this.readJson(req);
      this.opts.store.deleteHubSkillBySource(auth.userId, String(body?.sourceSkillId || ""));
      return this.json(res, 200, { ok: true });
    }

    if (req.method === "POST" && routePath === "/api/v1/hub/memory-detail") {
      const body = await this.readJson(req);
      const hit = this.remoteHitMap.get(String(body.remoteHitId));
      if (!hit || hit.expiresAt < Date.now()) return this.json(res, 404, { error: "not_found" });
      if (hit.requesterUserId !== auth.userId) return this.json(res, 403, { error: "forbidden" });
      const chunk = this.opts.store.getHubChunkById(hit.chunkId);
      if (!chunk) return this.json(res, 404, { error: "not_found" });
      return this.json(res, 200, {
        content: chunk.content,
        summary: chunk.summary,
        source: { ts: chunk.createdAt, role: chunk.role },
      });
    }

    return this.json(res, 404, { error: "not_found" });
  }

  private authenticate(req: http.IncomingMessage) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const payload = verifyUserToken(token, this.authSecret);
    if (!payload) return null;
    const user = this.opts.store.getHubUser(payload.userId);
    if (!user || user.status !== "active") return null;
    const hash = createHash("sha256").update(token).digest("hex");
    if (user.tokenHash !== hash) return null;
    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
    };
  }

  private static readonly MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > HubServer.MAX_BODY_BYTES) {
        req.destroy();
        throw Object.assign(new Error("request body too large"), { statusCode: 413 });
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }

  private json(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
}
