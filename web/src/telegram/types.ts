/**
 * TypeScript interfaces for Telegram Bot Integration
 */

/**
 * Permission modes for Claude Code (--permission-mode flag values)
 */
export type PermissionMode =
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default'
  | 'delegate'
  | 'dontAsk'
  | 'plan';

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
 * Verbosity levels for Telegram output
 */
export type VerbosityLevel = 'minimal' | 'normal' | 'verbose';

/**
 * All valid verbosity levels for validation
 */
export const VALID_VERBOSITY_LEVELS: VerbosityLevel[] = ['minimal', 'normal', 'verbose'];

/**
 * Notification modes for Telegram message sounds
 * - 'default': Only completion notification is loud; all others silent
 * - 'full': All messages sent with sound
 * - 'silent': All messages sent silently
 */
export type NotificationMode = 'default' | 'full' | 'silent';

/**
 * All valid notification modes for validation
 */
export const VALID_NOTIFICATION_MODES: NotificationMode[] = ['default', 'full', 'silent'];

/**
 * Animal emojis for session identification
 * Each session gets a unique emoji for visual distinction
 */
export const SESSION_EMOJIS = ['🦊', '🐻', '🦁', '🐯', '🦄', '🐺', '🦅', '🐬', '🦉', '🐙'];

/**
 * Default maximum number of sessions per user
 */
export const DEFAULT_MAX_SESSIONS = 5;

/**
 * User session tracking Telegram user → Claude session mapping
 */
export interface UserSession {
  id: string; // Unique session identifier (e.g., "session-1")
  name: string; // Human-readable name (e.g., "vibetunnel", "other-project")
  emoji: string; // Unique animal emoji for visual identification
  telegramUserId: number;
  claudeSessionId: string;
  currentMode: PermissionMode;
  workingDir: string;
  unsafeMode: boolean;
  verbosity: VerbosityLevel;
  notificationMode: NotificationMode;
  createdAt: Date;
  lastActivity: Date;
}

/**
 * User-level settings for defaults
 */
export interface UserSettings {
  defaultMode: PermissionMode;
  defaultWorkingDir?: string;
  defaultNotificationMode?: NotificationMode;
}

/**
 * Default user settings
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultMode: 'default',
  defaultNotificationMode: 'default',
};

/**
 * User profile containing multiple named sessions
 */
export interface UserProfile {
  telegramUserId: number;
  sessions: UserSession[];
  activeSessionId: string; // ID of the currently active session
  settings: UserSettings; // User-level settings for defaults
}

/**
 * Configuration for the Telegram bot service
 */
export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUsers?: number[];
  allowUnsafeMode?: boolean;
  defaultWorkingDir?: string; // Configurable base directory for new sessions
  maxSessionsPerUser?: number; // Maximum sessions per user (default: 5)
  /** DeepGram API key for voice message transcription */
  deepgramApiKey?: string;
  /** DeepGram model to use for transcription (default: 'nova-2') */
  deepgramModel?: string;
  /** Language code for transcription (default: 'en') */
  deepgramLanguage?: string;
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
 * Claude's AskUserQuestion structure
 */
export interface ClaudeQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

/**
 * Actions to perform on Telegram
 */
export type TelegramAction =
  | {
      type: 'message';
      text: string;
      options?: InteractiveOption[];
      isPlan?: boolean;
      fileName?: string;
    }
  | { type: 'status'; text: string }
  | { type: 'clear_status' }
  | { type: 'notification'; text: string }
  | { type: 'document'; content: string; fileName: string; caption?: string; isPlan?: boolean }
  | { type: 'user_question'; questions: ClaudeQuestion[] };

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
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
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
