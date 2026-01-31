/**
 * Telegram Bot Service
 *
 * Main bot service that handles commands, messages, and Claude integration.
 */

import chalk from 'chalk';
import type { Context } from 'grammy';
import { Bot } from 'grammy';
import type { ConversationStore } from '../server/claude/conversation-store.js';
import { ClaudeSDKBridge } from './claude-sdk-bridge.js';
import { buildModeKeyboard, buildOptionKeyboard } from './keyboards.js';
import { OutputFormatter } from './output-formatter.js';
import { SessionManager } from './session-manager.js';
import type { PermissionMode } from './types.js';
import { VALID_PERMISSION_MODES } from './types.js';

// Create a simple logger
const createLogger = (name: string) => ({
  log: (...args: unknown[]) => console.log(chalk.blue(`[${name}]`), ...args),
  error: (...args: unknown[]) => console.error(chalk.red(`[${name}]`), ...args),
  warn: (...args: unknown[]) => console.warn(chalk.yellow(`[${name}]`), ...args),
  debug: (...args: unknown[]) => console.debug(chalk.gray(`[${name}]`), ...args),
});

const logger = createLogger('telegram-bot');

export interface TelegramBotServiceConfig {
  botToken: string;
  allowedUsers?: number[];
  allowUnsafeMode?: boolean;
  controlDir: string;
  conversationStore?: ConversationStore;
}

interface ActiveQuery {
  userId: number;
  prompt: string;
  startTime: Date;
  currentTool: string | null;
}

export class TelegramBotService {
  private bot: Bot;
  private sessionManager: SessionManager;
  private conversationStore?: ConversationStore;
  private allowedUsers: Set<number>;
  private allowUnsafeMode: boolean;
  private activeBridges = new Map<number, ClaudeSDKBridge>();
  private activeFormatters = new Map<number, OutputFormatter>();
  private activeQueries = new Map<number, ActiveQuery>();

  // Reserved bot commands (handled locally, not forwarded to Claude)
  private readonly RESERVED_COMMANDS = new Set([
    'start',
    'bothelp',
    'new',
    'sessions',
    'switch',
    'mode',
    'unsafe',
    'cancel',
    'querystatus',
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

  // Shortcut commands (translated to prompts for Claude)
  private readonly SHORTCUT_PROMPTS: Record<string, string> = {
    commit: 'Create a commit for the current changes with an appropriate message',
    push: 'Push the current branch to origin',
    pr: 'Create a pull request for the current branch',
    changes: 'Show me a summary of git changes (like git diff --stat)',
    status: "What's the current git status and working directory?",
  };

  constructor(config: TelegramBotServiceConfig) {
    this.bot = new Bot(config.botToken);
    this.sessionManager = new SessionManager(config.controlDir);
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
    this.bot.command('mode', (ctx) => this.handleMode(ctx));
    this.bot.command('unsafe', (ctx) => this.handleUnsafe(ctx));
    this.bot.command('cancel', (ctx) => this.handleCancel(ctx));
    this.bot.command('querystatus', (ctx) => this.handleQueryStatus(ctx));

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
    let session = this.sessionManager.getSession(userId);
    if (!session) {
      session = this.sessionManager.createSession(userId);
    }

    const welcomeMessage = `
🚀 *Welcome to VibeTunnel Claude Bot!*

Control Claude Code remotely through Telegram.

*Quick Start:*
• Just send a message to chat with Claude
• Use /new to start a fresh session
• Use /mode to change permission mode

*Current Session:*
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
/new [dir] - Start new session (optional: working directory)
/sessions - List your sessions
/switch <id> - Switch to a different session
/mode [mode] - Show or change permission mode
/unsafe - Toggle dangerously-skip-permissions mode

*Quick Responses:*
/1 - /9 - Send number to Claude
/y, /n - Send yes/no

*Control:*
/cancel - Interrupt running Claude process
/querystatus - Show current query status (elapsed time, tool)

*Shortcuts (sent as prompts):*
/commit [msg] - Create a commit
/push - Push current branch
/pr [title] - Create a pull request
/changes - Show git changes
/status - Show git status

*Claude Commands (forwarded directly):*
/help, /clear, /compact, /mode, etc.

Everything else you type is sent to Claude as a prompt.
    `.trim();

    await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
  }

  /**
   * Handle /new command
   */
  private async handleNew(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAuthorized(userId)) {
      await ctx.reply('Not authorized');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];
    const workingDir = args[0] || process.cwd();

    // Create new session
    const session = this.sessionManager.createSession(userId, workingDir);

    await ctx.reply(
      `✅ New session created!\n\nMode: ${session.currentMode}\nWorking Dir: \`${session.workingDir}\``,
      { parse_mode: 'Markdown' }
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

    const session = this.sessionManager.getSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const info = this.sessionManager.getSessionInfo(userId);
    await ctx.reply(`*Your Session:*\n\`\`\`\n${info}\n\`\`\``, { parse_mode: 'Markdown' });
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
      await ctx.reply('Usage: /switch <session_id>');
      return;
    }

    const sessionId = args[0];
    this.sessionManager.setClaudeSessionId(userId, sessionId);

    await ctx.reply(`Switched to session: \`${sessionId}\``, { parse_mode: 'Markdown' });
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

    const session = this.sessionManager.getSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const args = ctx.message?.text?.split(' ').slice(1) || [];

    if (args.length === 0) {
      // Show current mode with keyboard
      await ctx.reply(`Current mode: *${session.currentMode}*\n\nSelect a mode:`, {
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
    await ctx.reply(`Mode set to: *${newMode}*`, { parse_mode: 'Markdown' });
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

    const session = this.sessionManager.getSession(userId);
    if (!session) {
      await ctx.reply('No active session. Use /new to start one.');
      return;
    }

    const newValue = this.sessionManager.toggleUnsafeMode(userId);
    const status = newValue ? '🔓 ENABLED' : '🔒 disabled';
    const warning = newValue
      ? '\n\n⚠️ *Warning:* Claude will run tools without asking for permission!'
      : '';

    await ctx.reply(`Unsafe mode: ${status}${warning}`, { parse_mode: 'Markdown' });
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

    const bridge = this.activeBridges.get(userId);
    if (bridge?.isRunning()) {
      bridge.cancel();
      await ctx.reply('🛑 Cancelled running operation');
    } else {
      await ctx.reply('No running operation to cancel');
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

    const query = this.activeQueries.get(userId);
    if (!query) {
      await ctx.reply('No active query. Claude is idle.');
      return;
    }

    const elapsed = Math.floor((Date.now() - query.startTime.getTime()) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const tool = query.currentTool ? `\n🔧 Using: ${query.currentTool}` : '';

    await ctx.reply(
      `📊 *Active Query*\n\n` +
        `⏱ Running: ${minutes}m ${seconds}s\n` +
        `📝 Prompt: "${query.prompt.slice(0, 50)}..."${tool}`,
      { parse_mode: 'Markdown' }
    );
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

    if (data.startsWith('option:')) {
      const response = data.replace('option:', '');
      if (response === 'cancel') {
        const bridge = this.activeBridges.get(userId);
        if (bridge?.isRunning()) {
          bridge.cancel();
          await ctx.reply('🛑 Cancelled');
        }
      } else {
        await this.forwardToClaude(ctx, response);
      }
    } else if (data.startsWith('mode:')) {
      const mode = data.replace('mode:', '') as PermissionMode;
      this.sessionManager.setMode(userId, mode);
      await ctx.editMessageText(`Mode set to: *${mode}*`, { parse_mode: 'Markdown' });
    } else if (data.startsWith('quick:')) {
      const action = data.replace('quick:', '');
      const prompt = this.SHORTCUT_PROMPTS[action];
      if (prompt) {
        await this.forwardToClaude(ctx, prompt);
      } else if (action === 'cancel') {
        const bridge = this.activeBridges.get(userId);
        if (bridge?.isRunning()) {
          bridge.cancel();
          await ctx.reply('🛑 Cancelled');
        }
      }
    }
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
      const [cmd, ...args] = text.slice(1).split(' ');
      const cmdLower = cmd.toLowerCase();

      // Reserved bot commands are handled by specific handlers above
      if (this.RESERVED_COMMANDS.has(cmdLower)) {
        logger.log(`[handleMessage] Reserved command /${cmdLower}, skipping`);
        return; // Already handled by grammY command handlers
      }

      // Shortcut prompts (translate to Claude prompt)
      if (cmdLower in this.SHORTCUT_PROMPTS) {
        logger.log(`[handleMessage] Shortcut command /${cmdLower}`);
        const basePrompt = this.SHORTCUT_PROMPTS[cmdLower];
        const prompt = args.length > 0 ? `${basePrompt}: ${args.join(' ')}` : basePrompt;
        return this.forwardToClaude(ctx, prompt);
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

    // Check if already processing a query for this user
    const existingBridge = this.activeBridges.get(userId);
    if (existingBridge?.isRunning()) {
      await ctx.reply(
        '⏳ Claude is already working on a previous message. Use /cancel to interrupt, or wait for it to finish.'
      );
      return;
    }

    let session = this.sessionManager.getSession(userId);
    if (!session) {
      session = this.sessionManager.createSession(userId);
    }

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    // Create new bridge and formatter for this request
    const bridge = new ClaudeSDKBridge();
    const formatter = new OutputFormatter();

    this.activeBridges.set(userId, bridge);
    this.activeFormatters.set(userId, formatter);

    // Track active query for /querystatus command
    this.activeQueries.set(userId, {
      userId,
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
        if (action.type === 'message') {
          // Send or update message
          if (action.options && action.options.length > 0) {
            await ctx.reply(action.text, {
              reply_markup: buildOptionKeyboard(action.options),
            });
          } else if (action.text !== lastMessageText) {
            await ctx.reply(action.text);
            lastMessageText = action.text;
          }
        } else if (action.type === 'status') {
          // Send status message
          const statusMsg = await ctx.reply(action.text);
          statusMessageId = statusMsg.message_id;
          // Update current tool in activeQueries for /querystatus
          const query = this.activeQueries.get(userId);
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
          const query = this.activeQueries.get(userId);
          if (query) {
            query.currentTool = null;
          }
        } else if (action.type === 'notification') {
          await ctx.reply(action.text);
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
        await ctx.reply(`⚠️ ${errorText.slice(0, 200)}`);
      }
    });

    // Send periodic "still working" updates so user knows Claude is active
    let statusUpdateCount = 0;
    const statusInterval = setInterval(async () => {
      statusUpdateCount++;
      const tool = formatter.getCurrentTool();
      const minutes = statusUpdateCount; // 1 update per minute

      try {
        if (tool) {
          // If using a tool, just show typing indicator
          await ctx.replyWithChatAction('typing');
        } else if (minutes % 2 === 0) {
          // Every 2 minutes if no tool activity, send a text message
          await ctx.reply(`⏳ Claude is still working... (${minutes} min)`);
        } else {
          // Odd minutes, just show typing indicator
          await ctx.replyWithChatAction('typing');
        }
      } catch (error) {
        logger.error('Error sending status update:', error);
      }
    }, 60_000); // Every minute

    // Clear interval and flush buffer when Claude process exits
    bridge.on('exit', async (code) => {
      clearInterval(statusInterval);

      // Flush any remaining buffered text
      if (formatter.hasPendingContent()) {
        const text = formatter.forceFlush();
        if (text) {
          try {
            await ctx.reply(text);
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
        logger.log('[forwardToClaude] Starting Claude query...');

        // No timeout - let Claude work as long as needed
        // User can always /cancel if needed
        const result = await bridge.query({
          prompt,
          sessionId: session.claudeSessionId || undefined,
          mode: session.currentMode,
          workingDir: session.workingDir,
          unsafeMode: session.unsafeMode,
        });
        logger.log('[forwardToClaude] Claude query completed');

        // Update session with Claude session ID if new
        if (!session.claudeSessionId && result.sessionId) {
          this.sessionManager.setClaudeSessionId(userId, result.sessionId);
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
        logger.error('Claude query failed:', error);
        await ctx.reply(`❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      } finally {
        clearInterval(statusInterval);
        this.activeBridges.delete(userId);
        this.activeFormatters.delete(userId);
        this.activeQueries.delete(userId);
      }
    };

    // Fire and forget - don't block the handler
    runQuery().catch((error) => {
      logger.error('Unexpected error in runQuery:', error);
    });
  }

  /**
   * Register bot commands with Telegram (shows in command menu)
   */
  private async registerCommands(): Promise<void> {
    try {
      await this.bot.api.setMyCommands([
        { command: 'start', description: 'Initialize the bot' },
        { command: 'new', description: 'Start a new Claude session' },
        { command: 'sessions', description: 'Show current session info' },
        { command: 'switch', description: 'Switch to a different session' },
        { command: 'cancel', description: 'Interrupt running operation' },
        { command: 'querystatus', description: 'Show current query status' },
        { command: 'mode', description: 'Show or change permission mode' },
        { command: 'bothelp', description: 'Show help message' },
        // Shortcut commands
        { command: 'commit', description: 'Create a git commit' },
        { command: 'push', description: 'Push to origin' },
        { command: 'pr', description: 'Create a pull request' },
        { command: 'changes', description: 'Show git diff summary' },
        { command: 'status', description: 'Show git status' },
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
