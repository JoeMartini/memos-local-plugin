import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { createHash, randomBytes, randomUUID } from "crypto";
import type { SqliteStore } from "../storage/sqlite";
import type { Logger, MemosLocalConfig } from "../types";
import { issueUserToken, verifyUserToken } from "./auth";
import { HubUserManager } from "./user-manager";

type HubServerOptions = {
  store: SqliteStore;
  log: Logger;
  config: MemosLocalConfig;
  dataDir: string;
};

type HubAuthState = {
  authSecret: string;
  bootstrapAdminUserId?: string;
  bootstrapAdminToken?: string;
};

export class HubServer {
  private server?: http.Server;
  private readonly userManager: HubUserManager;
  private readonly authStatePath: string;
  private authState: HubAuthState;

  constructor(private opts: HubServerOptions) {
    this.userManager = new HubUserManager(opts.store, opts.log);
    this.authStatePath = path.join(opts.dataDir, "hub-auth.json");
    this.authState = this.loadAuthState();
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
      } catch (err) {
        this.opts.log.warn(`hub server error: ${String(err)}`);
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "internal_error" }));
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

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/api/v1/hub/info") {
      return this.json(res, 200, {
        teamName: this.teamName,
        version: "0.0.0",
        apiVersion: "v1",
      });
    }

    if (req.method === "POST" && path === "/api/v1/hub/join") {
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

    if (req.method === "GET" && path === "/api/v1/hub/me") {
      const auth = this.authenticate(req);
      if (!auth) return this.json(res, 401, { error: "unauthorized" });
      const user = this.opts.store.getHubUser(auth.userId);
      if (!user) return this.json(res, 401, { error: "unauthorized" });
      return this.json(res, 200, user);
    }

    if (req.method === "GET" && path === "/api/v1/hub/admin/pending-users") {
      const auth = this.authenticate(req);
      if (!auth) return this.json(res, 401, { error: "unauthorized" });
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      return this.json(res, 200, { users: this.userManager.listPendingUsers() });
    }

    if (req.method === "POST" && path === "/api/v1/hub/admin/approve-user") {
      const auth = this.authenticate(req);
      if (!auth) return this.json(res, 401, { error: "unauthorized" });
      if (auth.role !== "admin") return this.json(res, 403, { error: "forbidden" });
      const body = await this.readJson(req);
      const token = issueUserToken({ userId: String(body.userId), username: String(body.username || ""), role: "member", status: "active" }, this.authSecret);
      const approved = this.userManager.approveUser(String(body.userId), token);
      if (!approved) return this.json(res, 404, { error: "not_found" });
      return this.json(res, 200, { status: "active", token });
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

  private async readJson(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }

  private json(res: http.ServerResponse, statusCode: number, body: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
}
