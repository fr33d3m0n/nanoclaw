---
name: configure-model
description: Configure the AI model provider for NanoClaw containers. Switch between Anthropic Claude, Zhipu GLM, or other Anthropic-compatible API providers. Manages API endpoint, auth tokens, model names, and feature flags. Triggers on "configure model", "change model", "switch provider", "use glm", "use claude", "model config".
---

# NanoClaw Model Configuration

Configure the AI model provider used inside NanoClaw containers. Supports Anthropic Claude (default) and any Anthropic Messages API-compatible provider (e.g. Zhipu GLM, AWS Bedrock, custom proxies).

**Principle:** Make changes directly. Only pause for user input when a choice or secret is required.

## Architecture

NanoClaw delivers model configuration through two channels:

| Channel | What goes here | Security | Location |
|---------|---------------|----------|----------|
| `.env` → `readSecrets()` → stdin → `sdkEnv` | Auth tokens, API endpoint URL | Memory-only (never on disk in container) | `.env` at project root |
| `settings.json` `env` block | Model names, feature flags | On disk in container (non-secret) | `data/sessions/{group}/.claude/settings.json` |

**Key files:**
- `src/container-runner.ts` — `readSecrets()` (line ~186) reads `.env` keys; `buildVolumeMounts()` (line ~108) writes `settings.json`
- `container/agent-runner/src/index.ts` — `SECRET_ENV_VARS` (line ~191) strips secrets from Bash subprocess env
- `.env` — project-root env file (never committed to git)

## Workflow

### Step 1: Identify Target Provider

AskUserQuestion: Which model provider?
- **Anthropic Claude** (default) — uses `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`
- **Zhipu GLM** — uses `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` via Anthropic-compatible proxy
- **Other Anthropic-compatible proxy** — custom endpoint + token

### Step 2: Configure Authentication

#### Anthropic Claude (default)
Check `.env` for existing `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. If present, confirm keep or replace.

No `ANTHROPIC_BASE_URL` needed (uses default Anthropic endpoint).

#### Zhipu GLM
Set in `.env`:
```
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
ANTHROPIC_AUTH_TOKEN=<user's token>
```

AskUserQuestion: Please provide your Zhipu API key (starts with a hash-like string).

#### Custom Provider
AskUserQuestion: What is the API base URL? (must implement Anthropic Messages API)
AskUserQuestion: What authentication token to use?

Set in `.env`:
```
ANTHROPIC_BASE_URL=<provided URL>
ANTHROPIC_AUTH_TOKEN=<provided token>
```

### Step 3: Configure Model Names

AskUserQuestion: What model name(s) does this provider use?

For providers that use a single model name for all tiers:
```
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model>
ANTHROPIC_DEFAULT_SONNET_MODEL=<model>
ANTHROPIC_DEFAULT_OPUS_MODEL=<model>
```

For providers with tiered models (e.g. Anthropic):
- Leave these unset (Claude Code uses its built-in defaults)
- Or set specific versions if needed

**Common configurations:**

| Provider | Haiku | Sonnet | Opus |
|----------|-------|--------|------|
| Anthropic (default) | (unset) | (unset) | (unset) |
| Zhipu GLM-5 | glm-5 | glm-5 | glm-5 |
| Zhipu GLM-4 | glm-4-flash | glm-4 | glm-4-plus |

Set model overrides in `.env` (they are read by `container-runner.ts` and written to each group's `settings.json`).

### Step 4: Configure Feature Flags (Optional)

AskUserQuestion: Adjust output token limits? (default: 64000)

These are already set in the default `settings.json` template:
```
ENABLE_BACKGROUND_TASKS=1
CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000
MAX_MCP_OUTPUT_TOKENS=64000
```

If the user wants different values, update the settings.json template in `src/container-runner.ts` `buildVolumeMounts()`.

### Step 5: Apply to Existing Groups

The `settings.json` template only writes on first container start (guarded by `if (!fs.existsSync(settingsFile))`). To apply changes to existing groups:

```bash
# List existing group settings
find data/sessions -name settings.json -path '*/.claude/*'
```

For each file found, read the current content, merge in the new `env` values, and write back. Preserve any group-specific customizations.

Example update for Zhipu GLM:
```typescript
// Read existing settings.json
const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
// Merge model overrides
settings.env = {
  ...settings.env,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5',
};
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
```

### Step 6: Reverting to Anthropic Claude

To switch back to default Anthropic:
1. Remove or comment out `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from `.env`
2. Remove or comment out `ANTHROPIC_DEFAULT_*_MODEL` from `.env`
3. Delete existing group settings to regenerate defaults:
   ```bash
   find data/sessions -name settings.json -path '*/.claude/*' -delete
   ```
4. Ensure `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set in `.env`

### Step 7: Verify and Restart

```bash
# Rebuild
npm run build

# Restart service
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

Tell the user to send a test message to verify the new model is responding.

## Troubleshooting

**Container exits with auth error:** Check that `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`) is set correctly in `.env`. The token is passed via stdin — check `groups/*/logs/container-*.log` for error details.

**Model not found error:** The provider may not recognize the model name. Check the provider's documentation for available model IDs.

**Responses are different quality/style:** Non-Claude models may not support all Claude Code features (agent teams, tool use patterns, extended thinking). Test basic functionality first.

**Settings not applied to existing group:** The settings.json is only created once. Run step 5 to update existing groups, or delete the settings file and restart.

**Token in subprocess environment:** `ANTHROPIC_AUTH_TOKEN` is stripped from Bash subprocess environments by the sanitization hook in `container/agent-runner/src/index.ts`. If you see it leaking, check that `SECRET_ENV_VARS` includes `'ANTHROPIC_AUTH_TOKEN'`.
