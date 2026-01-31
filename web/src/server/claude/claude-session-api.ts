/**
 * Claude Session API
 *
 * REST API endpoints for listing, viewing, and messaging Claude SDK sessions.
 */

import { Router } from 'express';
import type { ClaudeSessionInfo, PermissionMode } from '../../telegram/types.js';
import { ClaudeSDKBridge } from '../../telegram/claude-sdk-bridge.js';
import { OutputFormatter } from '../../telegram/output-formatter.js';
import type { ConversationStore } from './conversation-store.js';
import type { SessionManager } from '../../telegram/session-manager.js';

export interface ClaudeSessionApiConfig {
  conversationStore: ConversationStore;
  sessionManager: SessionManager;
}

export function createClaudeSessionRoutes(config: ClaudeSessionApiConfig): Router {
  const router = Router();
  const { conversationStore, sessionManager } = config;

  // Active bridges for web sessions
  const activeBridges = new Map<string, ClaudeSDKBridge>();

  /**
   * GET /api/claude-sessions
   * List all Claude SDK sessions
   */
  router.get('/claude-sessions', (_req, res) => {
    const sessions: ClaudeSessionInfo[] = [];

    // Get sessions from session manager (Telegram-initiated)
    for (const session of sessionManager.getAllSessions()) {
      if (session.claudeSessionId) {
        sessions.push({
          id: session.claudeSessionId,
          telegramUserId: session.telegramUserId,
          currentMode: session.currentMode,
          workingDir: session.workingDir,
          unsafeMode: session.unsafeMode,
          createdAt: session.createdAt.toISOString(),
          lastActivity: session.lastActivity.toISOString(),
          messageCount: conversationStore.getMessageCount(session.claudeSessionId),
        });
      }
    }

    // Also include sessions that only exist in conversation store (web-initiated)
    for (const sessionId of conversationStore.getAllSessionIds()) {
      const exists = sessions.some((s) => s.id === sessionId);
      if (!exists) {
        const history = conversationStore.getHistory(sessionId);
        const firstMessage = history[0];
        const lastMessage = history[history.length - 1];

        sessions.push({
          id: sessionId,
          currentMode: 'default',
          workingDir: process.cwd(),
          unsafeMode: false,
          createdAt: firstMessage?.timestamp.toISOString() || new Date().toISOString(),
          lastActivity: lastMessage?.timestamp.toISOString() || new Date().toISOString(),
          messageCount: history.length,
        });
      }
    }

    // Sort by last activity (most recent first)
    sessions.sort(
      (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );

    res.json(sessions);
  });

  /**
   * GET /api/claude-sessions/:id
   * Get session details and conversation history
   */
  router.get('/claude-sessions/:id', (req, res) => {
    const { id } = req.params;
    const history = conversationStore.getHistory(id);

    // Find session metadata
    let sessionInfo: ClaudeSessionInfo | null = null;
    for (const session of sessionManager.getAllSessions()) {
      if (session.claudeSessionId === id) {
        sessionInfo = {
          id: session.claudeSessionId,
          telegramUserId: session.telegramUserId,
          currentMode: session.currentMode,
          workingDir: session.workingDir,
          unsafeMode: session.unsafeMode,
          createdAt: session.createdAt.toISOString(),
          lastActivity: session.lastActivity.toISOString(),
          messageCount: history.length,
        };
        break;
      }
    }

    // If not found in session manager, create basic info from history
    if (!sessionInfo && history.length > 0) {
      const firstMessage = history[0];
      const lastMessage = history[history.length - 1];
      sessionInfo = {
        id,
        currentMode: 'default',
        workingDir: process.cwd(),
        unsafeMode: false,
        createdAt: firstMessage.timestamp.toISOString(),
        lastActivity: lastMessage.timestamp.toISOString(),
        messageCount: history.length,
      };
    }

    if (!sessionInfo && history.length === 0) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({
      session: sessionInfo,
      messages: history.map((m) => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
    });
  });

  /**
   * POST /api/claude-sessions/:id/messages
   * Send a message to a Claude session
   */
  router.post('/claude-sessions/:id/messages', async (req, res) => {
    const { id } = req.params;
    const { prompt, mode, workingDir } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    // Add user message to history
    conversationStore.addMessage(id, {
      id: `user-${Date.now()}`,
      sessionId: id,
      role: 'user',
      content: prompt,
      timestamp: new Date(),
    });

    // Create bridge for this request
    const bridge = new ClaudeSDKBridge();
    const formatter = new OutputFormatter();
    activeBridges.set(id, bridge);

    let responseContent = '';

    formatter.on('action', (action) => {
      if (action.type === 'message') {
        responseContent = action.text;
      }
    });

    bridge.on('event', (event) => {
      const action = formatter.handleEvent(event);
      if (action) {
        formatter.emit('action', action);
      }

      // Update tool use in conversation
      if (
        event.type === 'stream_event' &&
        event.event.type === 'content_block_start' &&
        event.event.content_block.type === 'tool_use'
      ) {
        conversationStore.updateToolUse(id, event.event.content_block.name || 'tool', 'running');
      }
      if (
        event.type === 'stream_event' &&
        event.event.type === 'content_block_stop'
      ) {
        // Mark any running tools as complete
        const history = conversationStore.getHistory(id);
        const lastMsg = history[history.length - 1];
        if (lastMsg?.toolUse) {
          for (const tool of lastMsg.toolUse) {
            if (tool.status === 'running') {
              conversationStore.updateToolUse(id, tool.name, 'complete');
            }
          }
        }
      }
    });

    try {
      const result = await bridge.query({
        prompt,
        sessionId: id !== 'new' ? id : undefined,
        mode: (mode as PermissionMode) || 'auto',
        workingDir: workingDir || process.cwd(),
      });

      // Add assistant message to history
      if (responseContent) {
        conversationStore.addMessage(result.sessionId || id, {
          id: `assistant-${Date.now()}`,
          sessionId: result.sessionId || id,
          role: 'assistant',
          content: responseContent,
          timestamp: new Date(),
        });
      }

      res.json({
        sessionId: result.sessionId,
        isError: result.isError,
        response: responseContent,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      activeBridges.delete(id);
    }
  });

  /**
   * POST /api/claude-sessions
   * Create a new Claude session
   */
  router.post('/claude-sessions', async (req, res) => {
    const { prompt, mode, workingDir } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'prompt is required to start a session' });
      return;
    }

    // Create a temporary ID for the new session
    const tempId = `new-${Date.now()}`;

    // Add user message to history
    conversationStore.addMessage(tempId, {
      id: `user-${Date.now()}`,
      sessionId: tempId,
      role: 'user',
      content: prompt,
      timestamp: new Date(),
    });

    const bridge = new ClaudeSDKBridge();
    const formatter = new OutputFormatter();
    activeBridges.set(tempId, bridge);

    let responseContent = '';

    formatter.on('action', (action) => {
      if (action.type === 'message') {
        responseContent = action.text;
      }
    });

    bridge.on('event', (event) => {
      const action = formatter.handleEvent(event);
      if (action) {
        formatter.emit('action', action);
      }
    });

    try {
      const result = await bridge.query({
        prompt,
        mode: (mode as PermissionMode) || 'auto',
        workingDir: workingDir || process.cwd(),
      });

      // Move messages to the real session ID
      if (result.sessionId && result.sessionId !== tempId) {
        const history = conversationStore.getHistory(tempId);
        for (const msg of history) {
          msg.sessionId = result.sessionId;
          conversationStore.addMessage(result.sessionId, msg);
        }
        conversationStore.clearHistory(tempId);
      }

      // Add assistant message
      const sessionId = result.sessionId || tempId;
      if (responseContent) {
        conversationStore.addMessage(sessionId, {
          id: `assistant-${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: responseContent,
          timestamp: new Date(),
        });
      }

      res.json({
        sessionId,
        isError: result.isError,
        response: responseContent,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      activeBridges.delete(tempId);
    }
  });

  /**
   * DELETE /api/claude-sessions/:id
   * Clear a session's history
   */
  router.delete('/claude-sessions/:id', (req, res) => {
    const { id } = req.params;
    conversationStore.clearHistory(id);
    res.json({ success: true });
  });

  /**
   * POST /api/claude-sessions/:id/cancel
   * Cancel a running Claude operation
   */
  router.post('/claude-sessions/:id/cancel', (req, res) => {
    const { id } = req.params;
    const bridge = activeBridges.get(id);

    if (bridge?.isRunning()) {
      bridge.cancel();
      res.json({ success: true, message: 'Operation cancelled' });
    } else {
      res.json({ success: false, message: 'No running operation to cancel' });
    }
  });

  return router;
}
