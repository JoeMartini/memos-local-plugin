import type {
  ClientModeConfig,
  HubModeConfig,
  Role,
  SearchResult,
  SharingCapabilities,
  SharingConfig,
  SharingRole,
  SkillGenerateOutput,
} from "../types";

export type HubScope = "local" | "group" | "all";
export type SharedVisibility = "group" | "public";
export type UserRole = "admin" | "member";
export type UserStatus = "pending" | "active" | "blocked" | "rejected";

export type { ClientModeConfig, HubModeConfig, SharingCapabilities, SharingConfig, SharingRole };

export interface GroupInfo {
  id: string;
  name: string;
  description?: string;
}

export interface UserInfo {
  id: string;
  username: string;
  deviceName?: string;
  role: UserRole;
  status: UserStatus;
  groups: GroupInfo[];
}

export interface HubSearchHit {
  remoteHitId: string;
  summary: string;
  excerpt: string;
  hubRank: number;
  taskTitle: string | null;
  ownerName: string;
  groupName: string | null;
  visibility: SharedVisibility;
  source: {
    ts: number;
    role: Role;
  };
}

export interface HubSearchMeta {
  totalCandidates: number;
  searchedGroups: string[];
  includedPublic: boolean;
}

export interface HubSearchResult {
  hits: HubSearchHit[];
  meta: HubSearchMeta;
}

export interface NetworkSearchResult {
  local: SearchResult;
  hub: HubSearchResult;
}

export interface SkillBundleMetadata {
  id: string;
  name: string;
  description: string;
  version: number;
  qualityScore: number | null;
}

export interface SkillBundle {
  metadata: SkillBundleMetadata;
  bundle: SkillGenerateOutput;
}

