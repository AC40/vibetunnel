/**
 * Session Manager for Telegram Bot
 *
 * Manages user sessions, mode tracking, and persistence to disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PermissionMode, UserSession } from './types.js';

interface SerializedSession {
  telegramUserId: number;
  claudeSessionId: string;
  currentMode: PermissionMode;
  workingDir: string;
  unsafeMode: boolean;
  createdAt: string;
  lastActivity: string;
}

export class SessionManager {
  private sessions = new Map<number, UserSession>();
  private storePath: string;

  constructor(controlDir: string) {
    this.storePath = path.join(controlDir, 'telegram-sessions.json');
    this.loadFromDisk();
  }

  /**
   * Create a new session for a user
   */
  createSession(userId: number, workingDir?: string): UserSession {
    const session: UserSession = {
      telegramUserId: userId,
      claudeSessionId: '',
      currentMode: 'default',
      workingDir: workingDir || process.cwd(),
      unsafeMode: false,
      createdAt: new Date(),
      lastActivity: new Date(),
    };
    this.sessions.set(userId, session);
    this.saveToDisk();
    return session;
  }

  /**
   * Get a user's session
   */
  getSession(userId: number): UserSession | undefined {
    return this.sessions.get(userId);
  }

  /**
   * Get all sessions
   */
  getAllSessions(): UserSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Update a user's session
   */
  updateSession(userId: number, updates: Partial<UserSession>): void {
    const session = this.sessions.get(userId);
    if (session) {
      Object.assign(session, updates, { lastActivity: new Date() });
      this.saveToDisk();
    }
  }

  /**
   * Delete a user's session
   */
  deleteSession(userId: number): boolean {
    const deleted = this.sessions.delete(userId);
    if (deleted) {
      this.saveToDisk();
    }
    return deleted;
  }

  /**
   * Set the Claude session ID for a user
   */
  setClaudeSessionId(userId: number, sessionId: string): void {
    this.updateSession(userId, { claudeSessionId: sessionId });
  }

  /**
   * Change the permission mode for a user's session
   */
  setMode(userId: number, mode: PermissionMode): void {
    this.updateSession(userId, { currentMode: mode });
  }

  /**
   * Toggle unsafe mode (dangerously-skip-permissions)
   */
  toggleUnsafeMode(userId: number): boolean {
    const session = this.sessions.get(userId);
    if (session) {
      const newValue = !session.unsafeMode;
      this.updateSession(userId, { unsafeMode: newValue });
      return newValue;
    }
    return false;
  }

  /**
   * Change the working directory for a user's session
   */
  setWorkingDir(userId: number, workingDir: string): void {
    this.updateSession(userId, { workingDir });
  }

  /**
   * Load sessions from disk
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const sessions = JSON.parse(data) as SerializedSession[];
        for (const s of sessions) {
          this.sessions.set(s.telegramUserId, {
            telegramUserId: s.telegramUserId,
            claudeSessionId: s.claudeSessionId,
            currentMode: s.currentMode,
            workingDir: s.workingDir,
            unsafeMode: s.unsafeMode ?? false,
            createdAt: new Date(s.createdAt),
            lastActivity: new Date(s.lastActivity),
          });
        }
      }
    } catch (_error) {
      // No saved sessions or error reading
    }
  }

  /**
   * Save sessions to disk
   */
  private saveToDisk(): void {
    const sessions: SerializedSession[] = Array.from(this.sessions.values()).map((s) => ({
      telegramUserId: s.telegramUserId,
      claudeSessionId: s.claudeSessionId,
      currentMode: s.currentMode,
      workingDir: s.workingDir,
      unsafeMode: s.unsafeMode,
      createdAt: s.createdAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
    }));
    const data = JSON.stringify(sessions, null, 2);
    fs.writeFileSync(this.storePath, data);
  }

  /**
   * Get session info summary for a user
   */
  getSessionInfo(userId: number): string | null {
    const session = this.sessions.get(userId);
    if (!session) return null;

    const lines = [
      `Session ID: ${session.claudeSessionId || '(new session)'}`,
      `Mode: ${session.currentMode}`,
      `Unsafe Mode: ${session.unsafeMode ? 'ENABLED' : 'disabled'}`,
      `Working Dir: ${session.workingDir}`,
      `Created: ${session.createdAt.toISOString()}`,
      `Last Activity: ${session.lastActivity.toISOString()}`,
    ];

    return lines.join('\n');
  }
}
