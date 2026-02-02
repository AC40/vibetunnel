/**
 * Telegram Bot Service
 *
 * Main bot service that handles commands, messages, and Claude integration.
 * Supports multiple named sessions per user with parallel queries.
 */

import chalk from 'chalk';
import type { Context } from 'grammy';
import { Bot, InputFile } from 'grammy';
import type { ConversationStore } from '../server/claude/conversation-store.js';
import { ClaudeSDKBridge } from './claude-sdk-bridge.js';
import {
  buildClaudeQuestionKeyboard,
  buildDeleteConfirmKeyboard,
  buildDirectoryPickerKeyboard,
  buildModeKeyboard,
  buildNotificationModeKeyboard,
  buildOptionKeyboard,
  buildPlanApprovalKeyboard,
  buildSessionSwitcherKeyboard,
  buildSettingsKeyboard,
} from './keyboards.js';
import { OutputFormatter } from './output-formatter.js';
import {
  canGoUp,
  getDirectoryName,
  getParentPath,
  listSubdirectories,
  resolveAndValidatePath,
} from './path-utils.js';
import { SessionManager } from './session-manager.js';
import type {
  ClaudeQuestion,
  NotificationMode,
  PermissionMode,
  TelegramAction,
  UserSession,
  VerbosityLevel,
} from './types.js';
import {
  VALID_NOTIFICATION_MODES,
  VALID_PERMISSION_MODES,
  VALID_VERBOSITY_LEVELS,
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

const logger = createLogger('telegram-bot');

export interface TelegramBotServiceConfig {
  botToken: string;
  allowedUsers?: number[];
  allowUnsafeMode?: boolean;
  controlDir: string;
  conversationStore?: ConversationStore;
  defaultWorkingDir?: string;
  maxSessionsPerUser?: number;
}

interface ActiveQuery {
  userId: number;
  sessionId: string;
  prompt: string;
  startTime: Date;
  currentTool: string | null;
}

interface DirectoryPickerState {
  currentPath: string;
  purpose: 'new_session' | 'change_dir';
  sessionName?: string; // For new_session with custom name
}

export class TelegramBotService {
  private bot: Bot;
  private sessionManager: SessionManager;
  private conversationStore?: ConversationStore;
  private allowedUsers: Set<number>;
  private allowUnsafeMode: boolean;
  private defaultWorkingDir: string;

  // Per-session bridges and formatters (keyed by session.id)
  private activeBridges = new Map<string, ClaudeSDKBridge>();
  private activeFormatters = new Map<string, OutputFormatter>();
  private activeQueries = new Map<string, ActiveQuery>();

  // Directory picker state per user
  private activeDirectoryPickers = new Map<number, DirectoryPickerState>();

  // Pending question answers (when user selects "Other")
  private pendingQuestionAnswer = new Map<number, { questions: ClaudeQuestion[]; index: number }>();

  // Track active questions for building answers
  private activeQuestionSets = new Map<number, ClaudeQuestion[]>();

  // Track collected answers for multi-question flows
  private questionProgress = new Map<
    number,
    {
      questions: ClaudeQuestion[];
      currentIndex: number;
      answers: string[];
    }
  >();

  // Reserved bot commands (handled locally, not forwarded to Claude)
  private readonly RESERVED_COMMANDS = new Set([
    'start',
    'bothelp',
    'new',
    'sessions',
    'switch',
    'cd',
    'delete',
    'rename',
    'mode',
    'unsafe',
    'cancel',
    'querystatus',
    'status',
    'verbosity',
    'notifications',
    'settings',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'y',
    'n',
  ]);

  constructor(config: TelegramBotServiceConfig) {
    this.bot = new Bot(config.botToken);
    this.defaultWorkingDir = config.defaultWorkingDir ?? process.cwd();
    this.sessionManager = new SessionManager(config.controlDir, {
      maxSessions: config.maxSessionsPerUser,
      defaultWorkingDir: this.defaultWorkingDir,
    });
    this.conversationStore = config.conversationStore;
    this.allowedUsers = new Set(config.allowedUsers || []);
    this.allowUnsafeMode = config.allowUnsafeMode ?? false;

    this.setupHandlers();
  }

  /**
   * Setup all command and message handlers
   */
  private setupHandlers(): void {
    // Debug middleware - log every incoming update
    this.bot.use(async (ctx, next) => {
      const updateId = ctx.update.update_id;
      const updateType = Object.keys(ctx.update)
        .filter((k) => k !== 'update_id')
        .join(', ');
      logger.log(`[${updateId}] Incoming update, type: ${updateType}`);
      try {
        await next();
        logger.log(`[${updateId}] Completed successfully`);
      } catch (error) {
        logger.error(`[${updateId}] Error:`, error);
        throw error;
      }
    });

    // Command handlers
    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('bothelp', (ctx) => this.handleHelp(ctx));
    this.bot.command('new', (ctx) => this.handleNew(ctx));
    this.bot.command('sessions', (ctx) => this.handleSessions(ctx));
    this.bot.command('switch', (ctx) => this.handleSwitch(ctx));
    this.bot.command('cd', (ctx) => this.handleCd(ctx));
    this.bot.command('delete', (ctx) => this.handleDelete(ctx));
    this.bot.command('rename', (ctx) => this.handleRename(ctx));
    this.bot.command('mode', (ctx) => this.handleMode(ctx));
    this.bot.command('unsafe', (ctx) => this.handleUnsafe(ctx));
    this.bot.command('cancel', (ctx) => this.handleCancel(ctx));
    this.bot.command('querystatus', (ctx) => this.handleQueryStatus(ctx));
    this.bot.command('status', (ctx) => this.handleStatus(ctx));
    this.bot.command('verbosity', (ctx) => this.handleVerbosity(ctx));
    this.bot.command('notifications', (ctx) => this.handleNotifications(ctx));
    this.bot.command('settings', (ctx) => this.handleSettings(ctx));

    // Quick response commands
    for (const num of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      this.bot.command(num, (ctx) => this.handleQuickResponse(ctx, num));
    }
    this.bot.command('y', (ctx) => this.handleQuickResponse(ctx, 'y'));
    this.bot.command('n', (ctx) => this.handleQuickResponse(ctx, 'n'));

    // Callback query handler for inline keyboards
    this.bot.on('callback_query:data', (ctx) => this.handleCallbackQuery(ctx));

    // General message handler
    this.bot.on('message:text', (ctx) => this.handleMessage(ctx));
  }

  /**
   * Check if a user is authorized
   */
  private isAuthorized(userId: number): boolean {
    // If no users are whitelisted, auto-whitelist first user
    if (this.allowedUsers.size === 0) {
      return true; // Will be whitelisted in /start
    }
    return this.allowedUsers.has(userId);
  }

  /**
   * Handle /start command
   */
  private async handleStart(ctx: Context): Promise<void> {
    logger.log('[handleStart] Called');
    const userId = ctx.from?.id;
    if (!userId) {
      logger.log('[handleStart] No userId, returning');
      return;
    }

    // Auto-whitelist first user
    if (this.allowedUsers.size === 0) {
      this.allowedUsers.add(userId);
      logger.log(`Auto-whitelisted first user: ${userId}`);
    }

    if (!this.isAuthorized(userId)) {
      await ctx.reply('You are not authorized to use this bot. Contact the administrator.');
      return;
    }

    // Create session if doesn't exist
    let session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      const result = this.sessionManager.createSession(userId);
      if ('error' in result) {
        await ctx.reply(`Error creating session: ${result.error}`);
        return;
      }
      session = result.session;
    }

    const welcomeMessage = `
🚀 *Welcome to VibeTunnel Claude Bot!*

Control Claude Code remotely through Telegram.

*Quick Start:*
• Just send a message to chat with Claude
• Use /new to start a fresh session
• Use /mode to change permission mode

*Current Session: ${session.name}* ${session.emoji}
• Mode: ${session.currentMode}
• Working Dir: \`${session.workingDir}\`

Type /bothelp for all commands.
    `.trim();

    await ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
    logger.log('[handleStart] Completed');
  }

  /**
   * Handle /bothelp command
   */
  private async handleHelp(ctx: Context): Promise<void> {
    const helpMessage = `
*VibeTunnel Claude Bot Commands*

*Session Management:*
/new [name] [path] - Create new session
/sessions - List all your sessions
/switch <name> - Switch to a different session
/cd [path] - Change working directory
/delete <name> - Delete a session
/rename <name> - Rename current session
/mode [mode] - Show or change permission mode
/unsafe - Toggle dangerously-skip-permissions mode
/verbosity [level] - Control output detail
/notifications [mode] - Control notification sounds
/settings - Manage default mode/directory

*Quick Responses:*
/1 - /9 - Send number to Claude
/y, /n - Send yes/no

*Control:*
/cancel - Interrupt running Claude process
/status - Show session status
/querystatus - Show active query status only

*Bang Mode:*
Start a message with \`!\` to execute it as a bash command directly.
Example: \`!ls -la\` or \`!git status\`

Everything else you type is sent to Claude as a prompt.
    `.trim();

    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /new command - create new session
   */
  private async handleNew(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    const sessionName = args[0];
    const pathArg = args[1];

    if (pathArg) {
      // Path provided, validate and create session
      const session = this.sessionManager.getActiveSession(userId);
      const basePath = session?.workingDir || this.defaultWorkingDir;
      const validation = resolveAndValidatePath(pathArg, basePath);

      if (!validation.valid) {
        await ctx.reply(`❌ ${validation.error}`);
        return;
      }

      const result = this.sessionManager.createSession(userId, sessionName, validation.resolved);
      if ('error' in result) {
        await ctx.reply(`❌ ${result.error}`);
        return;
      }

      await ctx.reply(
        `✅ Created session: *${result.session.name}* ${result.session.emoji}\n\n` +
          `📁 \`${result.session.workingDir}\`\n` +
          `🔐 Mode: ${result.session.currentMode}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // No path provided, show directory picker
      const startPath = this.defaultWorkingDir;
      await this.showDirectoryPicker(ctx, userId, startPath, 'new_session', sessionName);
    }
  }

  /**
   * Show directory picker for interactive folder selection
   */
  private async showDirectoryPicker(
    ctx: Context,
    userId: number,
    basePath: string,
    purpose: 'new_session' | 'change_dir',
    sessionName?: string
  ): Promise<void> {
    const directories = await listSubdirectories(basePath);

    // Store picker state
    this.activeDirectoryPickers.set(userId, {
      currentPath: basePath,
      purpose,
      sessionName,
    });

    const keyboard = buildDirectoryPickerKeyboard(directories, canGoUp(basePath));

    const purposeText =
      purpose === 'new_session' ? 'Select Directory for New Session' : 'Select Working Directory';

    await ctx.reply(
      `📂 *${purposeText}*\n\nCurrent: \`${basePath}\`\n\nChoose a folder or select this location:`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle /sessions command
   */
  private async handleSessions(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const sessions = this.sessionManager.getSessionsForUser(userId);
    if (sessions.length === 0) {
      await ctx.reply('No sessions. Use /new to create one.');
      return;
    }

    const formatted = this.sessionManager.getSessionListFormatted(userId);
    await ctx.reply(formatted, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /switch command
   */
  private async handleSwitch(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
      // Show session switcher keyboard
      const sessions = this.sessionManager.getSessionsForUser(userId);
      if (sessions.length === 0) {
        await ctx.reply('No sessions. Use /new to create one.');
        return;
      }

      const profile = this.sessionManager.getProfile(userId)!;
      const keyboard = buildSessionSwitcherKeyboard(
        sessions.map((s) => ({
          id: s.id,
          name: s.name,
          emoji: s.emoji,
          isActive: s.id === profile.activeSessionId,
        }))
      );

      await ctx.reply('Select a session:', { reply_markup: keyboard });
      return;
    }

    const sessionName = args.join(' ');
    const result = this.sessionManager.switchSession(userId, sessionName);

    if ('error' in result) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }

    await ctx.reply(
      `Switched to session: *${result.session.name}* ${result.session.emoji}\n\n` +
        `📁 \`${result.session.workingDir}\``,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle /cd command - change working directory
   */
  private async handleCd(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length === 0) {
      // No path provided, show directory picker
      await this.showDirectoryPicker(ctx, userId, session.workingDir, 'change_dir');
      return;
    }

    const pathArg = args.join(' ');
    const validation = resolveAndValidatePath(pathArg, session.workingDir);

    if (!validation.valid) {
      await ctx.reply(`❌ ${validation.error}`);
      return;
    }

    this.sessionManager.setWorkingDir(userId, validation.resolved);
    await ctx.reply(
      `📁 Working directory changed to:\n\`${validation.resolved}\` ${session.emoji}`,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle /delete command
   */
  private async handleDelete(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
      await ctx.reply('Usage: /delete <session_name>');
      return;
    }

    const sessionName = args.join(' ');
    const session = this.sessionManager.getSessionByName(userId, sessionName);

    if (!session) {
      await ctx.reply(`❌ Session "${sessionName}" not found.`);
      return;
    }

    // Show confirmation
    await ctx.reply(`Are you sure you want to delete session *${session.name}* ${session.emoji}?`, {
      parse_mode: 'Markdown',
      reply_markup: buildDeleteConfirmKeyboard(session.name),
    });
  }

  /**
   * Handle /rename command
   */
  private async handleRename(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    if (args.length === 0) {
      await ctx.reply('Usage: /rename <new_name>');
      return;
    }

    const newName = args.join(' ');
    const result = this.sessionManager.renameSession(userId, newName);

    if ('error' in result) {
      await ctx.reply(`❌ ${result.error}`);
      return;
    }

    await ctx.reply(`✅ Session renamed to: *${result.session.name}* ${result.session.emoji}`, {
      parse_mode: 'Markdown',
    });
  }

  /**
   * Handle /mode command
   */
  private async handleMode(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length === 0) {
      // Show current mode with keyboard
      await ctx.reply(`Current mode: *${session.currentMode}* ${session.emoji}\n\nSelect a mode:`, {
        parse_mode: 'Markdown',
        reply_markup: buildModeKeyboard(session.currentMode),
      });
      return;
    }

    const newMode = args[0] as PermissionMode;
    if (!VALID_PERMISSION_MODES.includes(newMode)) {
      await ctx.reply(`Invalid mode. Valid modes: ${VALID_PERMISSION_MODES.join(', ')}`);
      return;
    }

    this.sessionManager.setMode(userId, newMode);
    await ctx.reply(`Mode set to: *${newMode}* ${session.emoji}`, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /unsafe command
   */
  private async handleUnsafe(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    if (!this.allowUnsafeMode) {
      await ctx.reply('⚠️ Unsafe mode is disabled by the server administrator.');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const newValue = this.sessionManager.toggleUnsafeMode(userId);
    const status = newValue ? '🔓 ENABLED' : '🔒 disabled';
    const warning = newValue
      ? '\n\n⚠️ *Warning:* Claude will run tools without asking for permission!'
      : '';

    await ctx.reply(`Unsafe mode: ${status} ${session.emoji}${warning}`, {
      parse_mode: 'Markdown',
    });
  }

  /**
   * Handle /cancel command
   */
  private async handleCancel(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session.');
      return;
    }

    const bridge = this.activeBridges.get(session.id);
    if (bridge?.isRunning()) {
      bridge.cancel();
      await ctx.reply(`🛑 Cancelled running operation ${session.emoji}`);
    } else {
      await ctx.reply(`No running operation to cancel ${session.emoji}`);
    }
  }

  /**
   * Handle /querystatus command - shows current query status
   */
  private async handleQueryStatus(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session.');
      return;
    }

    const query = this.activeQueries.get(session.id);
    if (!query) {
      await ctx.reply(`No active query. Claude is idle. ${session.emoji}`);
      return;
    }

    const elapsed = Math.floor((Date.now() - query.startTime.getTime()) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const tool = query.currentTool ? `\n🔧 Using: ${query.currentTool}` : '';

    await ctx.reply(
      `📊 *Active Query* ${session.emoji}\n\n` +
        `⏱ Running: ${minutes}m ${seconds}s\n` +
        `📝 Prompt: "${query.prompt.slice(0, 50)}..."${tool}`,
      { parse_mode: 'Markdown' }
    );
  }

  /**
   * Handle /status command - shows combined session + query status
   */
  private async handleStatus(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const profile = this.sessionManager.getProfile(userId)!;
    const sessionCount = profile.sessions.length;

    // Build session info
    const sessionInfo = [
      `*Session: ${session.name}* ${session.emoji} (${sessionCount} total)`,
      ``,
      `📁 Working Dir: \`${session.workingDir}\``,
      `🔐 Mode: ${session.currentMode}${session.unsafeMode ? ' (UNSAFE)' : ''}`,
      `🆔 Claude Session: ${session.claudeSessionId ? `\`${session.claudeSessionId.slice(0, 12)}...\`` : 'None'}`,
    ];

    // Add conversation stats if available
    if (this.conversationStore && session.claudeSessionId) {
      const messageCount = this.conversationStore.getMessageCount(session.claudeSessionId);
      sessionInfo.push(`💬 Messages: ${messageCount}`);
    }

    // Add active query info
    const query = this.activeQueries.get(session.id);
    if (query) {
      const elapsed = Math.floor((Date.now() - query.startTime.getTime()) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      const tool = query.currentTool ? `\n🔧 Using: ${query.currentTool}` : '';

      sessionInfo.push(``);
      sessionInfo.push(`*Active Query*`);
      sessionInfo.push(`⏱ Running: ${minutes}m ${seconds}s`);
      sessionInfo.push(`📝 "${query.prompt.slice(0, 40)}..."${tool}`);
    } else {
      sessionInfo.push(``);
      sessionInfo.push(`💤 Claude is idle`);
    }

    // Show running queries in other sessions
    const otherRunning: string[] = [];
    for (const s of profile.sessions) {
      if (s.id !== session.id && this.activeQueries.has(s.id)) {
        otherRunning.push(`${s.emoji} ${s.name}`);
      }
    }
    if (otherRunning.length > 0) {
      sessionInfo.push(``);
      sessionInfo.push(`*Running in other sessions:*`);
      sessionInfo.push(otherRunning.join(', '));
    }

    await ctx.reply(sessionInfo.join('\n'), { parse_mode: 'Markdown' });
  }

  /**
   * Handle /verbosity command - control output detail level
   */
  private async handleVerbosity(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length === 0) {
      // Show current verbosity with options
      const levels = VALID_VERBOSITY_LEVELS.map((level) => {
        const current = session.verbosity === level ? ' ✓' : '';
        const desc = {
          minimal: 'Final message only, no tool status',
          normal: 'Tool names + results (default)',
          verbose: 'Everything including tool content previews',
        }[level];
        return `• *${level}*${current}: ${desc}`;
      }).join('\n');

      await ctx.reply(
        `*Output Verbosity* ${session.emoji}\n\nCurrent: *${session.verbosity}*\n\n${levels}\n\nUsage: /verbosity <level>`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const newLevel = args[0].toLowerCase() as VerbosityLevel;
    if (!VALID_VERBOSITY_LEVELS.includes(newLevel)) {
      await ctx.reply(`Invalid level. Valid levels: ${VALID_VERBOSITY_LEVELS.join(', ')}`);
      return;
    }

    this.sessionManager.setVerbosity(userId, newLevel);
    await ctx.reply(`Verbosity set to: *${newLevel}* ${session.emoji}`, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /notifications command - control message notification sounds
   */
  private async handleNotifications(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length === 0) {
      // Show current notification mode with keyboard
      const modes = VALID_NOTIFICATION_MODES.map((mode) => {
        const current = session.notificationMode === mode ? ' ✓' : '';
        const desc = {
          default: 'Only completion sounds',
          full: 'All messages with sound',
          silent: 'All messages silent',
        }[mode];
        return `• *${mode}*${current}: ${desc}`;
      }).join('\n');

      await ctx.reply(
        `*🔔 Notification Mode* ${session.emoji}\n\nCurrent: *${session.notificationMode}*\n\n${modes}`,
        {
          parse_mode: 'Markdown',
          reply_markup: buildNotificationModeKeyboard(session.notificationMode),
        }
      );
      return;
    }

    const newMode = args[0].toLowerCase() as NotificationMode;
    if (!VALID_NOTIFICATION_MODES.includes(newMode)) {
      await ctx.reply(`Invalid mode. Valid modes: ${VALID_NOTIFICATION_MODES.join(', ')}`);
      return;
    }

    this.sessionManager.setNotificationMode(userId, newMode);
    await ctx.reply(`Notification mode set to: *${newMode}* ${session.emoji}`, {
      parse_mode: 'Markdown',
    });
  }

  /**
   * Handle /settings command - manage user-level preferences
   */
  private async handleSettings(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    const settings = this.sessionManager.getUserSettings(userId);

    if (args.length === 0) {
      // Show current settings with keyboard
      const lines = [
        '*⚙️ User Settings*',
        '',
        `*Default Mode:* ${settings.defaultMode}`,
        `*Default Dir:* ${settings.defaultWorkingDir || '(server default)'}`,
        '',
        'These settings apply to *new sessions* you create.',
        '',
        'Usage:',
        '`/settings mode <mode>` - Set default mode',
        '`/settings dir <path>` - Set default directory',
      ];

      await ctx.reply(lines.join('\n'), {
        parse_mode: 'Markdown',
        reply_markup: buildSettingsKeyboard(settings.defaultMode),
      });
      return;
    }

    const subCommand = args[0].toLowerCase();

    if (subCommand === 'mode') {
      if (args.length < 2) {
        await ctx.reply(
          `Current default mode: *${settings.defaultMode}*\n\nValid modes: ${VALID_PERMISSION_MODES.join(', ')}`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const newMode = args[1] as PermissionMode;
      if (!VALID_PERMISSION_MODES.includes(newMode)) {
        await ctx.reply(`Invalid mode. Valid modes: ${VALID_PERMISSION_MODES.join(', ')}`);
        return;
      }

      this.sessionManager.setDefaultMode(userId, newMode);
      await ctx.reply(`✅ Default mode set to: *${newMode}*\n\nNew sessions will use this mode.`, {
        parse_mode: 'Markdown',
      });
    } else if (subCommand === 'dir') {
      if (args.length < 2) {
        await ctx.reply(
          `Current default directory: *${settings.defaultWorkingDir || '(server default)'}*`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const session = this.sessionManager.getActiveSession(userId);
      const basePath = session?.workingDir || this.defaultWorkingDir;
      const { resolveAndValidatePath } = await import('./path-utils.js');
      const pathArg = args.slice(1).join(' ');
      const validation = resolveAndValidatePath(pathArg, basePath);

      if (!validation.valid) {
        await ctx.reply(`❌ ${validation.error}`);
        return;
      }

      this.sessionManager.setDefaultWorkingDir(userId, validation.resolved);
      await ctx.reply(
        `✅ Default directory set to:\n\`${validation.resolved}\`\n\nNew sessions will start in this directory.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        'Unknown settings command.\n\nUsage:\n`/settings mode <mode>`\n`/settings dir <path>`',
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle quick response commands (/1-/9, /y, /n)
   */
  private async handleQuickResponse(ctx: Context, response: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) return;

    // Forward the response to Claude
    await this.forwardToClaude(ctx, response);
  }

  /**
   * Handle callback queries from inline keyboards
   */
  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery?.data;
    if (!userId || !data) return;

    await ctx.answerCallbackQuery();

    // Directory picker callbacks
    if (data.startsWith('dir:')) {
      await this.handleDirectoryPickerCallback(ctx, userId, data);
      return;
    }

    // Session switcher callbacks
    if (data.startsWith('switch:')) {
      const sessionIdOrAction = data.replace('switch:', '');
      if (sessionIdOrAction === 'new') {
        // Create new session via picker
        await this.showDirectoryPicker(ctx, userId, this.defaultWorkingDir, 'new_session');
      } else {
        const result = this.sessionManager.switchSession(userId, sessionIdOrAction);
        if ('error' in result) {
          await ctx.editMessageText(`❌ ${result.error}`);
        } else {
          await ctx.editMessageText(
            `Switched to session: *${result.session.name}* ${result.session.emoji}`,
            { parse_mode: 'Markdown' }
          );
        }
      }
      return;
    }

    // Delete confirmation callbacks
    if (data.startsWith('delete:')) {
      const action = data.replace('delete:', '');
      if (action === 'cancel') {
        await ctx.editMessageText('Deletion cancelled.');
      } else if (action.startsWith('confirm:')) {
        const sessionName = action.replace('confirm:', '');
        const result = this.sessionManager.deleteSession(userId, sessionName);
        if ('error' in result) {
          await ctx.editMessageText(`❌ ${result.error}`);
        } else {
          await ctx.editMessageText(`🗑️ Session "${sessionName}" deleted.`);
        }
      }
      return;
    }

    // Option callbacks (from Claude output)
    if (data.startsWith('option:')) {
      const response = data.replace('option:', '');
      if (response === 'cancel') {
        const session = this.sessionManager.getActiveSession(userId);
        if (session) {
          const bridge = this.activeBridges.get(session.id);
          if (bridge?.isRunning()) {
            bridge.cancel();
            await ctx.reply(`🛑 Cancelled ${session.emoji}`);
          }
        }
      } else {
        await this.forwardToClaude(ctx, response);
      }
      return;
    }

    // Mode selection callbacks
    if (data.startsWith('mode:')) {
      const mode = data.replace('mode:', '') as PermissionMode;
      this.sessionManager.setMode(userId, mode);
      const session = this.sessionManager.getActiveSession(userId);
      const emoji = session?.emoji || '';
      await ctx.editMessageText(`Mode set to: *${mode}* ${emoji}`, { parse_mode: 'Markdown' });
      return;
    }

    // Quick action callbacks
    if (data.startsWith('quick:')) {
      const action = data.replace('quick:', '');
      if (action === 'cancel') {
        const session = this.sessionManager.getActiveSession(userId);
        if (session) {
          const bridge = this.activeBridges.get(session.id);
          if (bridge?.isRunning()) {
            bridge.cancel();
            await ctx.reply(`🛑 Cancelled ${session.emoji}`);
          }
        }
      }
      return;
    }

    // AskUserQuestion answer callbacks
    if (data.startsWith('ask:')) {
      await this.handleQuestionAnswerCallback(ctx, userId, data);
      return;
    }

    // Plan approval callbacks
    if (data.startsWith('plan:')) {
      await this.handlePlanApprovalCallback(ctx, userId, data);
      return;
    }

    // Settings callbacks
    if (data.startsWith('settings:')) {
      await this.handleSettingsCallback(ctx, userId, data);
      return;
    }

    // Notification mode callbacks
    if (data.startsWith('notif:')) {
      await this.handleNotificationModeCallback(ctx, userId, data);
      return;
    }
  }

  /**
   * Handle directory picker callback queries
   */
  private async handleDirectoryPickerCallback(
    ctx: Context,
    userId: number,
    data: string
  ): Promise<void> {
    const action = data.replace('dir:', '');
    const picker = this.activeDirectoryPickers.get(userId);

    if (!picker) {
      await ctx.editMessageText('Directory picker expired. Please try again.');
      return;
    }

    if (action === 'select') {
      // Use current path
      this.activeDirectoryPickers.delete(userId);

      if (picker.purpose === 'new_session') {
        const name = picker.sessionName || getDirectoryName(picker.currentPath);
        const result = this.sessionManager.createSession(userId, name, picker.currentPath);
        if ('error' in result) {
          await ctx.editMessageText(`❌ ${result.error}`);
        } else {
          await ctx.editMessageText(
            `✅ Created session: *${result.session.name}* ${result.session.emoji}\n\n` +
              `📁 \`${result.session.workingDir}\``,
            { parse_mode: 'Markdown' }
          );
        }
      } else {
        // change_dir
        this.sessionManager.setWorkingDir(userId, picker.currentPath);
        const session = this.sessionManager.getActiveSession(userId);
        await ctx.editMessageText(
          `📁 Working directory changed to:\n\`${picker.currentPath}\` ${session?.emoji || ''}`,
          { parse_mode: 'Markdown' }
        );
      }
    } else if (action === 'parent') {
      const parentPath = getParentPath(picker.currentPath);
      const directories = await listSubdirectories(parentPath);

      picker.currentPath = parentPath;
      this.activeDirectoryPickers.set(userId, picker);

      const keyboard = buildDirectoryPickerKeyboard(directories, canGoUp(parentPath));
      await ctx.editMessageText(
        `📂 *Select Directory*\n\nCurrent: \`${parentPath}\`\n\nChoose a folder or select this location:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    } else if (action === 'cancel') {
      this.activeDirectoryPickers.delete(userId);
      await ctx.editMessageText('Directory selection cancelled.');
    } else {
      // Navigate into subdirectory
      const newPath = `${picker.currentPath}/${action}`;
      const directories = await listSubdirectories(newPath);

      picker.currentPath = newPath;
      this.activeDirectoryPickers.set(userId, picker);

      const keyboard = buildDirectoryPickerKeyboard(directories, canGoUp(newPath));
      await ctx.editMessageText(
        `📂 *Select Directory*\n\nCurrent: \`${newPath}\`\n\nChoose a folder or select this location:`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }
  }

  /**
   * Handle question answer callbacks from AskUserQuestion
   */
  private async handleQuestionAnswerCallback(
    ctx: Context,
    userId: number,
    data: string
  ): Promise<void> {
    // Format: ask:<questionIndex>:<label>
    const parts = data.split(':');
    if (parts.length < 3) return;

    const questionIndex = Number.parseInt(parts[1], 10);
    const label = parts.slice(2).join(':'); // Label might contain colons

    const progress = this.questionProgress.get(userId);
    if (!progress || questionIndex !== progress.currentIndex) {
      await ctx.editMessageText('Question expired. Please try again.');
      return;
    }

    const question = progress.questions[questionIndex];

    if (label === '__other__') {
      // User wants to type a custom answer
      this.pendingQuestionAnswer.set(userId, {
        questions: progress.questions,
        index: questionIndex,
      });
      await ctx.editMessageText(
        `*${question.header}*\n\n${question.question}\n\n_Type your answer:_`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Record the answer and show confirmation
    await ctx.editMessageText(`✅ Selected: *${label}*`, { parse_mode: 'Markdown' });
    await this.recordAnswerAndContinue(ctx, userId, label);
  }

  /**
   * Display a single question with progress indicator
   */
  private async displayQuestion(
    ctx: Context,
    question: ClaudeQuestion,
    index: number,
    total: number,
    session?: UserSession
  ): Promise<void> {
    const header = question.header ? `*${question.header}*\n\n` : '';
    const progress = total > 1 ? ` (${index + 1}/${total})` : '';
    const text = `❓${progress} ${header}${question.question}`;

    let optionDetails = '';
    if (question.options.some((opt) => opt.description)) {
      optionDetails = `\n\n${question.options.map((opt) => `• *${opt.label}*: ${opt.description}`).join('\n')}`;
    }

    const shouldSilence = this.shouldSilenceNotification(session, 'user_question');
    await ctx.reply(`${text}${optionDetails}`, {
      parse_mode: 'Markdown',
      reply_markup: buildClaudeQuestionKeyboard(question, index),
      disable_notification: shouldSilence,
    });
  }

  /**
   * Record an answer and proceed to next question or send all answers to Claude
   */
  private async recordAnswerAndContinue(
    ctx: Context,
    userId: number,
    answer: string
  ): Promise<void> {
    const progress = this.questionProgress.get(userId);
    if (!progress) return;

    // Store this answer
    progress.answers.push(answer);
    progress.currentIndex++;

    // Check if there are more questions
    if (progress.currentIndex < progress.questions.length) {
      // Display next question
      const nextQuestion = progress.questions[progress.currentIndex];
      await this.displayQuestion(
        ctx,
        nextQuestion,
        progress.currentIndex,
        progress.questions.length
      );
    } else {
      // All questions answered - send all answers to Claude
      const formattedAnswers = this.formatAnswersForClaude(progress.questions, progress.answers);

      // Cleanup state
      this.questionProgress.delete(userId);
      this.activeQuestionSets.delete(userId);
      this.pendingQuestionAnswer.delete(userId);

      // Forward all answers to Claude
      await this.forwardToClaude(ctx, formattedAnswers);
    }
  }

  /**
   * Format collected answers as JSON for Claude
   */
  private formatAnswersForClaude(questions: ClaudeQuestion[], answers: string[]): string {
    // Format as JSON object mapping headers to answers
    const answerObj: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const key = questions[i].header || `question_${i + 1}`;
      answerObj[key] = answers[i];
    }
    return JSON.stringify(answerObj);
  }

  /**
   * Handle plan approval callbacks
   */
  private async handlePlanApprovalCallback(
    ctx: Context,
    userId: number,
    data: string
  ): Promise<void> {
    const action = data.replace('plan:', '');
    const session = this.sessionManager.getActiveSession(userId);

    if (!session) {
      await ctx.editMessageText('No active session.');
      return;
    }

    if (action === 'implement') {
      // Switch to bypassPermissions mode and keep context
      this.sessionManager.setMode(userId, 'bypassPermissions');
      await ctx.editMessageText(
        `✅ Switched to *bypass* mode ${session.emoji}\n\nSend a prompt to start implementation.`,
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'clear_implement') {
      // Switch mode AND clear Claude session for fresh start
      this.sessionManager.setMode(userId, 'bypassPermissions');
      this.sessionManager.setClaudeSessionId(userId, '');
      await ctx.editMessageText(
        `✅ Switched to *bypass* mode + cleared context ${session.emoji}\n\nSend a prompt to start fresh implementation.`,
        { parse_mode: 'Markdown' }
      );
    } else if (action === 'cancel') {
      await ctx.editMessageText(
        `Staying in *plan* mode ${session.emoji}\n\nContinue refining the plan or use /mode to change.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle settings callbacks
   */
  private async handleSettingsCallback(ctx: Context, userId: number, data: string): Promise<void> {
    // Format: settings:mode:<mode>
    const parts = data.split(':');
    if (parts.length < 3) return;

    const settingType = parts[1];
    const value = parts[2];

    if (settingType === 'mode') {
      const newMode = value as PermissionMode;
      if (!VALID_PERMISSION_MODES.includes(newMode)) {
        await ctx.editMessageText('Invalid mode.');
        return;
      }

      this.sessionManager.setDefaultMode(userId, newMode);
      await ctx.editMessageText(
        `✅ Default mode set to: *${newMode}*\n\nNew sessions will use this mode.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  /**
   * Handle notification mode callbacks
   */
  private async handleNotificationModeCallback(
    ctx: Context,
    userId: number,
    data: string
  ): Promise<void> {
    // Format: notif:<mode>
    const mode = data.replace('notif:', '') as NotificationMode;
    if (!VALID_NOTIFICATION_MODES.includes(mode)) {
      await ctx.editMessageText('Invalid notification mode.');
      return;
    }

    this.sessionManager.setNotificationMode(userId, mode);
    const session = this.sessionManager.getActiveSession(userId);
    const emoji = session?.emoji || '';
    await ctx.editMessageText(`Notification mode set to: *${mode}* ${emoji}`, {
      parse_mode: 'Markdown',
    });
  }

  /**
   * Determine if a notification should be silenced based on session settings
   */
  private shouldSilenceNotification(
    session: UserSession | undefined,
    actionType: TelegramAction['type']
  ): boolean {
    const mode = session?.notificationMode ?? 'default';
    if (mode === 'full') return false;
    if (mode === 'silent') return true;
    // default: only notification type (completion) is loud
    return actionType !== 'notification';
  }

  /**
   * Handle general text messages
   */
  private async handleMessage(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const text = ctx.message?.text?.trim();
    logger.log(`[handleMessage] userId=${userId}, text="${text?.slice(0, 50)}..."`);

    if (!userId || !text) {
      logger.log('[handleMessage] No userId or text, returning');
      return;
    }

    if (!this.isAuthorized(userId)) {
      logger.log('[handleMessage] User not authorized');
      await ctx.reply('You are not authorized. Send /start to request access.');
      return;
    }

    // Check if it's a command
    if (text.startsWith('/')) {
      const [cmd] = text.slice(1).split(' ');
      const cmdLower = cmd.toLowerCase();

      // Reserved bot commands are handled by specific handlers above
      if (this.RESERVED_COMMANDS.has(cmdLower)) {
        logger.log(`[handleMessage] Reserved command /${cmdLower}, skipping`);
        return; // Already handled by grammY command handlers
      }

      // Unknown command - show error
      logger.log(`[handleMessage] Unknown command /${cmdLower}`);
      await ctx.reply(`❓ Unknown command: /${cmd}\n\nUse /bothelp to see available commands.`);
      return;
    }

    // Check for pending question answer (user typed "Other" for a question)
    const pendingAnswer = this.pendingQuestionAnswer.get(userId);
    if (pendingAnswer) {
      this.pendingQuestionAnswer.delete(userId);
      logger.log(`[handleMessage] Handling pending question answer: "${text}"`);
      // Record typed answer and continue to next question or send all to Claude
      await this.recordAnswerAndContinue(ctx, userId, text);
      return;
    }

    // Bang mode: execute as bash command
    if (text.startsWith('!')) {
      const command = text.slice(1).trim();
      if (command) {
        logger.log(`[handleMessage] Bang mode: executing "${command}"`);
        return this.executeBashCommand(ctx, command);
      }
    }

    // Forward everything else to Claude
    logger.log('[handleMessage] Forwarding to Claude...');
    await this.forwardToClaude(ctx, text);
    logger.log('[handleMessage] Done forwarding to Claude');
  }

  /**
   * Forward a prompt to Claude and handle the response
   * Runs in background to avoid blocking the Telegram polling loop
   */
  private async forwardToClaude(ctx: Context, prompt: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const queryStartTime = Date.now();
    logger.log(
      `[user:${userId}] Forwarding to Claude: "${prompt.slice(0, 50)}..." (${prompt.length} chars)`
    );

    // Get or create session
    let session = this.sessionManager.getActiveSession(userId);
    if (!session) {
      const result = this.sessionManager.createSession(userId);
      if ('error' in result) {
        await ctx.reply(`❌ ${result.error}`);
        return;
      }
      session = result.session;
      logger.log(`[user:${userId}] Created new session: ${session.name}`);
    }

    // Check if THIS session is already processing a query
    const existingBridge = this.activeBridges.get(session.id);
    if (existingBridge?.isRunning()) {
      logger.log(`[user:${userId}] Session ${session.name} is busy, rejecting`);
      await ctx.reply(
        `⏳ Session "${session.name}" ${session.emoji} is busy.\n\n` +
          `Use /switch to another session, or /cancel to interrupt.`
      );
      return;
    }

    logger.log(
      `[user:${userId}] Session: ${session.name} ${session.emoji}, mode=${session.currentMode}, claudeSession=${session.claudeSessionId || 'new'}`
    );

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    // Create new bridge and formatter for this request
    const bridge = new ClaudeSDKBridge();
    const formatter = new OutputFormatter();
    formatter.setVerbosity(session.verbosity);
    formatter.setSessionEmoji(session.emoji);
    logger.log(`[user:${userId}] Created bridge and formatter (verbosity: ${session.verbosity})`);

    this.activeBridges.set(session.id, bridge);
    this.activeFormatters.set(session.id, formatter);

    // Track active query for /querystatus command
    this.activeQueries.set(session.id, {
      userId,
      sessionId: session.id,
      prompt,
      startTime: new Date(),
      currentTool: null,
    });

    // Store user message in conversation history
    if (this.conversationStore && session.claudeSessionId) {
      this.conversationStore.addMessage(session.claudeSessionId, {
        id: `user-${Date.now()}`,
        sessionId: session.claudeSessionId,
        role: 'user',
        content: prompt,
        timestamp: new Date(),
      });
    }

    // Handle events
    let statusMessageId: number | undefined;
    let lastMessageText = '';

    formatter.on('action', async (action) => {
      try {
        const shouldSilence = this.shouldSilenceNotification(session, action.type);

        if (action.type === 'message') {
          // Send or update message
          if (action.options && action.options.length > 0) {
            await ctx.reply(action.text, {
              reply_markup: buildOptionKeyboard(action.options),
              disable_notification: shouldSilence,
            });
          } else if (action.text !== lastMessageText) {
            await ctx.reply(action.text, { disable_notification: shouldSilence });
            lastMessageText = action.text;
          }
        } else if (action.type === 'status') {
          // Send status message
          const statusMsg = await ctx.reply(action.text, { disable_notification: shouldSilence });
          statusMessageId = statusMsg.message_id;
          // Update current tool in activeQueries for /querystatus
          const query = this.activeQueries.get(session!.id);
          if (query) {
            query.currentTool = action.text.replace('🔧 Using ', '').replace('...', '');
          }
        } else if (action.type === 'clear_status' && statusMessageId && ctx.chat?.id) {
          // Delete status message
          try {
            await ctx.api.deleteMessage(ctx.chat.id, statusMessageId);
          } catch (_e) {
            // Ignore if already deleted
          }
          statusMessageId = undefined;
          // Clear current tool in activeQueries
          const query = this.activeQueries.get(session!.id);
          if (query) {
            query.currentTool = null;
          }
        } else if (action.type === 'notification') {
          // Notification (completion indicator) - uses shouldSilence which checks for 'notification' type
          await ctx.reply(action.text, { disable_notification: shouldSilence });
        } else if (action.type === 'document') {
          // Send content as a downloadable file
          try {
            await ctx.replyWithDocument(
              new InputFile(Buffer.from(action.content, 'utf-8'), action.fileName),
              { caption: action.caption, disable_notification: shouldSilence }
            );

            // If this is a plan file and we're in plan mode, show approval buttons
            if (action.isPlan && session!.currentMode === 'plan') {
              await ctx.reply('📋 *Plan ready for review*\n\nWhat would you like to do?', {
                parse_mode: 'Markdown',
                reply_markup: buildPlanApprovalKeyboard(),
                disable_notification: shouldSilence,
              });
            }
          } catch (docError) {
            logger.error('Error sending document:', docError);
            // Fallback to sending as text (truncated if needed)
            const preview = action.content.slice(0, 3500);
            await ctx.reply(
              `📋 ${action.fileName}:\n\n${preview}${action.content.length > 3500 ? '\n\n...(truncated)' : ''}`,
              { disable_notification: shouldSilence }
            );
          }
        } else if (action.type === 'user_question') {
          // Handle Claude's AskUserQuestion tool - sequential question display
          console.log(
            `[telegram] Handling user_question with ${action.questions.length} question(s)`
          );

          // Initialize progress tracking
          this.questionProgress.set(userId, {
            questions: action.questions,
            currentIndex: 0,
            answers: [],
          });
          this.activeQuestionSets.set(userId, action.questions);

          // Display only the first question (with notification silencing)
          await this.displayQuestion(ctx, action.questions[0], 0, action.questions.length, session);
        }
      } catch (error) {
        logger.error('Error handling action:', error);
      }
    });

    bridge.on('event', (event) => {
      const action = formatter.handleEvent(event);
      if (action) {
        formatter.emit('action', action);
      }
    });

    bridge.on('error', async (errorText) => {
      logger.error('Claude error:', errorText);
      // Only send error if it's significant
      if (errorText.includes('Error') || errorText.includes('error')) {
        const shouldSilence = this.shouldSilenceNotification(session, 'status');
        await ctx.reply(`⚠️ ${errorText.slice(0, 200)} ${session!.emoji}`, {
          disable_notification: shouldSilence,
        });
      }
    });

    // Send periodic "still working" updates so user knows Claude is active
    let statusUpdateCount = 0;
    const statusInterval = setInterval(async () => {
      statusUpdateCount++;
      const tool = formatter.getCurrentTool();
      const minutes = statusUpdateCount; // 1 update per minute
      const shouldSilence = this.shouldSilenceNotification(session, 'status');

      try {
        if (tool) {
          // If using a tool, just show typing indicator
          await ctx.replyWithChatAction('typing');
        } else if (minutes % 2 === 0) {
          // Every 2 minutes if no tool activity, send a text message
          await ctx.reply(`⏳ Claude is still working... (${minutes} min) ${session!.emoji}`, {
            disable_notification: shouldSilence,
          });
        } else {
          // Odd minutes, just show typing indicator
          await ctx.replyWithChatAction('typing');
        }
      } catch (error) {
        logger.error('Error sending status update:', error);
      }
    }, 60_000); // Every minute

    // Capture session for closure
    const currentSession = session;

    // Clear interval and flush buffer when Claude process exits
    bridge.on('exit', async (code) => {
      clearInterval(statusInterval);

      // Flush any remaining buffered text
      if (formatter.hasPendingContent()) {
        const text = formatter.forceFlush();
        if (text) {
          try {
            // Add emoji suffix if not already present
            const textWithEmoji = text.endsWith(currentSession.emoji)
              ? text
              : `${text} ${currentSession.emoji}`;
            // Final buffer is treated as a message (not notification)
            const shouldSilence = this.shouldSilenceNotification(currentSession, 'message');
            await ctx.reply(textWithEmoji, { disable_notification: shouldSilence });
          } catch (error) {
            logger.error('Error sending final buffer:', error);
          }
        }
      }

      logger.log(`[forwardToClaude] Claude exited with code ${code}`);
    });

    // Run Claude query in background - don't await to avoid blocking polling
    const runQuery = async () => {
      try {
        logger.log(`[user:${userId}] Starting Claude query for session ${currentSession.name}...`);

        // No timeout - let Claude work as long as needed
        // User can always /cancel if needed
        const result = await bridge.query({
          prompt,
          sessionId: currentSession.claudeSessionId || undefined,
          mode: currentSession.currentMode,
          workingDir: currentSession.workingDir,
          unsafeMode: currentSession.unsafeMode,
        });

        const elapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
        logger.log(
          `[user:${userId}] Query completed in ${elapsed}s, session=${result.sessionId}, isError=${result.isError}`
        );

        // Update session with Claude session ID if new
        if (!currentSession.claudeSessionId && result.sessionId) {
          this.sessionManager.setClaudeSessionId(userId, result.sessionId);
          logger.log(`[user:${userId}] Updated session ID to ${result.sessionId}`);
        }

        // Store assistant response in conversation history
        if (this.conversationStore && result.sessionId && lastMessageText) {
          this.conversationStore.addMessage(result.sessionId, {
            id: `assistant-${Date.now()}`,
            sessionId: result.sessionId,
            role: 'assistant',
            content: lastMessageText,
            timestamp: new Date(),
          });
        }
      } catch (error) {
        const elapsed = ((Date.now() - queryStartTime) / 1000).toFixed(1);
        logger.error(`[user:${userId}] Query failed after ${elapsed}s:`, error);
        const shouldSilence = this.shouldSilenceNotification(currentSession, 'status');
        await ctx.reply(
          `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'} ${currentSession.emoji}`,
          { disable_notification: shouldSilence }
        );
      } finally {
        clearInterval(statusInterval);
        this.activeBridges.delete(currentSession.id);
        this.activeFormatters.delete(currentSession.id);
        this.activeQueries.delete(currentSession.id);
      }
    };

    // Fire and forget - don't block the handler
    runQuery().catch((error) => {
      logger.error('Unexpected error in runQuery:', error);
    });
  }

  /**
   * Execute a bash command directly (bang mode)
   */
  private async executeBashCommand(ctx: Context, command: string): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Get session for working directory
    const session = this.sessionManager.getActiveSession(userId);
    const workingDir = session?.workingDir ?? this.defaultWorkingDir;

    logger.log(`[user:${userId}] Executing bash command in ${workingDir}: ${command}`);

    await ctx.replyWithChatAction('typing');

    try {
      const { spawn } = await import('child_process');
      const proc = spawn('bash', ['-c', command], {
        cwd: workingDir,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('close', resolve);
        proc.on('error', () => resolve(null));
      });

      // Format output
      let output = '';
      if (stdout) output += stdout;
      if (stderr) output += (output ? '\n' : '') + stderr;

      // Truncate if too long for Telegram (4000 char limit)
      if (output.length > 3900) {
        output = `${output.slice(0, 3900)}\n...(truncated)`;
      }

      const prefix = exitCode === 0 ? '✓' : `✗ (exit ${exitCode})`;
      const emoji = session?.emoji ?? '';
      const reply = output
        ? `${prefix}\n\`\`\`\n${output}\n\`\`\` ${emoji}`
        : `${prefix} (no output) ${emoji}`;

      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch (error) {
      const emoji = session?.emoji ?? '';
      await ctx.reply(
        `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'} ${emoji}`
      );
    }
  }

  /**
   * Register bot commands with Telegram (shows in command menu)
   */
  private async registerCommands(): Promise<void> {
    try {
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Initialize the bot' },
        { command: 'new', description: 'Create a new named session' },
        { command: 'sessions', description: 'List all your sessions' },
        { command: 'switch', description: 'Switch to a different session' },
        { command: 'cd', description: 'Change working directory' },
        { command: 'delete', description: 'Delete a session' },
        { command: 'rename', description: 'Rename current session' },
        { command: 'cancel', description: 'Interrupt running operation' },
        { command: 'status', description: 'Show session status' },
        { command: 'querystatus', description: 'Show active query status' },
        { command: 'mode', description: 'Show or change permission mode' },
        { command: 'verbosity', description: 'Control output detail level' },
        { command: 'notifications', description: 'Control message notification sounds' },
        { command: 'settings', description: 'Manage default mode/directory' },
        { command: 'bothelp', description: 'Show help message' },
      ]);
      logger.log('Registered bot commands with Telegram');
    } catch (error) {
      logger.error('Failed to register bot commands:', error);
      // Don't throw - bot can still work without command menu
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    logger.log('Starting Telegram bot...');

    // Set up global error handler to prevent silent crashes
    this.bot.catch((err) => {
      logger.error('Bot error:', err);
    });

    await this.registerCommands();
    await this.bot.start({
      onStart: (botInfo) => {
        logger.log(chalk.green(`Bot @${botInfo.username} is running!`));
      },
    });
  }

  /**
   * Stop the bot
   */
  async stop(): Promise<void> {
    logger.log('Stopping Telegram bot...');

    // Cancel all active bridges
    for (const bridge of this.activeBridges.values()) {
      if (bridge.isRunning()) {
        bridge.cancel();
      }
    }

    await this.bot.stop();
    logger.log('Telegram bot stopped');
  }

  /**
   * Get the bot instance (for testing)
   */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Get session manager (for API integration)
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Add a user to the whitelist
   */
  addAllowedUser(userId: number): void {
    this.allowedUsers.add(userId);
  }

  /**
   * Remove a user from the whitelist
   */
  removeAllowedUser(userId: number): void {
    this.allowedUsers.delete(userId);
  }
}
