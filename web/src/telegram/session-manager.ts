/**
 * Session Manager for Telegram Bot
 *
 * Manages user profiles with multiple named sessions, mode tracking, and persistence to disk.
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  NotificationMode,
  PermissionMode,
  UserProfile,
  UserSession,
  UserSettings,
  VerbosityLevel,
} from './types.js';
import { DEFAULT_MAX_SESSIONS, DEFAULT_USER_SETTINGS, SESSION_EMOJIS } from './types.js';

interface SerializedSession {
  id: string;
  name: string;
  emoji: string;
  telegramUserId: number;
  claudeSessionId: string;
  currentMode: PermissionMode;
  workingDir: string;
  unsafeMode: boolean;
  verbosity?: VerbosityLevel;
  notificationMode?: NotificationMode;
  createdAt: string;
  lastActivity: string;
}

interface SerializedSettings {
  defaultMode: PermissionMode;
  defaultWorkingDir?: string;
  defaultNotificationMode?: NotificationMode;
}

interface SerializedProfile {
  telegramUserId: number;
  sessions: SerializedSession[];
  activeSessionId: string;
  settings?: SerializedSettings;
}

export class SessionManager {
  private profiles = new Map<number, UserProfile>();
  private storePath: string;
  private maxSessions: number;
  private defaultWorkingDir: string;
  private sessionCounter = 0;

  constructor(controlDir: string, options?: { maxSessions?: number; defaultWorkingDir?: string }) {
    this.storePath = path.join(controlDir, 'telegram-sessions.json');
    this.maxSessions = options?.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.defaultWorkingDir = options?.defaultWorkingDir ?? process.cwd();
    this.loadFromDisk();
  }

  /**
   * Get or create a user profile
   */
  getOrCreateProfile(userId: number): UserProfile {
    let profile = this.profiles.get(userId);
    if (!profile) {
      profile = {
        telegramUserId: userId,
        sessions: [],
        activeSessionId: '',
        settings: { ...DEFAULT_USER_SETTINGS },
      };
      this.profiles.set(userId, profile);
    }
    // Migration: add settings if missing from existing profile
    if (!profile.settings) {
      profile.settings = { ...DEFAULT_USER_SETTINGS };
    }
    return profile;
  }

  /**
   * Get a user's profile
   */
  getProfile(userId: number): UserProfile | undefined {
    return this.profiles.get(userId);
  }

  /**
   * Get the active session for a user
   */
  getActiveSession(userId: number): UserSession | undefined {
    const profile = this.profiles.get(userId);
    if (!profile || !profile.activeSessionId) return undefined;
    return profile.sessions.find((s) => s.id === profile.activeSessionId);
  }

  /**
   * Get a session by ID for a user
   */
  getSessionById(userId: number, sessionId: string): UserSession | undefined {
    const profile = this.profiles.get(userId);
    if (!profile) return undefined;
    return profile.sessions.find((s) => s.id === sessionId);
  }

  /**
   * Get a session by name for a user
   */
  getSessionByName(userId: number, name: string): UserSession | undefined {
    const profile = this.profiles.get(userId);
    if (!profile) return undefined;
    return profile.sessions.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Assign a unique emoji to a session
   */
  private assignSessionEmoji(profile: UserProfile): string {
    const usedEmojis = profile.sessions.map((s) => s.emoji);
    const available = SESSION_EMOJIS.filter((e) => !usedEmojis.includes(e));
    if (available.length === 0) {
      // All 10 used (shouldn't happen with 5 session limit)
      return SESSION_EMOJIS[Math.floor(Math.random() * SESSION_EMOJIS.length)];
    }
    return available[Math.floor(Math.random() * available.length)];
  }

  /**
   * Generate a unique session ID
   */
  private generateSessionId(): string {
    this.sessionCounter++;
    return `session-${Date.now()}-${this.sessionCounter}`;
  }

  /**
   * Create a new named session for a user
   * Returns null if session limit reached or name already exists
   */
  createSession(
    userId: number,
    name?: string,
    workingDir?: string
  ): { session: UserSession; error?: never } | { session?: never; error: string } {
    const profile = this.getOrCreateProfile(userId);

    // Check session limit
    if (profile.sessions.length >= this.maxSessions) {
      return {
        error: `Session limit reached (${this.maxSessions}). Delete a session with /delete <name> first.`,
      };
    }

    // Use user's default working dir if set, otherwise fall back to server default
    const resolvedDir = workingDir || profile.settings?.defaultWorkingDir || this.defaultWorkingDir;
    const sessionName = name || path.basename(resolvedDir);

    // Check for duplicate name
    if (profile.sessions.some((s) => s.name.toLowerCase() === sessionName.toLowerCase())) {
      return { error: `Session "${sessionName}" already exists. Choose a different name.` };
    }

    // Use user's default mode for new sessions
    const defaultMode = profile.settings?.defaultMode || 'default';
    const defaultNotificationMode = profile.settings?.defaultNotificationMode || 'default';

    const session: UserSession = {
      id: this.generateSessionId(),
      name: sessionName,
      emoji: this.assignSessionEmoji(profile),
      telegramUserId: userId,
      claudeSessionId: '',
      currentMode: defaultMode,
      workingDir: resolvedDir,
      unsafeMode: false,
      verbosity: 'normal',
      notificationMode: defaultNotificationMode,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    profile.sessions.push(session);
    profile.activeSessionId = session.id;
    this.saveToDisk();

    return { session };
  }

  /**
   * Switch to a different session by name
   */
  switchSession(
    userId: number,
    nameOrId: string
  ): { session: UserSession; error?: never } | { session?: never; error: string } {
    const profile = this.profiles.get(userId);
    if (!profile) {
      return { error: 'No sessions. Use /new to create one.' };
    }

    const session =
      profile.sessions.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase()) ||
      profile.sessions.find((s) => s.id === nameOrId);

    if (!session) {
      return { error: `Session "${nameOrId}" not found.` };
    }

    profile.activeSessionId = session.id;
    session.lastActivity = new Date();
    this.saveToDisk();

    return { session };
  }

  /**
   * Delete a session by name
   */
  deleteSession(
    userId: number,
    nameOrId: string
  ): { deleted: true; error?: never } | { deleted?: never; error: string } {
    const profile = this.profiles.get(userId);
    if (!profile) {
      return { error: 'No sessions to delete.' };
    }

    const sessionIndex = profile.sessions.findIndex(
      (s) => s.name.toLowerCase() === nameOrId.toLowerCase() || s.id === nameOrId
    );

    if (sessionIndex === -1) {
      return { error: `Session "${nameOrId}" not found.` };
    }

    const session = profile.sessions[sessionIndex];

    // Can't delete active session (must switch first)
    if (session.id === profile.activeSessionId) {
      return { error: "Can't delete active session. Switch to another session first." };
    }

    profile.sessions.splice(sessionIndex, 1);
    this.saveToDisk();

    return { deleted: true };
  }

  /**
   * Rename the current session
   */
  renameSession(
    userId: number,
    newName: string
  ): { session: UserSession; error?: never } | { session?: never; error: string } {
    const session = this.getActiveSession(userId);
    if (!session) {
      return { error: 'No active session.' };
    }

    const profile = this.profiles.get(userId)!;

    // Check for duplicate name
    if (
      profile.sessions.some(
        (s) => s.id !== session.id && s.name.toLowerCase() === newName.toLowerCase()
      )
    ) {
      return { error: `Session "${newName}" already exists.` };
    }

    session.name = newName;
    session.lastActivity = new Date();
    this.saveToDisk();

    return { session };
  }

  /**
   * Get all sessions for a user
   */
  getSessionsForUser(userId: number): UserSession[] {
    const profile = this.profiles.get(userId);
    return profile?.sessions || [];
  }

  /**
   * Get all sessions across all users (for API listing)
   */
  getAllSessions(): UserSession[] {
    const allSessions: UserSession[] = [];
    for (const profile of this.profiles.values()) {
      allSessions.push(...profile.sessions);
    }
    return allSessions;
  }

  /**
   * Update the active session
   */
  updateActiveSession(userId: number, updates: Partial<UserSession>): void {
    const session = this.getActiveSession(userId);
    if (session) {
      Object.assign(session, updates, { lastActivity: new Date() });
      this.saveToDisk();
    }
  }

  /**
   * Set the Claude session ID for active session
   */
  setClaudeSessionId(userId: number, claudeSessionId: string): void {
    this.updateActiveSession(userId, { claudeSessionId });
  }

  /**
   * Change the permission mode for active session
   */
  setMode(userId: number, mode: PermissionMode): void {
    this.updateActiveSession(userId, { currentMode: mode });
  }

  /**
   * Toggle unsafe mode for active session
   */
  toggleUnsafeMode(userId: number): boolean {
    const session = this.getActiveSession(userId);
    if (session) {
      const newValue = !session.unsafeMode;
      this.updateActiveSession(userId, { unsafeMode: newValue });
      return newValue;
    }
    return false;
  }

  /**
   * Change the working directory for active session
   */
  setWorkingDir(userId: number, workingDir: string): void {
    this.updateActiveSession(userId, { workingDir });
  }

  /**
   * Change the verbosity level for active session
   */
  setVerbosity(userId: number, verbosity: VerbosityLevel): void {
    this.updateActiveSession(userId, { verbosity });
  }

  /**
   * Change the notification mode for active session
   */
  setNotificationMode(userId: number, notificationMode: NotificationMode): void {
    this.updateActiveSession(userId, { notificationMode });
  }

  /**
   * Get user settings
   */
  getUserSettings(userId: number): UserSettings {
    const profile = this.getOrCreateProfile(userId);
    return profile.settings || { ...DEFAULT_USER_SETTINGS };
  }

  /**
   * Update user settings
   */
  setUserSettings(userId: number, updates: Partial<UserSettings>): void {
    const profile = this.getOrCreateProfile(userId);
    profile.settings = { ...profile.settings, ...updates };
    this.saveToDisk();
  }

  /**
   * Set the default mode for new sessions
   */
  setDefaultMode(userId: number, mode: PermissionMode): void {
    this.setUserSettings(userId, { defaultMode: mode });
  }

  /**
   * Set the default working directory for new sessions
   */
  setDefaultWorkingDir(userId: number, dir: string): void {
    this.setUserSettings(userId, { defaultWorkingDir: dir });
  }

  /**
   * Set the default notification mode for new sessions
   */
  setDefaultNotificationMode(userId: number, mode: NotificationMode): void {
    this.setUserSettings(userId, { defaultNotificationMode: mode });
  }

  /**
   * Load profiles from disk
   */
  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const data = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(data);

        // Handle migration from old single-session format
        if (Array.isArray(parsed) && parsed.length > 0 && !parsed[0].sessions) {
          // Old format: array of sessions
          this.migrateOldFormat(parsed);
          return;
        }

        // New format: array of profiles
        const profiles = parsed as SerializedProfile[];
        for (const p of profiles) {
          const profile: UserProfile = {
            telegramUserId: p.telegramUserId,
            sessions: p.sessions.map((s) => ({
              id: s.id,
              name: s.name,
              emoji: s.emoji,
              telegramUserId: s.telegramUserId,
              claudeSessionId: s.claudeSessionId,
              currentMode: s.currentMode,
              workingDir: s.workingDir,
              unsafeMode: s.unsafeMode ?? false,
              verbosity: s.verbosity ?? 'normal',
              notificationMode: s.notificationMode ?? 'default',
              createdAt: new Date(s.createdAt),
              lastActivity: new Date(s.lastActivity),
            })),
            activeSessionId: p.activeSessionId,
            settings: p.settings ?? { ...DEFAULT_USER_SETTINGS },
          };
          this.profiles.set(p.telegramUserId, profile);
        }
      }
    } catch (_error) {
      // No saved sessions or error reading
    }
  }

  /**
   * Migrate from old single-session format to new multi-session format
   */
  private migrateOldFormat(
    oldSessions: Array<{
      telegramUserId: number;
      claudeSessionId: string;
      currentMode: PermissionMode;
      workingDir: string;
      unsafeMode?: boolean;
      verbosity?: VerbosityLevel;
      createdAt: string;
      lastActivity: string;
    }>
  ): void {
    for (const s of oldSessions) {
      const sessionId = this.generateSessionId();
      const sessionName = path.basename(s.workingDir);
      const emoji = SESSION_EMOJIS[0]; // First user gets fox

      const session: UserSession = {
        id: sessionId,
        name: sessionName,
        emoji,
        telegramUserId: s.telegramUserId,
        claudeSessionId: s.claudeSessionId,
        currentMode: s.currentMode,
        workingDir: s.workingDir,
        unsafeMode: s.unsafeMode ?? false,
        verbosity: s.verbosity ?? 'normal',
        notificationMode: 'default',
        createdAt: new Date(s.createdAt),
        lastActivity: new Date(s.lastActivity),
      };

      const profile: UserProfile = {
        telegramUserId: s.telegramUserId,
        sessions: [session],
        activeSessionId: sessionId,
        settings: { ...DEFAULT_USER_SETTINGS },
      };

      this.profiles.set(s.telegramUserId, profile);
    }

    this.saveToDisk();
  }

  /**
   * Save profiles to disk
   */
  private saveToDisk(): void {
    const profiles: SerializedProfile[] = Array.from(this.profiles.values()).map((p) => ({
      telegramUserId: p.telegramUserId,
      sessions: p.sessions.map((s) => ({
        id: s.id,
        name: s.name,
        emoji: s.emoji,
        telegramUserId: s.telegramUserId,
        claudeSessionId: s.claudeSessionId,
        currentMode: s.currentMode,
        workingDir: s.workingDir,
        unsafeMode: s.unsafeMode,
        verbosity: s.verbosity,
        notificationMode: s.notificationMode,
        createdAt: s.createdAt.toISOString(),
        lastActivity: s.lastActivity.toISOString(),
      })),
      activeSessionId: p.activeSessionId,
      settings: p.settings,
    }));
    const data = JSON.stringify(profiles, null, 2);
    fs.writeFileSync(this.storePath, data);
  }

  /**
   * Get session info summary for the active session
   */
  getSessionInfo(userId: number): string | null {
    const session = this.getActiveSession(userId);
    if (!session) return null;

    const profile = this.profiles.get(userId)!;
    const sessionCount = profile.sessions.length;

    const lines = [
      `Session: ${session.name} ${session.emoji} (${sessionCount} of ${this.maxSessions})`,
      `Claude ID: ${session.claudeSessionId || '(new session)'}`,
      `Mode: ${session.currentMode}`,
      `Unsafe Mode: ${session.unsafeMode ? 'ENABLED' : 'disabled'}`,
      `Verbosity: ${session.verbosity}`,
      `Working Dir: ${session.workingDir}`,
      `Created: ${session.createdAt.toISOString()}`,
      `Last Activity: ${session.lastActivity.toISOString()}`,
    ];

    return lines.join('\n');
  }

  /**
   * Get formatted session list for display
   */
  getSessionListFormatted(userId: number): string {
    const profile = this.profiles.get(userId);
    if (!profile || profile.sessions.length === 0) {
      return 'No sessions. Use /new to create one.';
    }

    const lines = ['📋 *Your Sessions:*', ''];

    for (const session of profile.sessions) {
      const isActive = session.id === profile.activeSessionId;
      const activeIndicator = isActive ? ' (active) ✓' : '';
      lines.push(`${session.emoji} *${session.name}*${activeIndicator}`);
      lines.push(`   📁 \`${session.workingDir}\``);
      lines.push(`   🔐 ${session.currentMode}`);
      lines.push('');
    }

    lines.push('Use /switch <name> to change sessions');

    return lines.join('\n');
  }

  // Backwards compatibility methods for single-session callers

  /**
   * @deprecated Use getActiveSession instead
   */
  getSession(userId: number): UserSession | undefined {
    return this.getActiveSession(userId);
  }

  /**
   * @deprecated Use updateActiveSession instead
   */
  updateSession(userId: number, updates: Partial<UserSession>): void {
    this.updateActiveSession(userId, updates);
  }

  /**
   * @deprecated Use deleteSession instead
   */
  deleteSessionByUserId(userId: number): boolean {
    const profile = this.profiles.get(userId);
    if (!profile) return false;

    const activeSession = this.getActiveSession(userId);
    if (!activeSession) return false;

    // If only one session, delete the profile entirely
    if (profile.sessions.length === 1) {
      this.profiles.delete(userId);
      this.saveToDisk();
      return true;
    }

    // Otherwise just delete the active session and switch to another
    const idx = profile.sessions.findIndex((s) => s.id === activeSession.id);
    profile.sessions.splice(idx, 1);
    profile.activeSessionId = profile.sessions[0].id;
    this.saveToDisk();
    return true;
  }
}
