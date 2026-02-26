#!/bin/bash
# NanoClaw CLI Bridge - Multi-session support
#
# Usage:
#   nanoclaw [OPTIONS] [MESSAGE]
#
# Options:
#   -n, --new              Start a new session
#   -s, --session <ID>     Switch to specific session
#   -l, --list             List all sessions
#   -e, --end              End current session
#   --status               Show current session status
#   --help                 Show this help
#
# Environment:
#   NANOCLAW_DIR     NanoClaw project directory (default: ~/nanoclaw)
#   NANOCLAW_TIMEOUT Request timeout in seconds (default: 120)

set -e

# Configuration
NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
INPUT_DIR="$NANOCLAW_DIR/data/ipc/cli/input"
OUTPUT_DIR="$NANOCLAW_DIR/data/ipc/cli/output"
REQUEST_ID="req-$(date +%s%N)"
TIMEOUT="${NANOCLAW_TIMEOUT:-120}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

usage() {
  echo "NanoClaw CLI - Interact with NanoClaw from Claude Code"
  echo ""
  echo "Usage: nanoclaw [OPTIONS] [MESSAGE]"
  echo ""
  echo "Options:"
  echo "  -n, --new              Start a new session"
  echo "  -s, --session <ID>     Switch to specific session"
  echo "  -l, --list             List all sessions"
  echo "  -e, --end              End current session"
  echo "  --status               Show current session status"
  echo "  --help                 Show this help"
  echo ""
  echo "Examples:"
  echo "  nanoclaw \"分析今天的日志\""
  echo "  nanoclaw -l                           # List all sessions"
  echo "  nanoclaw -s abc123                    # Switch to session"
  echo "  nanoclaw -n \"开始新任务\"              # New session"
  echo "  nanoclaw -e                           # End current session"
  echo ""
  echo "Environment:"
  echo "  NANOCLAW_DIR      NanoClaw directory (default: ~/nanoclaw)"
  echo "  NANOCLAW_TIMEOUT  Timeout in seconds (default: 120)"
}

# Send request to NanoClaw and wait for response
send_request() {
  local request_json="$1"
  local request_file="$INPUT_DIR/${REQUEST_ID}.json"

  # Ensure directories exist
  mkdir -p "$INPUT_DIR" "$OUTPUT_DIR"

  # Write request atomically
  echo "$request_json" > "${request_file}.tmp"
  mv "${request_file}.tmp" "$request_file"

  local response_file="$OUTPUT_DIR/${REQUEST_ID}.json"
  local start_time=$(date +%s)

  while true; do
    local current_time=$(date +%s)
    local elapsed=$((current_time - start_time))

    if [ $elapsed -ge $TIMEOUT ]; then
      echo -e "${RED}✗ Timeout after ${TIMEOUT}s${NC}" >&2
      rm -f "$request_file" "$response_file"
      return 1
    fi

    if [ -f "$response_file" ]; then
      sleep 0.1  # Ensure file is fully written
      cat "$response_file"
      rm -f "$response_file"
      return 0
    fi

    sleep 0.2
  done
}

# Format relative time
format_relative_time() {
  local timestamp="$1"
  local now=$(date +%s)
  local then=$(date -d "$timestamp" +%s 2>/dev/null || echo "0")
  local diff=$((now - then))

  if [ $diff -lt 60 ]; then
    echo "${diff}s ago"
  elif [ $diff -lt 3600 ]; then
    echo "$((diff / 60))m ago"
  elif [ $diff -lt 86400 ]; then
    echo "$((diff / 3600))h ago"
  else
    echo "$((diff / 86400))d ago"
  fi
}

# Parse arguments
COMMAND=""
MESSAGE=""
SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      usage
      exit 0
      ;;
    -l|--list)
      COMMAND="list"
      shift
      ;;
    -e|--end)
      COMMAND="end"
      shift
      ;;
    --status)
      COMMAND="status"
      shift
      ;;
    -n|--new)
      COMMAND="new"
      shift
      ;;
    -s|--session)
      COMMAND="select"
      SESSION_ID="$2"
      shift 2
      ;;
    -*)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      usage
      exit 1
      ;;
    *)
      MESSAGE="$MESSAGE $1"
      shift
      ;;
  esac
done

MESSAGE=$(echo "$MESSAGE" | xargs)  # Trim whitespace

# Process command
case $COMMAND in
  list)
    REQUEST=$(jq -n \
      --arg id "$REQUEST_ID" \
      --arg ts "$(date -Iseconds)" \
      '{"id": $id, "type": "list_sessions", "timestamp": $ts}')
    RESPONSE=$(send_request "$REQUEST")
    if [ $? -ne 0 ]; then exit 1; fi

    echo -e "${BLUE}Sessions:${NC}"
    echo "$RESPONSE" | jq -r '.sessions[]? | "\(.isCurrent == true)|\(.id)|\(.name // .summary // "No description")|\(.lastUsedAt)|\(.messageCount)"' | \
    while IFS='|' read -r is_current id desc last_used msg_count; do
      last_used_str=""
      if [ -n "$last_used" ] && [ "$last_used" != "null" ]; then
        last_used_str=$(format_relative_time "$last_used")
      fi
      if [ "$is_current" = "true" ]; then
        echo -e "  ${GREEN}→ $id${NC} | $desc | Last: $last_used_str | Msgs: $msg_count"
      else
        echo "    $id | $desc | Last: $last_used_str | Msgs: $msg_count"
      fi
    done
    ;;

  select)
    if [ -z "$SESSION_ID" ]; then
      echo -e "${RED}Error: Session ID required${NC}" >&2
      exit 1
    fi
    REQUEST=$(jq -n \
      --arg id "$REQUEST_ID" \
      --arg sid "$SESSION_ID" \
      --arg ts "$(date -Iseconds)" \
      '{"id": $id, "type": "select_session", "sessionId": $sid, "timestamp": $ts}')
    RESPONSE=$(send_request "$REQUEST")
    if [ $? -ne 0 ]; then exit 1; fi

    STATUS=$(echo "$RESPONSE" | jq -r '.status')
    if [ "$STATUS" = "success" ]; then
      echo -e "${GREEN}✓ Switched to session $SESSION_ID${NC}"
    else
      ERROR=$(echo "$RESPONSE" | jq -r '.error')
      echo -e "${RED}✗ $ERROR${NC}" >&2
      exit 1
    fi
    ;;

  end)
    REQUEST=$(jq -n \
      --arg id "$REQUEST_ID" \
      --arg ts "$(date -Iseconds)" \
      '{"id": $id, "type": "end_session", "timestamp": $ts}')
    RESPONSE=$(send_request "$REQUEST")
    if [ $? -ne 0 ]; then exit 1; fi

    STATUS=$(echo "$RESPONSE" | jq -r '.status')
    if [ "$STATUS" = "success" ]; then
      RESULT=$(echo "$RESPONSE" | jq -r '.result')
      echo -e "${YELLOW}✓ $RESULT${NC}"
    else
      ERROR=$(echo "$RESPONSE" | jq -r '.error')
      echo -e "${RED}✗ $ERROR${NC}" >&2
      exit 1
    fi
    ;;

  status)
    REQUEST=$(jq -n \
      --arg id "$REQUEST_ID" \
      --arg ts "$(date -Iseconds)" \
      '{"id": $id, "type": "status", "timestamp": $ts}')
    RESPONSE=$(send_request "$REQUEST")
    if [ $? -ne 0 ]; then exit 1; fi

    CURRENT=$(echo "$RESPONSE" | jq -r '.currentSession')
    if [ "$CURRENT" = "null" ] || [ -z "$CURRENT" ]; then
      echo -e "${YELLOW}No active session${NC}"
    else
      echo -e "${BLUE}Current Session:${NC}"
      ID=$(echo "$RESPONSE" | jq -r '.currentSession.id')
      CREATED=$(echo "$RESPONSE" | jq -r '.currentSession.createdAt')
      LAST_USED=$(echo "$RESPONSE" | jq -r '.currentSession.lastUsedAt')
      MSG_COUNT=$(echo "$RESPONSE" | jq -r '.currentSession.messageCount')
      SUMMARY=$(echo "$RESPONSE" | jq -r '.currentSession.summary // "N/A"')

      echo "  ID: $ID"
      echo "  Created: $CREATED"
      echo "  Last Used: $(format_relative_time "$LAST_USED")"
      echo "  Messages: $MSG_COUNT"
      echo "  Summary: $SUMMARY"
    fi
    ;;

  new|""|message)
    if [ -z "$MESSAGE" ]; then
      if [ "$COMMAND" = "new" ]; then
        echo -e "${RED}Error: Message required for new session${NC}" >&2
        echo "Usage: nanoclaw --new \"your message\"" >&2
      else
        usage
      fi
      exit 1
    fi

    if [ "$COMMAND" = "new" ]; then
      REQUEST=$(jq -n \
        --arg id "$REQUEST_ID" \
        --arg text "$MESSAGE" \
        --arg ts "$(date -Iseconds)" \
        '{"id": $id, "type": "message", "text": $text, "timestamp": $ts, "options": {"newSession": true}}')
    else
      REQUEST=$(jq -n \
        --arg id "$REQUEST_ID" \
        --arg text "$MESSAGE" \
        --arg ts "$(date -Iseconds)" \
        '{"id": $id, "type": "message", "text": $text, "timestamp": $ts}')
    fi

    echo -e "${CYAN}→ Sent:${NC} $MESSAGE"

    RESPONSE=$(send_request "$REQUEST")
    if [ $? -ne 0 ]; then exit 1; fi

    STATUS=$(echo "$RESPONSE" | jq -r '.status')
    SESSION_ID=$(echo "$RESPONSE" | jq -r '.sessionId // "N/A"')

    if [ "$STATUS" = "success" ]; then
      RESULT=$(echo "$RESPONSE" | jq -r '.result')
      echo ""
      echo -e "${GREEN}← [${SESSION_ID:0:8}]${NC}"
      echo "$RESULT"
    else
      ERROR=$(echo "$RESPONSE" | jq -r '.error')
      echo -e "${RED}✗ $ERROR${NC}" >&2
      exit 1
    fi
    ;;
esac
