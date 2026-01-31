/**
 * TypeScript interfaces for Telegram Bot Integration
 */

/**
 * Permission modes for Claude Code (--permission-mode flag values)
 */
export type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'default' | 'delegate' | 'dontAsk' | 'plan';

/**
 * All valid permission modes for validation
 */
export const VALID_PERMISSION_MODES: PermissionMode[] = [
  'acceptEdits',
  'bypassPermissions',
  'default',
  'delegate',
  'dontAsk',
  'plan',
];

/**
 * User session tracking Telegram user → Claude session mapping
 */
export interface UserSession {
  telegramUserId: number;
  claudeSessionId: string;
  currentMode: PermissionMode;
  workingDir: string;
  unsafeMode: boolean;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * Configuration for the Telegram bot service
 */
export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUsers?: number[];
  allowUnsafeMode?: boolean;
}

/**
 * Parameters for querying Claude
 */
export interface ClaudeQueryParams {
  prompt: string;
  sessionId?: string;
  mode?: PermissionMode;
  workingDir?: string;
  unsafeMode?: boolean;
}

/**
 * Result from Claude query
 */
export interface ClaudeQueryResult {
  sessionId: string;
  isError: boolean;
}

/**
 * Interactive option detected in Claude output
 */
export interface InteractiveOption {
  label: string;
  response: string;
}

/**
 * Actions to perform on Telegram
 */
export type TelegramAction =
  | { type: 'message'; text: string; options?: InteractiveOption[] }
  | { type: 'status'; text: string }
  | { type: 'clear_status' }
  | { type: 'notification'; text: string };

/**
 * SDK Event types from Claude Code's stream-json output
 */
export interface ContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: {
    type: 'tool_use' | 'text';
    name?: string;
    id?: string;
  };
}

export interface ContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string };
}

export interface ContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export interface MessageStart {
  type: 'message_start';
  message: {
    id: string;
    role: string;
    model: string;
  };
}

export interface MessageDelta {
  type: 'message_delta';
  delta: {
    stop_reason?: string;
  };
}

export interface MessageStop {
  type: 'message_stop';
}

export type StreamEventType =
  | ContentBlockStart
  | ContentBlockDelta
  | ContentBlockStop
  | MessageStart
  | MessageDelta
  | MessageStop;

/**
 * Top-level SDK event wrapper
 */
export type SDKEvent =
  | {
      type: 'stream_event';
      event: StreamEventType;
    }
  | {
      type: 'assistant';
      message: {
        content: Array<{
          type: 'text' | 'tool_use';
          text?: string;
          name?: string;
          input?: unknown;
        }>;
        session_id?: string;
      };
      session_id?: string;
    }
  | {
      type: 'result';
      session_id: string;
      is_error: boolean;
    }
  | {
      type: 'user';
      message: {
        content: Array<{ type: 'text'; text: string }>;
      };
    }
  | {
      type: 'error';
      error: {
        message: string;
        code?: string;
      };
    };

/**
 * Message stored in conversation history
 */
export interface ConversationMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ name: string; status: 'running' | 'complete' }>;
  timestamp: Date;
}

/**
 * Claude session metadata for API responses
 */
export interface ClaudeSessionInfo {
  id: string;
  telegramUserId?: number;
  currentMode: PermissionMode;
  workingDir: string;
  unsafeMode: boolean;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}
