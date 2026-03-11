import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock child_process before importing the module
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  ChildProcess: vi.fn(),
  exec: vi.fn(),
}));

// Mock config
vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupIpcPath: (folder: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}`,
  isValidGroupFolder: () => true,
  assertValidGroupFolder: () => {},
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleSkillAudit, SkillAuditRequest } from './skill-audit-handler.js';
import { EventEmitter } from 'events';

function createMockProcess(exitCode = 0, stdout = '{}', stderr = '') {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });

  // Emit data and close asynchronously
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  }, 10);

  return proc;
}

describe('skill-audit-handler', () => {
  const testGroup = 'test-group';
  const ipcDir = `/tmp/nanoclaw-test-data/ipc/${testGroup}`;

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(path.join(ipcDir, 'results'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync('/tmp/nanoclaw-test-data', { recursive: true, force: true });
  });

  it('rejects missing requestId', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: '',
        skillPath: 'test',
      } as SkillAuditRequest,
      testGroup,
      false,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects missing skillPath', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test-1',
        skillPath: '',
      } as SkillAuditRequest,
      testGroup,
      false,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects absolute skill paths', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test-abs',
        skillPath: '/etc/passwd',
      } as SkillAuditRequest,
      testGroup,
      false,
    );

    const resultFile = path.join(ipcDir, 'results', 'test-abs.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('outside allowed directories');
  });

  it('rejects path traversal attempts', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test-traversal',
        skillPath: '../../../etc/passwd',
      } as SkillAuditRequest,
      testGroup,
      false,
    );

    const resultFile = path.join(ipcDir, 'results', 'test-traversal.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('outside allowed directories');
  });

  it('rejects clawhub paths for non-main groups', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test-clawhub',
        skillPath: 'clawhub:author/skill',
      } as SkillAuditRequest,
      testGroup,
      false, // not main
    );

    const resultFile = path.join(ipcDir, 'results', 'test-clawhub.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('outside allowed directories');
  });

  it('rejects clawhub path traversal', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test-clawhub-trav',
        skillPath: 'clawhub:../../etc/passwd',
      } as SkillAuditRequest,
      testGroup,
      true, // main
    );

    const resultFile = path.join(ipcDir, 'results', 'test-clawhub-trav.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('outside allowed directories');
  });

  it('writes error when skill path does not exist', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test-noexist',
        skillPath: 'audit-input/nonexistent',
      } as SkillAuditRequest,
      testGroup,
      false,
    );

    const resultFile = path.join(ipcDir, 'results', 'test-noexist.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('spawns skill-audit for valid audit request', async () => {
    // Create a fake skill directory within the IPC dir
    const skillDir = path.join(ipcDir, 'audit-input', 'req1');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    const resultJson = JSON.stringify({
      verdict: { combined_level: 'SAFE', combined_score: 95 },
    });
    mockSpawn.mockReturnValue(createMockProcess(0, resultJson));

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req1',
        command: 'audit',
        skillPath: 'audit-input/req1',
        options: { skipDynamic: true },
      },
      testGroup,
      false,
    );

    // Verify spawn was called correctly
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('skill-audit');
    expect(args).toContain('audit');
    expect(args).toContain(skillDir);
    expect(args).toContain('--skip-dynamic');

    // Verify env uses allowlist (not ...process.env)
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3001');
    expect(opts.env.ANTHROPIC_API_KEY).toBe('placeholder');
    expect(opts.env.PATH).toBeDefined();
    expect(opts.env.HOME).toBeDefined();
    // Should NOT contain arbitrary process.env keys
    const envKeys = new Set(Object.keys(opts.env));
    expect(envKeys.size).toBeLessThanOrEqual(10); // allowlist is small

    // Verify result was written
    const resultFile = path.join(ipcDir, 'results', 'req1.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.result.verdict.combined_level).toBe('SAFE');
  });

  it('builds correct args for scan command', async () => {
    const skillDir = path.join(ipcDir, 'audit-input', 'req-scan');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    mockSpawn.mockReturnValue(createMockProcess(0, '{}'));

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req-scan',
        command: 'scan',
        skillPath: 'audit-input/req-scan',
      },
      testGroup,
      false,
    );

    const [, args] = mockSpawn.mock.calls[0];
    expect(args[0]).toBe('scan');
    expect(args[1]).toBe(skillDir);
  });

  it('handles non-zero exit code as success for codes 0-3', async () => {
    const skillDir = path.join(ipcDir, 'audit-input', 'req-caution');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    mockSpawn.mockReturnValue(createMockProcess(1, '{"verdict":"CAUTION"}'));

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req-caution',
        skillPath: 'audit-input/req-caution',
      },
      testGroup,
      false,
    );

    const resultFile = path.join(ipcDir, 'results', 'req-caution.json');
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    // Exit codes 0-3 are valid skill-audit verdicts, not errors
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(1);
  });

  it('sanitizes requestId for filesystem safety', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'test/../../../evil',
        skillPath: 'test',
      } as SkillAuditRequest,
      testGroup,
      false,
    );

    // Should use sanitized ID (strips non-alphanumeric)
    const sanitized = 'testevil';
    const resultFile = path.join(ipcDir, 'results', `${sanitized}.json`);
    expect(fs.existsSync(resultFile)).toBe(true);
  });

  it('rejects non-string requestId and skillPath', async () => {
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 123,
        skillPath: ['bad'],
      } as unknown as SkillAuditRequest,
      testGroup,
      false,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('falls back to audit for invalid command', async () => {
    const skillDir = path.join(ipcDir, 'audit-input', 'req-badcmd');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    mockSpawn.mockReturnValue(createMockProcess(0, '{}'));

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req-badcmd',
        command: 'batch' as 'audit', // invalid via IPC
        skillPath: 'audit-input/req-badcmd',
      },
      testGroup,
      false,
    );

    const [, args] = mockSpawn.mock.calls[0];
    expect(args[0]).toBe('audit'); // falls back to audit
  });

  it('clamps excessive timeout to MAX_TIMEOUT_SEC', async () => {
    const skillDir = path.join(ipcDir, 'audit-input', 'req-timeout');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    mockSpawn.mockReturnValue(createMockProcess(0, '{}'));

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req-timeout',
        skillPath: 'audit-input/req-timeout',
        options: { timeout: 999999 },
      },
      testGroup,
      false,
    );

    const [, args] = mockSpawn.mock.calls[0];
    // Should be clamped to 1800 (MAX_TIMEOUT_SEC)
    const timeoutIdx = args.indexOf('--timeout');
    expect(timeoutIdx).toBeGreaterThan(-1);
    expect(Number(args[timeoutIdx + 1])).toBeLessThanOrEqual(1800);
  });

  it('rejects invalid sandboxProfile values', async () => {
    const skillDir = path.join(ipcDir, 'audit-input', 'req-profile');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    mockSpawn.mockReturnValue(createMockProcess(0, '{}'));

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req-profile',
        skillPath: 'audit-input/req-profile',
        options: { sandboxProfile: 'evil' as 'standard' },
      },
      testGroup,
      false,
    );

    const [, args] = mockSpawn.mock.calls[0];
    // --sandbox-profile should NOT appear with invalid value
    expect(args).not.toContain('--sandbox-profile');
  });

  it('handles spawn error gracefully', async () => {
    const skillDir = path.join(ipcDir, 'audit-input', 'req-spawnerr');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# test');

    // Mock spawn to emit error
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = vi.fn();
    mockSpawn.mockReturnValue(proc);

    // Emit error asynchronously
    setTimeout(
      () => proc.emit('error', new Error('ENOENT: skill-audit not found')),
      10,
    );

    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'req-spawnerr',
        skillPath: 'audit-input/req-spawnerr',
      },
      testGroup,
      false,
    );

    const resultFile = path.join(ipcDir, 'results', 'req-spawnerr.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('skill-audit not found');
  });

  it('enforces concurrency limit', async () => {
    // Create two skill dirs
    for (const id of ['conc1', 'conc2', 'conc3']) {
      const dir = path.join(ipcDir, 'audit-input', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '# test');
    }

    // Create slow processes that don't resolve immediately
    const makeSlowProc = () => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        kill: ReturnType<typeof vi.fn>;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.kill = vi.fn();
      return proc;
    };

    const slowProc1 = makeSlowProc();
    const slowProc2 = makeSlowProc();
    mockSpawn.mockReturnValueOnce(slowProc1).mockReturnValueOnce(slowProc2);

    // Launch 2 concurrent audits (fill slots)
    const p1 = handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'conc1',
        skillPath: 'audit-input/conc1',
      },
      testGroup,
      false,
    );
    const p2 = handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'conc2',
        skillPath: 'audit-input/conc2',
      },
      testGroup,
      false,
    );

    // Give the event loop a tick for both to register
    await new Promise((r) => setTimeout(r, 5));

    // Third request should be rejected immediately
    await handleSkillAudit(
      {
        type: 'skill_audit',
        requestId: 'conc3',
        skillPath: 'audit-input/conc3',
      },
      testGroup,
      false,
    );

    const resultFile = path.join(ipcDir, 'results', 'conc3.json');
    expect(fs.existsSync(resultFile)).toBe(true);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    expect(result.status).toBe('error');
    expect(result.error).toContain('Concurrency limit');

    // Clean up: resolve the slow processes
    slowProc1.stdout.emit('data', Buffer.from('{}'));
    slowProc1.emit('close', 0);
    slowProc2.stdout.emit('data', Buffer.from('{}'));
    slowProc2.emit('close', 0);
    await Promise.all([p1, p2]);
  });
});
