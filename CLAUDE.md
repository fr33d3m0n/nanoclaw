# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is NanoClaw

Personal Claude assistant. Single Node.js process (ES modules, strict TypeScript, ES2022) that connects to WhatsApp (or other channels via skills), routes messages to Claude Agent SDK running in isolated Linux containers. Each group gets its own filesystem, memory, and session.

See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions. See [docs/SECURITY.md](docs/SECURITY.md) for the security model.

## Commands

```bash
npm run dev              # Run with hot reload (tsx)
npm run build            # Compile TypeScript (tsc)
npm run typecheck        # tsc --noEmit
npm run test             # vitest run (src/, setup/, skills-engine/)
npm run test:watch       # vitest watch mode
npx vitest run src/db.test.ts              # Run a single test file
npx vitest run -c vitest.skills.config.ts  # Run skill integration tests (.claude/skills/**/tests/)
npm run format           # prettier --write
npm run format:check     # prettier --check
./container/build.sh     # Rebuild agent container image
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

Run commands directly—don't tell the user to run them.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state machine, message loop, agent invocation, startup/shutdown |
| `src/channels/whatsapp.ts` | Baileys WhatsApp: connect, reconnect, send/receive, group metadata sync, LID→phone translation |
| `src/ipc.ts` | IPC watcher: polls container output dirs for outbound messages and task operations |
| `src/router.ts` | XML message formatting (`<messages><message sender="..." time="...">`) and outbound channel routing |
| `src/config.ts` | All constants: paths, timeouts, trigger pattern, env vars. Read-only, no runtime mutation |
| `src/container-runner.ts` | Spawns Docker containers, builds volume mounts, streams output via marker protocol |
| `src/container-runtime.ts` | Runtime abstraction layer (Docker commands) |
| `src/group-queue.ts` | Per-group ordered queue with global concurrency cap (`MAX_CONCURRENT_CONTAINERS`), retry/backoff |
| `src/task-scheduler.ts` | 60s poll loop for due cron/interval/once tasks |
| `src/db.ts` | SQLite via better-sqlite3: all CRUD for 7 tables, JSON→SQLite migration |
| `src/mount-security.ts` | Allowlist-based mount validation, blocked pattern checking, symlink resolution |
| `src/types.ts` | All TypeScript interfaces: `Channel`, `RegisteredGroup`, `NewMessage`, `ScheduledTask`, mount types |
| `src/env.ts` | Selective `.env` reader — never calls `dotenv.config()` or sets `process.env` |
| `container/agent-runner/src/index.ts` | Container-side brain: reads stdin JSON, runs Claude Agent SDK `query()`, IPC polling, output markers |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server inside container: `send_message`, `schedule_task`, `register_group`, etc. |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated, mounted at `/workspace/group/CLAUDE.md`) |

## Architecture

### Message Flow

```
WhatsApp → Baileys event → storeMessage(SQLite) → 2s poll loop → trigger check
→ catchup messages since last agent → XML formatting → queue dispatch
→ container spawn (or IPC to running container) → Claude Agent SDK → stdout markers
→ strip <internal> tags → channel.sendMessage() → WhatsApp
```

### Two-Cursor System

The host tracks two independent cursors to prevent duplicate processing while allowing recovery:

- **`lastTimestamp`**: Advanced immediately when messages arrive. Tracks what's been "seen".
- **`lastAgentTimestamp[jid]`**: Advanced just before agent invocation. Tracks what's been "processed". Rolled back if agent produces no output, allowing retry on next poll.

### Container Lifecycle

Containers are **long-lived** (30-min idle timeout), not per-message. Follow-up messages are piped into running containers via IPC filesystem files. This means:

1. First message → spawns container, writes `ContainerInput` JSON to stdin
2. Subsequent messages → `queue.sendMessage()` writes IPC JSON file → container polls and picks it up
3. 30 min idle → `_close` sentinel written → container shuts down gracefully

### Four-Layer IPC Protocol

| Layer | Direction | Mechanism |
|-------|-----------|-----------|
| Initial prompt | Host → Container | `ContainerInput` JSON written to container stdin, then EOF |
| Follow-up messages | Host → Container | JSON files in `data/ipc/{group}/input/` polled at 500ms |
| Outbound actions | Container → Host | JSON files in `/workspace/ipc/messages/` and `tasks/` polled at 1s |
| Agent results | Container → Host | Stdout with `---NANOCLAW_OUTPUT_START/END---` markers |

### Channel Abstraction

`Channel` interface in `types.ts`: `connect()`, `sendMessage(jid, text)`, `isConnected()`, `ownsJid(jid)`, `disconnect()`, optional `setTyping()`. The orchestrator is channel-agnostic — routing uses `ownsJid()` to find the right channel. Skills like `/add-telegram` and `/add-discord` add new channel implementations.

### Group Isolation

Each group gets:
- `groups/{folder}/` → `/workspace/group` (rw) — group's working directory and CLAUDE.md
- `data/sessions/{folder}/.claude/` → `/home/node/.claude` — isolated SDK sessions
- `data/ipc/{folder}/` → `/workspace/ipc` — isolated IPC namespace
- `data/sessions/{folder}/agent-runner-src/` → `/app/src` — per-group customizable agent runner (recompiled on each container start)

Non-main groups cannot access other groups' IPC or send messages to other JIDs. Main group has unrestricted access.

### Secrets Handling

Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are read from `.env`/`process.env` only in `container-runner.ts`, passed to containers via stdin JSON (never env vars), and deleted from the input object before logging. Inside containers, `createSanitizeBashHook` strips them from Bash subprocess environments.

## Database

SQLite at `store/messages.db`. Seven tables: `chats`, `messages`, `scheduled_tasks`, `task_run_logs`, `router_state`, `sessions`, `registered_groups`. Tests use `_initTestDatabase()` which opens an in-memory SQLite instance.

## Testing

Two vitest configs:

- `vitest.config.ts` — main tests: `src/**/*.test.ts`, `setup/**/*.test.ts`, `skills-engine/**/*.test.ts`
- `vitest.skills.config.ts` — skill integration tests: `.claude/skills/**/tests/*.test.ts`

DB tests call `_initTestDatabase()` (exported from `db.ts`) for in-memory SQLite. The main entry point (`index.ts`) has an `isDirectRun` guard to prevent `main()` from executing during test imports.

## Skills System

Skills are code-level extensions applied via three-way merge. State tracked in `.nanoclaw/state.yaml`. Each skill has a `manifest.yaml` declaring files to add/modify, structured operations (npm deps, env vars), dependencies, and tests.

`skills-engine/` implements: apply, backup/restore, three-way git merge (`git merge-file`), conflict resolution cache (git rerere), path remap for renamed files, structured merge for package.json/docker-compose/env.

Skills are in `.claude/skills/{name}/` with `SKILL.md` (instructions) and optionally `manifest.yaml`, `add/`, `modify/`, `tests/`.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/configure-model` | Switch AI model provider (Claude, Zhipu GLM, custom proxy), manage API endpoints and tokens |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |
