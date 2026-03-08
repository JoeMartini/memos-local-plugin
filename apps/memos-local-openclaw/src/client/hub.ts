import type { PluginContext } from "../types";
import type { SqliteStore } from "../storage/sqlite";

export interface ResolvedHubClient {
  hubUrl: string;
  userToken: string;
  userId: string;
  username: string;
  role: string;
}

export async function resolveHubClient(store: SqliteStore, ctx: PluginContext): Promise<ResolvedHubClient> {
  const persisted = store.getClientHubConnection() as any;
  if (persisted?.hubUrl && persisted?.userToken) {
    return {
      hubUrl: normalizeHubUrl(String(persisted.hubUrl)),
      userToken: String(persisted.userToken),
      userId: String(persisted.userId),
      username: String(persisted.username ?? ""),
      role: String(persisted.role ?? "member"),
    };
  }

  const hubAddress = ctx.config.sharing?.client?.hubAddress ?? "";
  const userToken = ctx.config.sharing?.client?.userToken ?? "";
  if (!hubAddress || !userToken) {
    throw new Error("hub client connection is not configured");
  }

  const hubUrl = normalizeHubUrl(hubAddress);
  const me = await hubRequestJson(hubUrl, userToken, "/api/v1/hub/me", { method: "GET" }) as any;

  return {
    hubUrl,
    userToken,
    userId: String(me.id),
    username: String(me.username ?? ""),
    role: String(me.role ?? "member"),
  };
}

export async function hubRequestJson(
  hubUrl: string,
  userToken: string,
  route: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${normalizeHubUrl(hubUrl)}${route}`, {
    ...init,
    headers: {
      authorization: `Bearer ${userToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`hub request failed (${res.status}): ${body || res.statusText}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export function normalizeHubUrl(hubAddress: string): string {
  const trimmed = hubAddress.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}
