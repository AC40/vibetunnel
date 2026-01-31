/**
 * Output Formatter
 *
 * Formats Claude SDK JSON events into Telegram messages.
 * Handles batching and truncation for Telegram's message limits.
 */

import chalk from 'chalk';
import { EventEmitter } from 'events';
import { detectInteractiveOptions } from './option-detector.js';
import type { InteractiveOption, SDKEvent, TelegramAction } from './types.js';

// Create a simple logger
const createLogger = (name: string) => ({
  log: (...args: unknown[]) => console.log(chalk.blue(`[${name}]`), ...args),
  error: (...args: unknown[]) => console.error(chalk.red(`[${name}]`), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow(`[${name}]`), ...args),
  debug: (...args: unknown[]) => console.debug(chalk.gray(`[${name}]`), ...args),
});

const logger = createLogger('output-formatter');

const TELEGRAM_MAX_LENGTH = 4000; // Telegram limit is 4096, leave some margin
const BATCH_DELAY_MS = 500;

export interface OutputFormatterEvents {
  action: (action: TelegramAction) => void;
}

export class OutputFormatter extends EventEmitter {
  private textBuffer = '';
  private currentTool: string | null = null;
  private batchTimeout: NodeJS.Timeout | null = null;

  /**
   * Handle an SDK event from Claude
   */
  handleEvent(event: SDKEvent): TelegramAction | null {
    logger.debug(`[formatter] Received event type: ${event.type}`);

    let action: TelegramAction | null = null;

    if (event.type === 'stream_event') {
      const e = event.event;

      if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') {
        this.currentTool = e.content_block.name || 'unknown tool';
        action = { type: 'status', text: `🔧 Using ${this.currentTool}...` };
      } else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
        this.textBuffer += e.delta.text;
        this.scheduleBatchSend();
      } else if (e.type === 'content_block_stop' && this.currentTool) {
        this.currentTool = null;
        action = { type: 'clear_status' };
      }
    } else if (event.type === 'assistant' && event.message?.content) {
      // Extract text content from assistant message
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          this.textBuffer += block.text;
        }
      }
      this.scheduleBatchSend();
    } else if (event.type === 'result') {
      // Flush any remaining text
      this.flushBuffer();
      action = { type: 'notification', text: '✅ Claude is ready for input' };
    } else if (event.type === 'error') {
      action = { type: 'message', text: `❌ Error: ${event.error.message}` };
    }

    if (action) {
      logger.debug(`[formatter] Emitting action: ${action.type}`);
    }

    return action;
  }

  /**
   * Schedule a batched send of accumulated text
   */
  private scheduleBatchSend(): void {
    if (this.batchTimeout) return;

    this.batchTimeout = setTimeout(() => {
      this.flushBuffer();
      this.batchTimeout = null;
    }, BATCH_DELAY_MS);
  }

  /**
   * Flush the text buffer and emit a message
   */
  private flushBuffer(): void {
    if (!this.textBuffer) return;

    const text = this.formatForTelegram(this.textBuffer);
    const options = detectInteractiveOptions(this.textBuffer);

    this.emit('action', { type: 'message', text, options: options || undefined });
    this.textBuffer = '';
  }

  /**
   * Format text for Telegram
   * - Truncate to max length
   * - Clean up any formatting issues
   */
  private formatForTelegram(text: string): string {
    // Clean up text
    let cleaned = text.trim();

    // Truncate if too long
    if (cleaned.length > TELEGRAM_MAX_LENGTH) {
      cleaned = `...${cleaned.slice(-(TELEGRAM_MAX_LENGTH - 3))}`;
    }

    return cleaned;
  }

  /**
   * Get detected options from the current buffer
   */
  getBufferedOptions(): InteractiveOption[] | null {
    return detectInteractiveOptions(this.textBuffer);
  }

  /**
   * Clear the buffer without sending
   */
  clearBuffer(): void {
    this.textBuffer = '';
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
  }

  /**
   * Check if there's pending content
   */
  hasPendingContent(): boolean {
    return this.textBuffer.length > 0;
  }

  /**
   * Get current tool being used
   */
  getCurrentTool(): string | null {
    return this.currentTool;
  }

  /**
   * Force flush the buffer and return the text (for exit handling)
   * Returns the formatted text or null if buffer is empty
   */
  forceFlush(): string | null {
    if (!this.textBuffer) return null;

    // Clear any pending batch timeout
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    const text = this.formatForTelegram(this.textBuffer);
    this.textBuffer = '';

    logger.debug(`[formatter] Force flushed buffer, ${text.length} chars`);
    return text;
  }
}
