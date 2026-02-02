/**
 * Claude SDK Bridge
 *
 * Spawns `claude -p` with `--output-format stream-json` and parses the JSON event stream.
 * Manages Claude sessions using `--resume` for conversation continuity.
 */

import chalk from 'chalk';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import type { ClaudeQueryParams, ClaudeQueryResult, SDKEvent } from './types.js';

// Debug mode: set TELEGRAM_DEBUG=true or TELEGRAM_DEBUG=1 for verbose logging
const isDebug = process.env.TELEGRAM_DEBUG === 'true' || process.env.TELEGRAM_DEBUG === '1';
const noop = () => {};

const createLogger = (name: string) => ({
  log: isDebug ? (...args: unknown[]) => console.log(chalk.blue(`[${name}]`), ...args) : noop,
  error: (...args: unknown[]) => console.error(chalk.red(`[${name}]`), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow(`[${name}]`), ...args),
  debug: isDebug ? (...args: unknown[]) => console.debug(chalk.gray(`[${name}]`), ...args) : noop,
});

const logger = createLogger('claude-sdk-bridge');

export interface ClaudeSDKBridgeEvents {
  event: (event: SDKEvent) => void;
  error: (error: string) => void;
  exit: (code: number | null) => void;
}

export class ClaudeSDKBridge extends EventEmitter {
  private process: ChildProcess | null = null;

  /**
   * Query Claude with a prompt
   *
   * @param params Query parameters including prompt, session ID, mode, etc.
   * @returns Promise resolving to session ID and error status
   */
  async query(params: ClaudeQueryParams): Promise<ClaudeQueryResult> {
    const args = this.buildArgs(params);
    const queryStartTime = Date.now();

    logger.log(
      `Starting query: session=${params.sessionId || 'new'}, mode=${params.mode}, prompt="${params.prompt.slice(0, 50)}..."`
    );
    logger.log(`Spawning claude with args: ${args.join(' ').slice(0, 100)}...`);

    this.process = spawn('claude', args, {
      cwd: params.workingDir || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Keep stdin open to respond to permission prompts (e.g., AskUserQuestion)
    // stdin will be closed when the process exits

    const pid = this.process.pid;
    logger.log(`Claude process spawned, pid=${pid}`);

    let capturedSessionId = params.sessionId || '';
    let isError = false;

    // Parse newline-delimited JSON from stdout
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on('line', (line) => {
        logger.debug(`[stdout] ${line.slice(0, 200)}`);
        try {
          const event = JSON.parse(line) as SDKEvent;

          // Log events at info level for better visibility
          if (event.type === 'stream_event') {
            const streamEvent = event.event;
            if (
              streamEvent.type === 'content_block_start' &&
              streamEvent.content_block?.type === 'tool_use'
            ) {
              // ALWAYS log tool starts for debugging AskUserQuestion
              console.log(`[telegram] Tool started: ${streamEvent.content_block.name}`);
              logger.log(`Event: content_block_start (tool: ${streamEvent.content_block.name})`);
            } else if (streamEvent.type === 'content_block_stop') {
              logger.log(`Event: content_block_stop`);
            }
            // Don't log every delta to avoid spam
          } else if (event.type === 'result') {
            const elapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
            logger.log(`Event: result, session=${event.session_id}, elapsed=${elapsed}s`);
          } else if (event.type === 'assistant') {
            logger.log(`Event: assistant message received`);
          } else if (event.type === 'error') {
            logger.log(`Event: error - ${event.error?.message || 'unknown'}`);
          }

          this.emit('event', event);

          // Capture session ID from result or assistant message
          if (event.type === 'result' && event.session_id) {
            capturedSessionId = event.session_id;
            isError = event.is_error;
          } else if (event.type === 'assistant' && event.session_id) {
            capturedSessionId = event.session_id;
          }
        } catch (_e) {
          logger.debug(`[non-json] ${line.slice(0, 100)}`);
        }
      });
    }

    // Capture stderr for error messages and handle permission prompts
    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        const errorText = data.toString();

        // Auto-approve AskUserQuestion permission prompt
        // Claude CLI asks "Answer questions?" when this tool is used
        if (errorText.includes('Answer questions?') || errorText.includes('AskUserQuestion')) {
          logger.log('Auto-approving AskUserQuestion permission prompt');
          this.process?.stdin?.write('y\n');
          return; // Don't emit this as an error
        }

        this.emit('error', errorText);
      });
    }

    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Failed to spawn Claude process'));
        return;
      }

      this.process.on('close', (code) => {
        const elapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
        logger.log(
          `Claude process exited, code=${code}, session=${capturedSessionId || 'none'}, elapsed=${elapsed}s`
        );

        // Clean up stdin if still open
        if (this.process?.stdin && !this.process.stdin.destroyed) {
          this.process.stdin.end();
        }

        this.emit('exit', code);
        this.process = null;

        if (code === 0 || capturedSessionId) {
          resolve({ sessionId: capturedSessionId, isError });
        } else {
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      this.process.on('error', (error) => {
        logger.error(`Claude process error: ${error.message}`);
        this.process = null;
        reject(error);
      });
    });
  }

  /**
   * Build command line arguments for Claude
   */
  private buildArgs(params: ClaudeQueryParams): string[] {
    const args = ['-p', params.prompt, '--output-format', 'stream-json', '--verbose'];

    if (params.mode) {
      args.push('--permission-mode', params.mode);
    }

    if (params.sessionId) {
      args.push('--resume', params.sessionId);
    }

    if (params.unsafeMode) {
      args.push('--dangerously-skip-permissions');
    }

    return args;
  }

  /**
   * Cancel the running Claude process
   */
  cancel(): void {
    if (this.process) {
      this.process.kill('SIGINT');
    }
  }

  /**
   * Check if a Claude process is currently running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Send input to the running Claude process (for interactive prompts)
   */
  sendInput(input: string): void {
    if (this.process?.stdin) {
      this.process.stdin.write(input);
    }
  }
}
