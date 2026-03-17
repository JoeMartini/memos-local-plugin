import type { Logger, MemosLocalConfig } from "../types";
import type { GroupInfo, UserRole, UserStatus } from "../sharing/types";
import type { SqliteStore } from "../storage/sqlite";
import { hubRequestJson, normalizeHubUrl } from "./hub";

export interface HubSessionInfo {
  hubUrl: string;
  userId: string;
  username: string;
  userToken: string;
  role: UserRole;
  connectedAt: number;
}

export interface HubStatusInfo {
  connected: boolean;
  hubUrl?: string;
  user: null | {
    id: string;
    username: string;
    role: UserRole;
    status: UserStatus | string;
    groups: GroupInfo[];
  };
}

export async function connectToHub(store: SqliteStore, config: MemosLocalConfig, log?: Logger): Promise<HubSessionInfo> {
  const hubAddress = config.sharing?.client?.hubAddress ?? "";
  let userToken = config.sharing?.client?.userToken ?? "";

  if (!userToken) {
    const persisted = store.getClientHubConnection();
    if (persisted?.userToken) userToken = persisted.userToken;
  }

  if (!userToken && config.sharing?.client?.teamToken) {
    if (!log) throw new Error("hub client connection is not configured (no userToken, has teamToken but no logger for auto-join)");
    return autoJoinHub(store, config, log);
  }

  if (!hubAddress || !userToken) {
    throw new Error("hub client connection is not configured");
  }

  const hubUrl = normalizeHubUrl(hubAddress);
  const me = await hubRequestJson(hubUrl, userToken, "/api/v1/hub/me", { method: "GET" }) as any;
  store.setClientHubConnection({
    hubUrl,
    userId: String(me.id),
    username: String(me.username ?? ""),
    userToken,
    role: String(me.role ?? "member") as UserRole,
    connectedAt: Date.now(),
  });
  return store.getClientHubConnection()!;
}

export async function getHubStatus(store: SqliteStore, config: MemosLocalConfig): Promise<HubStatusInfo> {
  const conn = store.getClientHubConnection();
  const hubAddress = conn?.hubUrl || config.sharing?.client?.hubAddress || "";
  const userToken = conn?.userToken || config.sharing?.client?.userToken || "";
  if (!hubAddress || !userToken) {
    return { connected: false, user: null };
  }

  try {
    const me = await hubRequestJson(normalizeHubUrl(hubAddress), userToken, "/api/v1/hub/me", { method: "GET" }) as any;
    return {
      connected: true,
      hubUrl: normalizeHubUrl(hubAddress),
      user: {
        id: String(me.id),
        username: String(me.username ?? ""),
        role: String(me.role ?? "member") as UserRole,
        status: String(me.status ?? "active"),
        groups: Array.isArray(me.groups)
          ? me.groups.map((group: any) => ({
              id: String(group.id),
              name: String(group.name),
              description: typeof group.description === "string" ? group.description : undefined,
            }))
          : [],
      },
    };
  } catch {
    return { connected: false, user: null };
  }
}

export async function autoJoinHub(
  store: SqliteStore,
  config: MemosLocalConfig,
  log: Logger,
): Promise<HubSessionInfo> {
  const hubAddress = config.sharing?.client?.hubAddress ?? "";
  const teamToken = config.sharing?.client?.teamToken ?? "";
  if (!hubAddress || !teamToken) {
    throw new Error("hubAddress and teamToken are required for auto-join");
  }
  const hubUrl = normalizeHubUrl(hubAddress);
  const hostname = typeof globalThis.process !== "undefined" ? (await import("os")).hostname() : "unknown";
  const username = typeof globalThis.process !== "undefined" ? (await import("os")).userInfo().username : "user";

  log.info(`Joining Hub at ${hubUrl} as "${username}"...`);
  const result = await hubRequestJson(hubUrl, "", "/api/v1/hub/join", {
    method: "POST",
    body: JSON.stringify({ teamToken, username, deviceName: hostname }),
  }) as any;

  if (!result.userToken) {
    throw new Error(`Hub join failed: ${JSON.stringify(result)}`);
  }

  log.info(`Joined Hub successfully! userId=${result.userId}`);
  store.setClientHubConnection({
    hubUrl,
    userId: String(result.userId),
    username,
    userToken: result.userToken,
    role: "member",
    connectedAt: Date.now(),
  });
  return store.getClientHubConnection()!;
}
