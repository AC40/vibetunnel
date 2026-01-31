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

// Create a simple logger
const createLogger = (name: string) => ({
  log: (...args: unknown[]) => console.log(chalk.blue(`[${name}]`), ...args),
  error: (...args: unknown[]) => console.error(chalk.red(`[${name}]`), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow(`[${name}]`), ...args),
  debug: (...args: unknown[]) => console.debug(chalk.gray(`[${name}]`), ...args),
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

    this.process = spawn('claude', args, {
      cwd: params.workingDir || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let capturedSessionId = params.sessionId || '';
    let isError = false;

    // Parse newline-delimited JSON from stdout
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on('line', (line) => {
        logger.debug(`[stdout] ${line.slice(0, 200)}`);
        try {
          const event = JSON.parse(line) as SDKEvent;
          logger.debug(`[event] type=${event.type}`);
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

    // Capture stderr for error messages
    if (this.process.stderr) {
      this.process.stderr.on('data', (data: Buffer) => {
        const errorText = data.toString();
        this.emit('error', errorText);
      });
    }

    return new Promise((resolve, reject) => {
      if (!this.process) {
        reject(new Error('Failed to spawn Claude process'));
        return;
      }

      this.process.on('close', (code) => {
        this.emit('exit', code);
        this.process = null;

        if (code === 0 || capturedSessionId) {
          resolve({ sessionId: capturedSessionId, isError });
        } else {
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      this.process.on('error', (error) => {
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
