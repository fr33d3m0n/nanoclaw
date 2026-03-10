/**
 * CLI Channel - Virtual channel for Claude Code skill integration.
 *
 * Implements file-based IPC for communication between the NanoClaw service
 * and external CLI tools. Supports multi-session management.
 *
 * Uses the channel registry self-registration pattern.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import {
  listCLISessions,
  getCurrentCLISessionId,
  getCurrentCLISession,
  selectCLISession,
  createCLISession,
  updateCLISession,
  endCurrentCLISession,
  CLISessionInfo,
} from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, NewMessage } from '../types.js';

const CLI_INPUT_DIR = path.join(DATA_DIR, 'ipc', 'cli', 'input');
const CLI_OUTPUT_DIR = path.join(DATA_DIR, 'ipc', 'cli', 'output');
const POLL_INTERVAL_MS = 100;

// Request types
export interface CLIRequest {
  id: string;
  type:
    | 'message'
    | 'list_sessions'
    | 'select_session'
    | 'end_session'
    | 'status';
  timestamp: string;
  text?: string;
  options?: {
    sessionId?: string;
    newSession?: boolean;
  };
  sessionId?: string; // for select_session
}

// Response types
export interface CLIResponse {
  id: string;
  status: 'success' | 'error';
  timestamp: string;
  result?: string;
  sessionId?: string;
  sessions?: CLISessionInfo[];
  currentSession?: CLISessionInfo;
  error?: string;
}

/**
 * CLI Channel implementation.
 *
 * Uses file-based IPC:
 * - Input: JSON files in data/ipc/cli/input/
 * - Output: JSON files in data/ipc/cli/output/
 *
 * Request types:
 * - message: Send a message to the agent
 * - list_sessions: List all CLI sessions
 * - select_session: Switch to a specific session
 * - end_session: End the current session
 * - status: Get current session status
 */
export class CLIChannel implements Channel {
  name = 'cli';
  private connected = false;
  private opts: ChannelOpts;
  private watchInterval: NodeJS.Timeout | null = null;
  // Track request ID correlation: NewMessage.id -> CLI request.id
  private requestCorrelation = new Map<string, string>();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Ensure directories exist
    fs.mkdirSync(CLI_INPUT_DIR, { recursive: true });
    fs.mkdirSync(CLI_OUTPUT_DIR, { recursive: true });

    this.connected = true;

    // Register CLI group metadata
    this.opts.onChatMetadata(
      'cli:default',
      new Date().toISOString(),
      'CLI',
      'cli',
      false,
    );

    // Start polling for input
    this.startPolling();

    logger.info('CLI channel connected, polling for input');
  }

  private startPolling(): void {
    this.watchInterval = setInterval(() => {
      this.pollInputDir();
    }, POLL_INTERVAL_MS);
  }

  private pollInputDir(): void {
    if (!this.connected) return;

    try {
      const files = fs
        .readdirSync(CLI_INPUT_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort();

      for (const file of files) {
        this.processInputFile(file);
      }
    } catch (err) {
      logger.debug({ err }, 'Error polling CLI input dir');
    }
  }

  private processInputFile(filename: string): void {
    const filepath = path.join(CLI_INPUT_DIR, filename);

    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      const request: CLIRequest = JSON.parse(content);

      // Delete processed input file
      fs.unlinkSync(filepath);

      // Handle based on request type
      switch (request.type) {
        case 'message':
          this.handleMessage(request);
          break;
        case 'list_sessions':
          this.handleListSessions(request);
          break;
        case 'select_session':
          this.handleSelectSession(request);
          break;
        case 'end_session':
          this.handleEndSession(request);
          break;
        case 'status':
          this.handleStatus(request);
          break;
        default:
          this.writeError(
            request.id,
            `Unknown request type: ${(request as any).type}`,
          );
      }

      logger.debug(
        { requestId: request.id, type: request.type },
        'CLI request processed',
      );
    } catch (err) {
      logger.warn({ err, filename }, 'Failed to process CLI input file');
    }
  }

  private handleMessage(request: CLIRequest): void {
    if (!request.text) {
      this.writeError(request.id, 'Message text is required');
      return;
    }

    // Handle session options
    if (request.options?.newSession) {
      endCurrentCLISession();
    } else if (request.options?.sessionId) {
      selectCLISession(request.options.sessionId);
    }

    // Construct message with unique ID for correlation
    const messageId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.requestCorrelation.set(messageId, request.id);

    const msg: NewMessage = {
      id: messageId,
      chat_jid: 'cli:default',
      sender: 'user',
      sender_name: 'User',
      content: request.text,
      timestamp: request.timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    // Trigger message processing
    this.opts.onMessage('cli:default', msg);
  }

  private handleListSessions(request: CLIRequest): void {
    const sessions = listCLISessions();
    const currentId = getCurrentCLISessionId();

    const sessionInfos = sessions.map((s) => ({
      ...s,
      isCurrent: s.sdkSessionId === currentId,
    }));

    this.writeResponse(request.id, { sessions: sessionInfos });
  }

  private handleSelectSession(request: CLIRequest): void {
    if (!request.sessionId) {
      this.writeError(request.id, 'Session ID is required');
      return;
    }

    const session = selectCLISession(request.sessionId);
    if (!session) {
      this.writeError(request.id, `Session not found: ${request.sessionId}`);
      return;
    }

    this.writeResponse(request.id, {
      currentSession: session,
      result: `Switched to session ${session.id}`,
      sessionId: session.sdkSessionId,
    });
  }

  private handleEndSession(request: CLIRequest): void {
    const ended = endCurrentCLISession();
    if (!ended) {
      this.writeError(request.id, 'No active session to end');
      return;
    }

    this.writeResponse(request.id, {
      result: `Session ${ended.id} ended and archived`,
    });
  }

  private handleStatus(request: CLIRequest): void {
    const currentSession = getCurrentCLISession();
    this.writeResponse(request.id, { currentSession });
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.connected) {
      throw new Error('CLI channel not connected');
    }

    // Find the CLI request ID from the correlation map
    let requestId = `response-${Date.now()}`;
    for (const [msgId, reqId] of this.requestCorrelation) {
      requestId = reqId;
      this.requestCorrelation.delete(msgId);
      break; // Use the oldest pending request
    }

    const currentSession = getCurrentCLISession();

    this.writeResponseForRequest(requestId, text, currentSession?.sdkSessionId);
  }

  writeResponseForRequest(
    requestId: string,
    text: string,
    sdkSessionId?: string,
  ): void {
    if (sdkSessionId) {
      const existing = listCLISessions().find(
        (s) => s.sdkSessionId === sdkSessionId,
      );
      if (!existing) {
        createCLISession(sdkSessionId);
      } else {
        updateCLISession(sdkSessionId, {
          messageCount: existing.messageCount + 1,
        });
      }
    }

    this.writeResponse(requestId, {
      result: text,
      sessionId: sdkSessionId,
    });
  }

  syncSession(sdkSessionId: string): void {
    const existing = listCLISessions().find(
      (s) => s.sdkSessionId === sdkSessionId,
    );
    if (!existing) {
      createCLISession(sdkSessionId);
    } else {
      updateCLISession(sdkSessionId, {
        messageCount: existing.messageCount + 1,
      });
    }
  }

  private writeResponse(requestId: string, data: Partial<CLIResponse>): void {
    const responseFile = path.join(CLI_OUTPUT_DIR, `${requestId}.json`);

    const response: CLIResponse = {
      id: requestId,
      status: 'success',
      timestamp: new Date().toISOString(),
      ...data,
    };

    // Use write-then-rename for atomicity
    const tempFile = `${responseFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(response, null, 2));
    fs.renameSync(tempFile, responseFile);

    logger.debug({ requestId, responseFile }, 'CLI response written');
  }

  private writeError(requestId: string, error: string): void {
    const responseFile = path.join(CLI_OUTPUT_DIR, `${requestId}.json`);

    const response: CLIResponse = {
      id: requestId,
      status: 'error',
      error,
      timestamp: new Date().toISOString(),
    };

    const tempFile = `${responseFile}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(response, null, 2));
    fs.renameSync(tempFile, responseFile);

    logger.debug({ requestId, error }, 'CLI error response written');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
    }
    logger.info('CLI channel disconnected');
  }
}

// Self-register CLI channel.
// CLI has no credentials requirement — always available when installed.
registerChannel('cli', (opts: ChannelOpts) => {
  return new CLIChannel(opts);
});
