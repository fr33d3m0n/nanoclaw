/**
 * Host-side skill-audit handler for IPC bridge.
 *
 * Container agents request full audits via IPC. The host runs skill-audit
 * with its native bwrap sandbox (which cannot work inside Docker due to
 * seccomp restrictions on unshare()). Results are written back to the
 * IPC results directory for the container to read.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CREDENTIAL_PROXY_PORT } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

/** Maximum concurrent skill-audit subprocesses */
const MAX_CONCURRENT_AUDITS = 2;

/** Default subprocess timeout (10 minutes + 30s buffer) */
const DEFAULT_PROCESS_TIMEOUT = 630_000;

/** Maximum output size per stream (10 MB, matches container runner) */
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

/** Track active audits for concurrency control */
let activeAudits = 0;

const VALID_COMMANDS = new Set(['audit', 'scan', 'threat-modeling']);
const VALID_PROFILES = new Set(['light', 'standard', 'heavy']);
const MAX_TIMEOUT_SEC = 1800; // 30 minutes hard cap
const MIN_TIMEOUT_SEC = 30;

export interface SkillAuditRequest {
  type: 'skill_audit';
  requestId: string;
  command?: 'audit' | 'scan' | 'threat-modeling';
  skillPath: string;
  options?: {
    skipDynamic?: boolean;
    skipTm?: boolean;
    full?: boolean;
    enableEmbedding?: boolean;
    timeout?: number;
    sandboxProfile?: 'light' | 'standard' | 'heavy';
  };
}

interface AuditResult {
  requestId: string;
  status: 'success' | 'error';
  exitCode: number;
  result?: unknown;
  error?: string;
  duration: number;
}

/**
 * Resolve a skill path from the IPC request to a safe host-side path.
 *
 * Supported formats:
 *   - "clawhub:<author>/<skill>" — resolves to ~/clawhub-latest/<author>/<skill>
 *   - "<relative-path>"          — resolves within group IPC directory
 */
function resolveSkillPath(
  skillPath: string,
  sourceGroup: string,
  isMain: boolean,
): string | null {
  if (skillPath.startsWith('clawhub:')) {
    if (!isMain) return null;
    const subPath = skillPath.slice('clawhub:'.length);
    // Reject suspicious path components
    if (subPath.includes('..') || subPath.startsWith('/')) return null;
    const homeDir = process.env.HOME || os.homedir();
    const clawhubBase = path.resolve(homeDir, 'clawhub-latest');
    const resolved = path.resolve(clawhubBase, subPath);
    // Ensure resolved path stays within clawhub
    if (!resolved.startsWith(clawhubBase + path.sep)) return null;
    return resolved;
  }

  // Relative path — resolve within group's IPC directory
  if (skillPath.includes('..') || path.isAbsolute(skillPath)) return null;
  const ipcDir = resolveGroupIpcPath(sourceGroup);
  const resolved = path.resolve(ipcDir, skillPath);
  if (!resolved.startsWith(ipcDir + path.sep)) return null;
  return resolved;
}

export async function handleSkillAudit(
  data: SkillAuditRequest,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  // Runtime type guards — IPC JSON is untrusted, TypeScript types don't protect at runtime
  if (
    typeof data.requestId !== 'string' ||
    typeof data.skillPath !== 'string'
  ) {
    logger.warn({ sourceGroup }, 'skill_audit: invalid field types');
    return;
  }

  const rawCommand = data.command ?? 'audit';
  const command = VALID_COMMANDS.has(rawCommand)
    ? (rawCommand as SkillAuditRequest['command'])
    : 'audit';
  const { requestId, skillPath } = data;
  const options =
    data.options && typeof data.options === 'object' ? data.options : {};

  if (!requestId || !skillPath) {
    logger.warn({ sourceGroup }, 'skill_audit: missing requestId or skillPath');
    return;
  }

  // Sanitize requestId for filesystem use
  const safeId = requestId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) {
    logger.warn({ requestId, sourceGroup }, 'skill_audit: invalid requestId');
    return;
  }

  // Concurrency gate
  if (activeAudits >= MAX_CONCURRENT_AUDITS) {
    writeResult(sourceGroup, safeId, {
      requestId,
      status: 'error',
      exitCode: -1,
      error: `Concurrency limit reached (${MAX_CONCURRENT_AUDITS} active audits). Retry later.`,
      duration: 0,
    });
    return;
  }

  // Resolve and validate path
  const resolvedPath = resolveSkillPath(skillPath, sourceGroup, isMain);
  if (!resolvedPath) {
    writeResult(sourceGroup, safeId, {
      requestId,
      status: 'error',
      exitCode: -1,
      error: 'Skill path is outside allowed directories or invalid',
      duration: 0,
    });
    logger.warn(
      { skillPath, sourceGroup },
      'skill_audit: path validation failed',
    );
    return;
  }

  if (!fs.existsSync(resolvedPath)) {
    writeResult(sourceGroup, safeId, {
      requestId,
      status: 'error',
      exitCode: -1,
      error: `Skill path not found: ${skillPath}`,
      duration: 0,
    });
    return;
  }

  // Clamp caller-supplied timeout to safe bounds
  const cliTimeoutSec =
    typeof options.timeout === 'number' && options.timeout > 0
      ? Math.min(Math.max(options.timeout, MIN_TIMEOUT_SEC), MAX_TIMEOUT_SEC)
      : 600;

  // Build CLI arguments
  const args: string[] = [];
  switch (command) {
    case 'scan':
      args.push('scan', resolvedPath);
      break;
    case 'threat-modeling':
      args.push('threat-modeling', resolvedPath);
      break;
    case 'audit':
    default:
      args.push('audit', resolvedPath);
      if (options.skipDynamic === true) args.push('--skip-dynamic');
      if (options.skipTm === true) args.push('--skip-tm');
      if (options.full === true) args.push('--full');
      if (options.enableEmbedding === true) args.push('--enable-embedding');
      if (
        typeof options.sandboxProfile === 'string' &&
        VALID_PROFILES.has(options.sandboxProfile)
      ) {
        args.push('--sandbox-profile', options.sandboxProfile);
      }
      args.push('--timeout', String(cliTimeoutSec));
      break;
  }

  // Process timeout = CLI timeout + buffer
  const processTimeout = Math.max(
    cliTimeoutSec * 1000 + 30_000,
    DEFAULT_PROCESS_TIMEOUT,
  );

  logger.info(
    { requestId: safeId, command, sourceGroup },
    'skill_audit: starting',
  );
  logger.debug(
    { requestId: safeId, resolvedPath },
    'skill_audit: resolved path',
  );

  activeAudits++;
  const startTime = Date.now();

  try {
    const result = await runSkillAudit(args, processTimeout);
    const duration = Date.now() - startTime;

    writeResult(sourceGroup, safeId, {
      requestId,
      status:
        result.exitCode >= 0 && result.exitCode <= 3 ? 'success' : 'error',
      exitCode: result.exitCode,
      result: result.stdout ? tryParseJson(result.stdout) : null,
      error: result.exitCode > 3 ? result.stderr : undefined,
      duration,
    });

    logger.info(
      { requestId: safeId, exitCode: result.exitCode, duration, sourceGroup },
      'skill_audit: completed',
    );
  } catch (err) {
    const duration = Date.now() - startTime;
    writeResult(sourceGroup, safeId, {
      requestId,
      status: 'error',
      exitCode: -1,
      error: err instanceof Error ? err.message : String(err),
      duration,
    });
    logger.error(
      { requestId: safeId, err, sourceGroup },
      'skill_audit: failed',
    );
  } finally {
    activeAudits--;
  }
}

function runSkillAudit(
  args: string[],
  timeout: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Minimal env allowlist — never spread process.env (secrets would leak).
    // Same isolation model as containers: only credential proxy endpoint.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? os.homedir(),
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${CREDENTIAL_PROXY_PORT}`,
      ANTHROPIC_API_KEY: 'placeholder',
    };

    let proc: ChildProcess;
    try {
      proc = spawn('skill-audit', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      reject(
        new Error(
          `Failed to spawn skill-audit: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    proc.stdout!.on('data', (data: Buffer) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      if (stdout.length + chunk.length > MAX_OUTPUT_SIZE) {
        stdout += chunk.slice(0, MAX_OUTPUT_SIZE - stdout.length);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
    });
    proc.stderr!.on('data', (data: Buffer) => {
      if (stderrTruncated) return;
      const chunk = data.toString();
      if (stderr.length + chunk.length > MAX_OUTPUT_SIZE) {
        stderr += chunk.slice(0, MAX_OUTPUT_SIZE - stderr.length);
        stderrTruncated = true;
      } else {
        stderr += chunk;
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 5000);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function writeResult(
  sourceGroup: string,
  safeId: string,
  result: AuditResult,
): void {
  const ipcDir = resolveGroupIpcPath(sourceGroup);
  const resultsDir = path.join(ipcDir, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  // Atomic write: tmp → rename prevents container reading partial JSON
  const resultFile = path.join(resultsDir, `${safeId}.json`);
  const tmpFile = resultFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(result, null, 2));
  fs.renameSync(tmpFile, resultFile);
}

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
