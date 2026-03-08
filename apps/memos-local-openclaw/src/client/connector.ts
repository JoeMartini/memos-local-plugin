import type { MemosLocalConfig } from "../types";
import type { UserRole, UserStatus } from "../sharing/types";
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
  user: null | { id: string; username: string; role: UserRole; status: UserStatus | string };
}

export async function connectToHub(store: SqliteStore, config: MemosLocalConfig): Promise<HubSessionInfo> {
  const hubAddress = config.sharing?.client?.hubAddress ?? "";
  const userToken = config.sharing?.client?.userToken ?? "";
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
      user: {
        id: String(me.id),
        username: String(me.username ?? ""),
        role: String(me.role ?? "member") as UserRole,
        status: String(me.status ?? "active"),
      },
    };
  } catch {
    return { connected: false, user: null };
  }
}
