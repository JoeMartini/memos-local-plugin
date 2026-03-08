---
name: memos-memory-guide
description: Use the MemOS memory system to search and use the user's past conversations, including local memory and v4 Hub-shared memory/skills. Use this skill whenever the user refers to past chats, preferences, prior tasks, or shared team knowledge. When auto-recall returns nothing, generate a short search query and call memory_search. Use task_summary for full task context, network_memory_detail for Hub hits, skill_get for local experience guides, skill_search for local/Hub skill discovery, network_skill_pull for Hub skills, memory_write_public for local shared knowledge, and memory_timeline to expand around a local memory hit.
---

# MemOS Local Memory — Agent Guide

This skill describes how to use the MemOS memory tools so you can reliably search and use the user's long-term conversation history, query Hub-shared team data, share tasks, and discover or pull reusable skills.

## How memory is provided each turn

- **Automatic recall (hook):** At the start of each turn, the system runs a memory search using the user's current message and injects relevant past memories into your context. You do not need to call any tool for that.
- **When that is not enough:** If the user's message is very long, vague, or the automatic search returns **no memories**, you should **generate your own short, focused query** and call `memory_search` yourself.
- **Memory isolation:** Each agent can only see its own local private memories and local `public` memories. Hub-shared data only appears when you search with `scope="group"` or `scope="all"`.

## Tools — what they do and when to call

### memory_search

- **What it does:** Searches stored conversation memory by natural-language query. In v4 it supports `scope="local" | "group" | "all"`. Local hits are returned as normal local memory hits; Hub hits are returned in a separate section.
- **When to call:**
  - The automatic recall did not run or returned nothing.
  - The user's query is long or unclear — **generate a short query yourself** and call `memory_search(query="...")`.
  - You need to search team-shared memory instead of only local memory.
- **Parameters:** `query` (required), optional `scope`, `minScore`, `role`.

### memory_write_public

- **What it does:** Writes a piece of information to **public memory**. Public memory is visible to all agents — any agent doing `memory_search` can find it.
- **When to call:** In multi-agent or collaborative scenarios, when you have **persistent information useful to everyone** (e.g. shared decisions, conventions, configurations, workflows). Do not write session-only or purely private content.
- **Parameters:** `content` (required), `summary` (optional).

### task_summary

- **What it does:** Returns the full task summary for a given `task_id`: title, status, and the complete narrative summary.
- **When to call:** A `memory_search` hit included a `task_id` and you need the full story of that task.
- **Parameters:** `taskId` (from a search hit).

### skill_get

- **What it does:** Returns the content of a learned skill (experience guide) by `skillId` or by `taskId`.
- **When to call:** A search hit has a `task_id` and the task has a "how to do this again" guide. Use this to follow the same approach or reuse steps.
- **Parameters:** `skillId` (direct) or `taskId` (lookup).

### skill_search

- **What it does:** Searches available **skills** by natural language across local skills and, in v4, Hub-shared skills.
- **When to call:** The current task requires a capability or guide you do not already have. Use `skill_search` first; after finding a local skill, use `skill_get` or `skill_install`. For Hub skills, use `network_skill_pull` if you want a local copy.
- **Parameters:** `query` (required), `scope` (optional: `local`, `group`, or `all`).

### skill_install

- **What it does:** Installs a skill (by `skillId`) into the workspace for future sessions.
- **When to call:** After `skill_get` when the skill is useful for ongoing use.
- **Parameters:** `skillId`.

### skill_publish

- **What it does:** Publishes a skill for sharing. In v4 this may publish to Hub-visible sharing scopes depending on the provided `scope`.
- **When to call:** You have a useful skill that teammates could benefit from.
- **Parameters:** `skillId`, optional `scope`.

### skill_unpublish

- **What it does:** Makes a skill **private** again. Other agents will no longer discover it.
- **When to call:** You want to stop sharing a previously published skill.
- **Parameters:** `skillId`.

### network_memory_detail

- **What it does:** Fetches the full content behind a Hub search hit.
- **When to call:** A `memory_search` result came from the Hub and you need the full shared memory content.
- **Parameters:** `remoteHitId`.

### task_share / task_unshare

- **What they do:** Share a local task to the Hub, or remove it later.
- **When to call:** A task is valuable to your group or to the whole team and should be discoverable via shared search.
- **Parameters:** `taskId`, plus sharing visibility/scope when required.

### network_skill_pull

- **What it does:** Pulls a Hub-shared skill bundle down into local storage.
- **When to call:** `skill_search` found a useful Hub skill and you want to use it locally or offline.
- **Parameters:** `skillId`.

### network_team_info

- **What it does:** Returns current Hub connection information, user, role, and groups.
- **When to call:** You need to confirm whether team sharing is configured or which groups the current client belongs to.
- **Parameters:** none.

### memory_timeline

- **What it does:** Expands context around a single memory chunk: returns the surrounding conversation messages.
- **When to call:** A `memory_search` hit is relevant but you need the surrounding dialogue.
- **Parameters:** `chunkId` (from a search hit), optional `window` (default 2).

### memory_viewer

- **What it does:** Returns the URL of the MemOS Memory Viewer web dashboard.
- **When to call:** The user asks how to view their memories or open the memory dashboard.
- **Parameters:** None.

## Quick decision flow

1. **No memories in context or auto-recall reported nothing**
   → Call `memory_search` with a **self-generated short query**.

2. **Search returned hits with `task_id` and you need full context**
   → Call `task_summary(taskId)`.

3. **Task has an experience guide you want to follow**
   → Call `skill_get(taskId=...)` or `skill_get(skillId=...)`. Optionally `skill_install(skillId)` for future use.

4. **You need the exact surrounding conversation of a hit**
   → Call `memory_timeline(chunkId=...)`.

5. **You need team-shared memory detail from a Hub hit**
   → Call `network_memory_detail(remoteHitId=...)`.

6. **You need a capability/guide that you do not have**
   → Call `skill_search(query="...", scope="group")` or `scope="all"` to discover available skills.

7. **You found a useful Hub skill and want to use it locally**
   → Call `network_skill_pull(skillId=...)`.

8. **You have a task that should be searchable by teammates**
   → Call `task_share(taskId=...)` and later `task_unshare(taskId=...)` if needed.

9. **You have shared knowledge useful to all local agents**
   → Call `memory_write_public(content="...")` to persist it in local public memory.

10. **You want to share a useful skill with other agents or teammates**
   → Call `skill_publish(skillId=..., scope=...)`.

11. **User asks where to see or manage their memories**
   → Call `memory_viewer()` and share the URL.

## Writing good search queries

- Prefer **short, focused** queries (a few words or one clear question).
- Use **concrete terms**: names, topics, tools, or decisions.
- If the user's message is long, **derive one or two sub-queries** rather than pasting the whole message.
- Use `role='user'` when you specifically want to find what the user said.
