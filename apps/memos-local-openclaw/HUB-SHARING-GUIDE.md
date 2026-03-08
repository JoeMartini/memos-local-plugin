# Hub Sharing Guide

This guide explains how to use the v4 Hub sharing workflow in `memos-local-openclaw`: how to create a team Hub, join from another machine, get approved, search shared memory, share tasks, publish skills, and pull skills back to local use.

## What v4 adds

The plugin now supports a **Hub-Spoke** sharing model:

- **Local memory stays local** unless you explicitly share it
- **One Hub server** stores team-shared tasks, memories, and skills
- **Clients connect to the Hub** with a user token
- **Admins approve users** before they can access team data
- **Search scope** can be `local`, `group`, or `all`
- **Shared skills** can be published to a group or to the whole team

## Core concepts

### Search scope

- `local` — search only your local SQLite data
- `group` — search local data + Hub data visible to your groups + public Hub data
- `all` — same effective permissions as `group`; use it when you want “everything I am allowed to see”

### Visibility

There are two different “public” concepts in the plugin:

- Local `owner="public"` memory — shared **inside the current local instance** across agents
- Hub `visibility="public"` — shared **to the whole team** through the Hub

For Hub sharing, the important visibility values are:

- `private` — local only
- `group` — visible to members of a group on the Hub
- `public` — visible to all approved team members on the Hub

### What gets stored where

- **Private memories and private skills** stay in your local SQLite database
- **Shared tasks, shared chunks, and published skill bundles** are stored in the Hub database
- **Pulled skills** are restored back into your local `skills-store/` for offline use

## Before you start

You need:

- OpenClaw installed and working
- This plugin installed and enabled
- OpenClaw built-in memory search disabled in `openclaw.json`
- A machine that can stay online if you want to run the Hub there

## Deployment modes

The plugin runs in one of two sharing roles:

- `hub` — starts the Hub server and manages team membership
- `client` — connects to an existing Hub

You enable sharing with:

```jsonc
{
  "sharing": {
    "enabled": true,
    "role": "hub"
  }
}
```

or:

```jsonc
{
  "sharing": {
    "enabled": true,
    "role": "client"
  }
}
```

## Option A: Create a team Hub

Use this on the first machine in the team.

### Example config

```jsonc
{
  "plugins": {
    "entries": {
      "memos-local-openclaw-plugin": {
        "enabled": true,
        "config": {
          "sharing": {
            "enabled": true,
            "role": "hub",
            "hub": {
              "port": 18800,
              "teamName": "My Team",
              "teamToken": "${MEMOS_TEAM_TOKEN}"
            }
          }
        }
      }
    }
  }
}
```

### What happens

- The plugin starts the Hub HTTP server
- The first bootstrap user becomes the team admin
- The Hub stores user approvals, groups, shared tasks, shared chunks, and shared skills
- The Viewer shows Hub admin controls in **Settings → Hub & Team**

### Admin responsibilities

The Hub admin can:

- approve or reject join requests
- review pending users
- see Hub connection and team information
- manage who can access shared team data

## Option B: Join an existing team Hub

Use this on every other machine.

### Example config

```jsonc
{
  "plugins": {
    "entries": {
      "memos-local-openclaw-plugin": {
        "enabled": true,
        "config": {
          "sharing": {
            "enabled": true,
            "role": "client",
            "client": {
              "hubAddress": "192.168.1.100:18800",
              "userToken": "${MEMOS_USER_TOKEN}"
            }
          }
        }
      }
    }
  }
}
```

### Important note about joining

In the current implementation, the **join and approval flow exists at the Hub API level and Viewer admin UI**, but the client still needs a valid `userToken` to operate as a connected client.

That means the usual rollout is:

1. Admin starts the Hub
2. Admin creates or issues a user token for the client environment
3. Client configures `hubAddress` + `userToken`
4. Viewer shows the connected team / role / groups

If you are testing the raw Hub API directly, the public join endpoint is:

- `POST /api/v1/hub/join`

Admin review endpoints are:

- `GET /api/v1/hub/admin/pending-users`
- `POST /api/v1/hub/admin/approve-user`
- `POST /api/v1/hub/admin/reject-user`

## Viewer walkthrough

### 1. Hub & Team panel

Open the Memory Viewer and go to **Settings**.

The **Hub & Team** panel shows:

- whether sharing is enabled
- whether you are in `hub` or `client` mode
- which Hub you are connected to
- your team, username, role, and groups
- pending user approvals if you are an admin

### 2. Memory search with team scope

In the **Memories** tab, the search scope selector now supports:

- `Local`
- `Group`
- `All`

Result behavior:

- local hits stay in the normal local result format
- Hub hits are shown in a separate section
- Hub hits include extra context like owner and group
- use the **View Detail** action on a Hub result to fetch full shared memory content

### 3. Task sharing

In the **Tasks** tab:

- open a task detail panel
- use the share controls in the header
- choose `Share to Group` or `Share to Public`
- click **Share**
- click **Unshare** to remove the task from the Hub

What gets shared:

- task metadata
- all current task chunks
- later chunks can be pushed by the client flow as the task continues evolving

### 4. Skill search and pull

In the **Skills** tab:

- search locally as usual
- switch scope to `Group` or `All`
- local and Hub skill results are shown separately
- click **Pull to Local** on a Hub skill to restore the bundle locally

Pulled skills are written into your local skills store, so they remain usable even if the Hub is offline later.

## Agent tools for team sharing

These are the main tools you will use with v4 sharing:

### Memory tools

- `memory_search(query, scope)`
  - `scope: "local" | "group" | "all"`
  - returns local results and, for shared scopes, a separate Hub result section
- `network_memory_detail(remoteHitId)`
  - fetches the full content for a Hub memory hit
- `memory_get` / `memory_timeline`
  - still work for **local** hits only

### Task sharing tools

- `task_share(taskId, visibility)`
  - shares a task to the Hub
- `task_unshare(taskId)`
  - removes that task from the Hub

### Skill tools

- `skill_search(query, scope)`
  - supports `local`, `group`, and `all`
- `skill_publish(skillId, scope)`
  - publish a skill to `public` or a group-facing scope supported by your current flow
- `skill_unpublish(skillId)`
  - remove a previously published skill from Hub sharing
- `network_skill_pull(skillId)`
  - pull a Hub skill bundle into local storage
- `skill_get` / `skill_install`
  - continue to work for local skills

### Team info

- `network_team_info()`
  - shows Hub URL, connected user, role, team, and groups

## End-to-end example workflow

### Example 1: Search team memory

1. Open a new task in OpenClaw
2. Ask the agent to search with `scope: "group"`
3. Review local results first
4. Review Hub hits with owner/group context
5. Use `network_memory_detail` if a Hub hit looks relevant

### Example 2: Share a task

1. Finish a useful task locally
2. Open the task in Viewer
3. Choose `Share to Group` or `Share to Public`
4. Click **Share**
5. Teammates searching with `group` or `all` can now discover it

### Example 3: Publish and pull a skill

1. Publish a polished local skill with `skill_publish`
2. Another teammate searches Hub skills with `scope: "all"`
3. They click **Pull to Local** in Viewer, or call `network_skill_pull`
4. The bundle is restored locally for reuse

## What happens if the Hub is down

The intended behavior is graceful degradation:

- local memory still works
- local skills still work
- Viewer still opens
- shared searches fall back to local results with an empty Hub section
- share / pull actions fail cleanly until the Hub is back

## Model configuration and current fallback behavior

### Embedding

You can configure a provider explicitly, such as:

- `openai_compatible`
- `gemini`
- `cohere`
- `voyage`
- `mistral`
- `local`

### Summarizer / skill models

You can configure:

- `openai_compatible`
- `anthropic`
- `gemini`
- `bedrock`

### Current sidecar-build fallback behavior

In the current plugin build:

- if embedding is not configured, the plugin falls back to the **local embedding model**
- if summarizer is not configured, the plugin falls back to the **rule-based summarizer**
- if a configured remote provider fails, the plugin falls back to the local/rule-based path where supported
- `openclaw` host-backed providers are defined in types, but are **not available in this sidecar build unless host capabilities are explicitly supported**

If you want predictable production behavior today, configure your embedding and summarizer providers explicitly.

## Troubleshooting

### Viewer says sharing is disabled

Check:

- `sharing.enabled` is `true`
- `sharing.role` is set correctly
- the gateway was restarted after config changes

### Viewer says client configured but disconnected

Check:

- the Hub server is running
- `sharing.client.hubAddress` is correct
- `sharing.client.userToken` is valid
- the Hub machine is reachable on the configured port

### I can see local results but no Hub results

Check:

- you selected `Group` or `All`, not `Local`
- the Hub actually contains shared tasks or skills
- your user belongs to the required group
- the admin approved your access

### Shared memory detail fails

Usually this means one of the following:

- the hit was generated from another user token/session context
- the Hub-side `remoteHitId` expired
- the Hub is unavailable

Run a fresh search and try the detail action again.

### Skill pull fails

Check:

- the Hub skill still exists
- your token is valid
- the bundle passes local safety validation
- your local skills directory is writable

## Recommended rollout for a small team

1. Pick one stable machine as the Hub host
2. Enable `sharing.role = "hub"` there
3. Confirm the admin can open Viewer and see Hub status
4. Configure one client machine with `hubAddress` + `userToken`
5. Verify `network_team_info()` works
6. Share one task, search it from another machine, and open Hub memory detail
7. Publish one skill and pull it from another machine
8. Only then roll the config out to the rest of the team
