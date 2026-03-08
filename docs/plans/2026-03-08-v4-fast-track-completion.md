# V4 Hub Sharing Fast-Track Completion Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a complete first usable version of v4 hub-spoke sharing as fast as possible, while preserving the already-working MVP memory-sharing path and finishing the remaining product-completeness items.

**Architecture:** Keep the current mainline focused on the Hub memory-sharing critical path, then close remaining gaps in descending product value: detail retrieval, team info/onboarding polish, skill sync, Viewer UI, and final integration tests. Use parallel work whenever tasks have disjoint write scopes and do not block the mainline.

**Tech Stack:** TypeScript, `better-sqlite3`, Hub HTTP server, local `RecallEngine`, Viewer server/UI, Vitest, OpenClaw plugin lifecycle.

---

## Current State

### Already completed on `codex/v4-hub-sharing`
- `T1` sharing config/types foundation
- `T2` hub/client schema + store helpers
- `T3` hub service skeleton + auth bootstrap
- `T5` minimal hub search + task share endpoints
- `T6` minimal client connector
- `T7` minimal local + hub memory search
- `T8` minimal `task_share` / `task_unshare`

### Completed on side branch/worktree
- `T4` openclaw fallback guards on `codex/t4-openclaw-fallback`

### Immediate cleanup items before next feature work
- Main branch currently has uncommitted changes in:
  - `apps/memos-local-openclaw/src/tools/memory-search.ts`
  - `apps/memos-local-openclaw/tests/integration.test.ts`
- There is an untracked stray path to clean:
  - `apps/memos-local-openclaw/~/`

These should be resolved before starting the next implementation batch.

## Remaining Work (All still required)

### Product-critical gaps
- Add `network_memory_detail` tool wired to `/api/v1/hub/memory-detail`
- Add `network_team_info` tool wired to `/api/v1/hub/me` (+ group list if available)
- Finish `T10` skill publish/pull via Hub
- Merge `T4` branch after quick sanity verification

### Product-completeness gaps
- Minimal but usable Viewer/UI for hub/client state (`T12` MVP slice)
- Full tool registration completeness (`T11` finish)
- Final integrated tests + README update (`T13`)

## Fastest Completion Strategy

```text
Phase A — Stabilize current core (serial, short)
  A0 Clean current working tree
  A1 Land or discard leftover uncommitted T7 edits
  A2 Merge T4 worktree branch into mainline

Phase B — Finish missing user-facing MVP links (mainline + parallel)
  B1 Mainline: network_memory_detail + network_team_info
  B2 Parallel: T10 skill sync via Hub

Phase C — Product completeness (parallel)
  C1 Mainline: T11 tool registration completion
  C2 Parallel: T12 minimal usable Viewer UX

Phase D — Hardening (serial)
  D1 T13 end-to-end smoke + focused integration suite
  D2 README / setup docs / release sanity check
```

## Parallelization Rules

### Must stay on the mainline critical path
- `A0` cleanup
- `A1` settle current dirty changes
- `B1` `network_memory_detail` + `network_team_info`
- `C1` final tool registration
- `D1` final smoke/integration verification

### Should run in parallel when possible
- `T4` merge prep / sanity verification
- `T10` skill publish/pull via Hub
- `T12` Viewer/UI minimal admin & client state screens

### Why these are parallel-safe
- `T10` mostly touches skill/Hub endpoints + client skill flows
- `T12` mostly touches `src/viewer/server.ts`, `src/viewer/html.ts`
- `B1` mostly touches tool wiring and client helper paths

## Recommended Execution Order

```text
Now
├─ A0 Clean worktree state
├─ A1 Decide whether dirty T7 edits are keep/amend/discard
├─ A2 Merge `codex/t4-openclaw-fallback`
│
├─ B1 Mainline: add `network_memory_detail`
│      └─ then add `network_team_info`
│
├─ B2 Parallel: T10 skill publish/pull via Hub
│
├─ C1 Mainline: finalize tool registration
│
├─ C2 Parallel: minimal Viewer/client/hub UI
│
└─ D1/D2 Final test + docs + release pass
```

## Exact Next Task Recommendations

### Task A0: Clean current branch state
**Why first:** Prevent accidental overwrite/confusion before more parallel work.

**Actions:**
- Inspect current diffs in:
  - `apps/memos-local-openclaw/src/tools/memory-search.ts`
  - `apps/memos-local-openclaw/tests/integration.test.ts`
- Decide whether they belong to `T7` and should be committed/amended, or discarded
- Remove stray path `apps/memos-local-openclaw/~/`

### Task A2: Merge T4 worktree branch
**Why now:** It is already implemented and does not block the current core, but the branch divergence should not grow.

**Actions:**
- Compare `codex/t4-openclaw-fallback` against mainline
- Merge or cherry-pick:
  - `69b96c0 feat(memos-local): add openclaw fallback guards`
  - later viewer-gating follow-up if present in worktree
- Run targeted fallback tests + build on mainline

### Task B1.1: Add `network_memory_detail`
**Why next:** Search already returns `remoteHitId`, so this closes the user-visible memory flow.

**Files:**
- Modify: `apps/memos-local-openclaw/index.ts`
- Modify: `apps/memos-local-openclaw/src/client/hub.ts`
- Modify: `apps/memos-local-openclaw/tests/integration.test.ts`

**MVP behavior:**
- Input: `remoteHitId`, optional `hubAddress`, optional `userToken`
- Resolve hub client using existing connector/helper fallback chain
- Call `/api/v1/hub/memory-detail`
- Return content/summary/source

### Task B1.2: Add `network_team_info`
**Why immediately after:** Cheap, high-value visibility into connection/user/group context.

**Files:**
- Modify: `apps/memos-local-openclaw/index.ts`
- Modify: `apps/memos-local-openclaw/src/client/connector.ts`
- Modify: `apps/memos-local-openclaw/tests/client-connector.test.ts`

**MVP behavior:**
- Return connected/disconnected state
- Return current user identity/role
- Return groups if available from `/me` or local persisted state

### Task B2: Finish T10 Hub skill sync
**Why parallel:** Important for completeness, but does not block memory-sharing MVP.

**Files:**
- Modify: `apps/memos-local-openclaw/index.ts`
- Modify: `apps/memos-local-openclaw/src/skill/installer.ts`
- Create/modify: `apps/memos-local-openclaw/src/client/skill-sync.ts`
- Add tests in `apps/memos-local-openclaw/tests/integration.test.ts`

**Minimum completion criteria:**
- `skill_publish(scope=group|public)` to Hub
- `network_skill_pull` from Hub
- bundle validation stays enforced

### Task C1: Finish T11 tool registration
**Why after B1/T10:** Register only once core tools and skill tools exist.

**Required tools to expose by end:**
- `task_share`
- `task_unshare`
- `network_memory_detail`
- `network_team_info`
- `network_skill_pull`

### Task C2: Minimal T12 Viewer UI
**Why not earlier:** UI should follow working APIs.

**MVP UI only:**
- Client: show Hub connected/disconnected + current user/role
- Search: local/group/all selector if not already present
- Hub/Admin: pending users list + approve action
- Shared result section rendering for hub hits

### Task D1: Final T13 test pass
**Do not skip.**

**Minimum smoke matrix:**
- Hub start/stop
- Join + approve
- Connect client
- `task_share`
- `memory_search(scope=group)`
- `network_memory_detail`
- `task_unshare`
- Hub-down fallback to local-only search
- skill publish/pull smoke if T10 lands

## Fastest Team Split

### Mainline owner
- A0/A1 cleanup
- A2 T4 merge
- B1 `network_memory_detail`, `network_team_info`
- C1 tool registration
- D1/D2 final smoke + docs

### Parallel lane 1
- T10 skill sync via Hub

### Parallel lane 2
- T12 minimal Viewer UI

## “Tomorrow-ready” Definition

A release is acceptable when all are true:
- Hub starts with a valid team token
- Admin bootstrap and approval flow work
- Client can connect and persist session
- Local task can be shared to Hub and searched back
- Hub hit can be opened with `network_memory_detail`
- Task can be unshared
- Local-only behavior still works if Hub is unavailable
- No obvious auth bypass in the happy-path MVP routes

## Non-blocking defects to defer if time is short
- Advanced Viewer polish
- Rich group management UX
- Deep fallback/host integration beyond safe guards
- Skill version-management niceties beyond publish/pull happy path
- Exhaustive edge-case test coverage outside the smoke matrix
