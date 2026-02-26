# NanoClaw CLI Integration

This skill enables Claude Code to interact directly with NanoClaw through a virtual CLI channel.

## What This Skill Does

1. **Adds a CLI channel** to NanoClaw that listens for requests via file-based IPC
2. **Enables multi-session management** - list, select, and end sessions
3. **Provides a CLI tool** (`nanoclaw-cli.sh`) for sending messages

## Usage

After applying this skill, the NanoClaw service will listen for CLI requests. Use the CLI tool to interact:

```bash
# Send a message (uses current/last session by default)
nanoclaw "分析今天的日志"

# List all sessions
nanoclaw --list

# Switch to a specific session
nanoclaw --session abc123

# Start a new session
nanoclaw --new "开始一个全新的任务"

# End current session
nanoclaw --end

# Show current session status
nanoclaw --status
```

## Session Management

- **Default behavior**: Uses the most recently active session
- **Session persistence**: Sessions are stored in SQLite and persist across restarts
- **Session ID**: First 8 characters of the SDK session UUID

## Architecture

```
Claude Code Skill
       ↓
nanoclaw-cli.sh (writes JSON to data/ipc/cli/input/)
       ↓
NanoClaw Service (CLIChannel polls input directory)
       ↓
Agent Container (processes message, returns response)
       ↓
CLIChannel (writes response to data/ipc/cli/output/)
       ↓
nanoclaw-cli.sh (reads response, displays to user)
```

## Files Added

- `src/channels/cli.ts` - CLI channel implementation
- `scripts/nanoclaw-cli.sh` - CLI tool for sending requests

## Files Modified

- `src/db.ts` - Added `cli_sessions` table and session management functions
- `src/index.ts` - Registered CLI channel

## Configuration

Environment variables:
- `NANOCLAW_DIR` - NanoClaw project directory (default: `~/nanoclaw`)
- `NANOCLAW_TIMEOUT` - Request timeout in seconds (default: 120)

## Prerequisites

- NanoClaw service must be running (`systemctl --user start nanoclaw`)
- Docker container image must be built (`./container/build.sh`)
