/**
 * Claude Session WebSocket
 *
 * Provides real-time updates for Claude SDK sessions via WebSocket.
 */

import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { ConversationStore } from './conversation-store.js';

export interface ClaudeSessionWsConfig {
  wss: WebSocketServer;
  conversationStore: ConversationStore;
}

interface ClientConnection {
  ws: WebSocket;
  sessionId: string;
}

export class ClaudeSessionWsHandler {
  private clients = new Map<WebSocket, ClientConnection>();
  private conversationStore: ConversationStore;

  constructor(config: ClaudeSessionWsConfig) {
    this.conversationStore = config.conversationStore;

    // Listen for conversation updates
    this.conversationStore.on('message', ({ sessionId, message }) => {
      this.broadcastToSession(sessionId, {
        type: 'message',
        sessionId,
        message: {
          ...message,
          timestamp: message.timestamp.toISOString(),
        },
      });
    });
  }

  /**
   * Handle new WebSocket connection for Claude sessions
   */
  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Extract session ID from URL path
    // Expected format: /api/claude-sessions/:id/ws
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const match = url.pathname.match(/\/api\/claude-sessions\/([^/]+)\/ws/);

    if (!match) {
      ws.close(4000, 'Invalid session path');
      return;
    }

    const sessionId = match[1];

    // Register client
    this.clients.set(ws, { ws, sessionId });

    // Send initial history
    const history = this.conversationStore.getHistory(sessionId);
    ws.send(
      JSON.stringify({
        type: 'history',
        sessionId,
        messages: history.map((m) => ({
          ...m,
          timestamp: m.timestamp.toISOString(),
        })),
      })
    );

    // Handle client messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(ws, sessionId, message);
      } catch (_e) {
        // Invalid JSON, ignore
      }
    });

    // Cleanup on close
    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }

  /**
   * Handle messages from clients
   */
  private handleClientMessage(
    _ws: WebSocket,
    _sessionId: string,
    message: { type: string; [key: string]: unknown }
  ): void {
    switch (message.type) {
      case 'subscribe':
        // Client wants to subscribe to a different session
        if (typeof message.sessionId === 'string') {
          const client = this.clients.get(_ws);
          if (client) {
            client.sessionId = message.sessionId;
            // Send history for new session
            const history = this.conversationStore.getHistory(message.sessionId);
            _ws.send(
              JSON.stringify({
                type: 'history',
                sessionId: message.sessionId,
                messages: history.map((m) => ({
                  ...m,
                  timestamp: m.timestamp.toISOString(),
                })),
              })
            );
          }
        }
        break;

      case 'ping':
        _ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }

  /**
   * Broadcast message to all clients subscribed to a session
   */
  private broadcastToSession(sessionId: string, data: object): void {
    const message = JSON.stringify(data);

    for (const client of this.clients.values()) {
      if (client.sessionId === sessionId && client.ws.readyState === 1) {
        client.ws.send(message);
      }
    }
  }

  /**
   * Get number of connected clients for a session
   */
  getClientCount(sessionId: string): number {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.sessionId === sessionId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all active session IDs with connections
   */
  getActiveSessionIds(): string[] {
    const sessionIds = new Set<string>();
    for (const client of this.clients.values()) {
      sessionIds.add(client.sessionId);
    }
    return Array.from(sessionIds);
  }
}
