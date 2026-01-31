/**
 * Output Formatter
 *
 * Formats Claude SDK JSON events into Telegram messages.
 * Handles batching and truncation for Telegram's message limits.
 */

import { EventEmitter } from 'events';
import { detectInteractiveOptions } from './option-detector.js';
import type { InteractiveOption, SDKEvent, TelegramAction } from './types.js';

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
    if (event.type === 'stream_event') {
      const e = event.event;

      if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') {
        this.currentTool = e.content_block.name || 'unknown tool';
        return { type: 'status', text: `🔧 Using ${this.currentTool}...` };
      }

      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
        this.textBuffer += e.delta.text;
        this.scheduleBatchSend();
        return null;
      }

      if (e.type === 'content_block_stop' && this.currentTool) {
        this.currentTool = null;
        return { type: 'clear_status' };
      }
    }

    if (event.type === 'assistant' && event.message?.content) {
      // Extract text content from assistant message
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          this.textBuffer += block.text;
        }
      }
      this.scheduleBatchSend();
      return null;
    }

    if (event.type === 'result') {
      // Flush any remaining text
      this.flushBuffer();
      return { type: 'notification', text: '✅ Claude is ready for input' };
    }

    if (event.type === 'error') {
      return { type: 'message', text: `❌ Error: ${event.error.message}` };
    }

    return null;
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
      cleaned = '...' + cleaned.slice(-(TELEGRAM_MAX_LENGTH - 3));
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
}
