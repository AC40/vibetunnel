/**
 * Output Formatter
 *
 * Formats Claude SDK JSON events into Telegram messages.
 * Handles batching and truncation for Telegram's message limits.
 */

import chalk from 'chalk';
import { EventEmitter } from 'events';
import { detectInteractiveOptions } from './option-detector.js';
import type {
  ClaudeQuestion,
  InteractiveOption,
  SDKEvent,
  TelegramAction,
  VerbosityLevel,
} from './types.js';

// Debug mode: set TELEGRAM_DEBUG=true or TELEGRAM_DEBUG=1 for verbose logging
const isDebug = process.env.TELEGRAM_DEBUG === 'true' || process.env.TELEGRAM_DEBUG === '1';
const noop = () => {};

const createLogger = (name: string) => ({
  log: isDebug ? (...args: unknown[]) => console.log(chalk.blue(`[${name}]`), ...args) : noop,
  error: (...args: unknown[]) => console.error(chalk.red(`[${name}]`), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow(`[${name}]`), ...args),
  debug: isDebug ? (...args: unknown[]) => console.debug(chalk.gray(`[${name}]`), ...args) : noop,
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
  private toolInputBuffer = ''; // Accumulate tool input JSON
  private lastTextBlockStart = 0; // Track where last text block started
  private batchTimeout: NodeJS.Timeout | null = null;
  private verbosity: VerbosityLevel = 'normal';
  private sessionEmoji: string | null = null; // Session emoji to append to messages

  /**
   * Set verbosity level
   */
  setVerbosity(level: VerbosityLevel): void {
    this.verbosity = level;
    logger.log(`Verbosity set to: ${level}`);
  }

  /**
   * Get current verbosity level
   */
  getVerbosity(): VerbosityLevel {
    return this.verbosity;
  }

  /**
   * Set session emoji to append to messages
   */
  setSessionEmoji(emoji: string | null): void {
    this.sessionEmoji = emoji;
    if (emoji) {
      logger.log(`Session emoji set to: ${emoji}`);
    }
  }

  /**
   * Get current session emoji
   */
  getSessionEmoji(): string | null {
    return this.sessionEmoji;
  }

  /**
   * Handle an SDK event from Claude
   */
  handleEvent(event: SDKEvent): TelegramAction | null {
    logger.debug(`[formatter] Received event type: ${event.type}`);

    let action: TelegramAction | null = null;

    if (event.type === 'stream_event') {
      const e = event.event;

      if (e.type === 'content_block_start') {
        if (e.content_block.type === 'tool_use') {
          this.currentTool = e.content_block.name || 'unknown tool';
          this.toolInputBuffer = ''; // Reset for new tool
          logger.log(`Tool started: ${this.currentTool}`);
          // Only show tool status in normal or verbose mode
          if (this.verbosity !== 'minimal') {
            action = { type: 'status', text: `🔧 Using ${this.currentTool}...` };
          }
        } else if (e.content_block.type === 'text') {
          // Track where this text block starts for option detection
          this.lastTextBlockStart = this.textBuffer.length;
        }
      } else if (e.type === 'content_block_delta') {
        if (e.delta.type === 'text_delta') {
          this.textBuffer += e.delta.text;
          this.scheduleBatchSend();
        } else if (e.delta.type === 'input_json_delta' && this.currentTool) {
          // Accumulate tool input JSON
          this.toolInputBuffer += e.delta.partial_json;
        }
      } else if (e.type === 'content_block_stop' && this.currentTool) {
        logger.log(`Tool stopped: ${this.currentTool}`);
        // Process completed tool input before clearing
        this.processToolInput(this.currentTool, this.toolInputBuffer);
        this.currentTool = null;
        this.toolInputBuffer = '';
        // Only clear status in normal or verbose mode
        if (this.verbosity !== 'minimal') {
          action = { type: 'clear_status' };
        }
      }
    } else if (event.type === 'assistant' && event.message?.content) {
      // Extract text content from assistant message
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          this.textBuffer += block.text;
        } else if (block.type === 'tool_use' && block.name && block.input) {
          // Process tool_use blocks (e.g., AskUserQuestion)
          this.processToolInput(block.name, JSON.stringify(block.input));
        }
      }
      this.scheduleBatchSend();
    } else if (event.type === 'result') {
      // Flush any remaining text
      this.flushBuffer();
      const readyText = this.sessionEmoji
        ? `✅ Claude is ready for input ${this.sessionEmoji}`
        : '✅ Claude is ready for input';
      action = { type: 'notification', text: readyText };
    } else if (event.type === 'error') {
      action = { type: 'message', text: `❌ Error: ${event.error.message}` };
    }

    if (action) {
      logger.log(
        `Emitting action: ${action.type}${action.type === 'message' ? ` (${action.text.length} chars)` : ''}`
      );
    }

    return action;
  }

  /**
   * Process completed tool input and extract meaningful content
   */
  private processToolInput(toolName: string, inputJson: string): void {
    // ALWAYS log tool completions for debugging AskUserQuestion
    console.log(`[telegram] Tool completed: ${toolName}`);

    if (!inputJson) {
      console.log(`[telegram] Tool ${toolName} has no input JSON`);
      return;
    }

    try {
      const input = JSON.parse(inputJson);

      // Special logging for AskUserQuestion
      if (toolName === 'AskUserQuestion') {
        console.log(`[telegram] AskUserQuestion detected!`);
        console.log(`[telegram] Input:`, JSON.stringify(input, null, 2).slice(0, 500));

        if (input.questions && Array.isArray(input.questions)) {
          const questions = input.questions as ClaudeQuestion[];
          console.log(`[telegram] Emitting user_question with ${questions.length} question(s)`);
          this.emit('action', {
            type: 'user_question',
            questions,
          });
          return;
        } else {
          console.log(`[telegram] AskUserQuestion missing questions array!`);
        }
      }

      // For Write tool, check if it's a plan file
      if (toolName === 'Write' && input.content) {
        const filePath = input.file_path || '';
        const isPlan =
          filePath.includes('/plans/') ||
          filePath.endsWith('plan.md') ||
          filePath.includes('-plan.md');

        if (isPlan) {
          const fileName = filePath.split('/').pop() || 'plan.md';
          logger.log(`Detected plan file: ${fileName} (${input.content.length} chars)`);

          // Send plan as a document with isPlan flag for approval workflow
          this.emit('action', {
            type: 'document',
            content: input.content,
            fileName,
            caption: '📋 Plan',
            isPlan: true,
          });
        } else if (this.verbosity === 'verbose') {
          // In verbose mode, show previews of written content
          const preview = input.content.slice(0, 200);
          const fileName = filePath.split('/').pop() || 'file';
          logger.log(`Write preview: ${fileName}`);
          this.emit('action', {
            type: 'message',
            text: `📝 Writing to ${fileName}:\n\`\`\`\n${preview}${input.content.length > 200 ? '...' : ''}\n\`\`\``,
          });
        }
      }

      // For Edit tool in verbose mode, show what's being changed
      if (toolName === 'Edit' && this.verbosity === 'verbose' && input.new_string) {
        const filePath = input.file_path || '';
        const fileName = filePath.split('/').pop() || 'file';
        const preview = input.new_string.slice(0, 100);
        logger.log(`Edit preview: ${fileName}`);
        this.emit('action', {
          type: 'message',
          text: `✏️ Editing ${fileName}:\n\`\`\`\n${preview}${input.new_string.length > 100 ? '...' : ''}\n\`\`\``,
        });
      }
    } catch (_e) {
      // Invalid JSON, ignore - this happens during streaming
      logger.debug('Failed to parse tool input JSON (expected during streaming)');
    }
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

    let text = this.formatForTelegram(this.textBuffer);

    // Append session emoji if set
    if (this.sessionEmoji) {
      text = `${text} ${this.sessionEmoji}`;
    }

    // Only detect options in the LAST text block to avoid merging multiple option groups
    const textToScanForOptions = this.textBuffer.slice(this.lastTextBlockStart);
    const options = detectInteractiveOptions(textToScanForOptions);

    logger.log(
      `Flushing buffer: ${text.length} chars${options ? `, ${options.length} options` : ''}`
    );
    this.emit('action', { type: 'message', text, options: options || undefined });
    this.textBuffer = '';
    this.lastTextBlockStart = 0; // Reset for next message
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
