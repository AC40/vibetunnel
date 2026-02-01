/**
 * Conversation Store
 *
 * Stores and retrieves conversation history for Claude SDK sessions.
 * Used by both Telegram bot and Web UI.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { ConversationMessage } from '../../telegram/types.js';

interface SerializedMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ name: string; status: 'running' | 'complete' }>;
  timestamp: string;
}

export interface ConversationStoreEvents {
  message: (data: { sessionId: string; message: ConversationMessage }) => void;
}

export class ConversationStore extends EventEmitter {
  private messages = new Map<string, ConversationMessage[]>();
  private storePath: string;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(controlDir: string) {
    super();
    this.storePath = path.join(controlDir, 'claude-conversations.json');
    this.loadFromDisk();
  }

  /**
   * Add a message to a session's history
   */
  addMessage(sessionId: string, message: ConversationMessage): void {
    const history = this.messages.get(sessionId) || [];
    history.push(message);
    this.messages.set(sessionId, history);

    // Emit event for real-time updates
    this.emit('message', { sessionId, message });

    // Debounced save to disk
    this.scheduleSave();
  }

  /**
   * Get all messages for a session
   */
  getHistory(sessionId: string): ConversationMessage[] {
    return this.messages.get(sessionId) || [];
  }

  /**
   * Get all session IDs
   */
  getAllSessionIds(): string[] {
    return Array.from(this.messages.keys());
  }

  /**
   * Get message count for a session
   */
  getMessageCount(sessionId: string): number {
    return (this.messages.get(sessionId) || []).length;
  }

  /**
   * Clear history for a session
   */
  clearHistory(sessionId: string): void {
    this.messages.delete(sessionId);
    this.scheduleSave();
  }

  /**
   * Clear all history
   */
  clearAll(): void {
    this.messages.clear();
    this.scheduleSave();
  }

  /**
   * Update the last message in a session (for streaming updates)
   */
  updateLastMessage(sessionId: string, content: string): void {
    const history = this.messages.get(sessionId);
    if (history && history.length > 0) {
      const lastMessage = history[history.length - 1];
      lastMessage.content = content;
      this.emit('message', { sessionId, message: lastMessage });
      this.scheduleSave();
    }
  }

  /**
   * Add or update tool use status for the last assistant message
   */
  updateToolUse(sessionId: string, toolName: string, status: 'running' | 'complete'): void {
    const history = this.messages.get(sessionId);
    if (history && history.length > 0) {
      const lastMessage = history[history.length - 1];
      if (lastMessage.role === 'assistant') {
        if (!lastMessage.toolUse) {
          lastMessage.toolUse = [];
        }

        const existingTool = lastMessage.toolUse.find((t) => t.name === toolName);
        if (existingTool) {
          existingTool.status = status;
        } else {
          lastMessage.toolUse.push({ name: toolName, status });
        }

        this.emit('message', { sessionId, message: lastMessage });
        this.scheduleSave();
      }
    }
  }

  /**
   * Load conversations from disk
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const conversations = JSON.parse(data) as Record<string, SerializedMessage[]>;

        for (const [sessionId, messages] of Object.entries(conversations)) {
          this.messages.set(
            sessionId,
            messages.map((m) => ({
              ...m,
              timestamp: new Date(m.timestamp),
            }))
          );
        }
      }
    } catch (_error) {
      // No saved conversations or error reading
    }
  }

  /**
   * Schedule a debounced save to disk
   */
  private scheduleSave(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(() => {
      this.saveToDisk();
      this.saveDebounceTimer = null;
    }, 1000);
  }

  /**
   * Save conversations to disk
   */
  private saveToDisk(): void {
    const conversations: Record<string, SerializedMessage[]> = {};

    for (const [sessionId, messages] of this.messages.entries()) {
      conversations[sessionId] = messages.map((m) => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      }));
    }

    const data = JSON.stringify(conversations, null, 2);
    fs.writeFileSync(this.storePath, data);
  }
}
