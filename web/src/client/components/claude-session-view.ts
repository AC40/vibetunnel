/**
 * Claude Session View Component
 *
 * Chat view for a single Claude SDK session.
 */

import { css, html, LitElement } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { authClient } from '../services/auth-client.js';
import { createLogger } from '../utils/logger.js';
import './claude-message.js';
import './claude-input.js';

const logger = createLogger('claude-session-view');

interface ConversationMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  toolUse?: Array<{ name: string; status: 'running' | 'complete' }>;
  timestamp: string;
}

interface ClaudeSessionInfo {
  id: string;
  telegramUserId?: number;
  currentMode: string;
  workingDir: string;
  unsafeMode: boolean;
  createdAt: string;
  lastActivity: string;
  messageCount: number;
}

@customElement('claude-session-view')
export class ClaudeSessionView extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background-color: rgb(var(--color-bg));
    }

    .session-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background-color: rgb(var(--color-bg-secondary));
      border-bottom: 1px solid rgb(var(--color-border));
    }

    .session-info {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .back-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      background: transparent;
      border: none;
      border-radius: 0.375rem;
      color: rgb(var(--color-text-muted));
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .back-button:hover {
      background-color: rgb(var(--color-bg-elevated));
      color: rgb(var(--color-text));
    }

    .session-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: rgb(var(--color-text));
    }

    .session-subtitle {
      font-size: 0.7rem;
      color: rgb(var(--color-text-muted));
      font-family: ui-monospace, monospace;
    }

    .session-badges {
      display: flex;
      gap: 0.25rem;
    }

    .badge {
      font-size: 0.625rem;
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      text-transform: uppercase;
      font-weight: 600;
    }

    .badge-mode {
      background-color: rgb(var(--color-accent-blue) / 0.2);
      color: rgb(var(--color-accent-blue));
    }

    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      padding-top: 2rem;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: rgb(var(--color-text-muted));
      padding: 2rem;
    }

    .empty-state-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .empty-state-title {
      font-size: 1.125rem;
      font-weight: 500;
      color: rgb(var(--color-text));
      margin-bottom: 0.5rem;
    }

    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: rgb(var(--color-text-muted));
    }

    .error {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: rgb(var(--color-status-error));
      padding: 2rem;
    }
  `;

  @property({ type: String }) sessionId: string | null = null;
  @state() private session: ClaudeSessionInfo | null = null;
  @state() private messages: ConversationMessage[] = [];
  @state() private loading = true;
  @state() private error = '';
  @state() private sending = false;
  @state() private mode: 'auto' | 'manual' | 'plan' = 'auto';

  @query('.messages-container') private messagesContainer!: HTMLElement;

  private ws: WebSocket | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.sessionId) {
      this.loadSession();
      this.connectWebSocket();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disconnectWebSocket();
  }

  updated(changedProperties: Map<string, unknown>): void {
    if (changedProperties.has('sessionId') && this.sessionId) {
      this.loadSession();
      this.reconnectWebSocket();
    }
  }

  private async loadSession(): Promise<void> {
    if (!this.sessionId) return;

    this.loading = true;
    this.error = '';

    try {
      const response = await fetch(`/api/claude-sessions/${this.sessionId}`, {
        headers: authClient.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error('Session not found');
      }

      const data = await response.json();
      this.session = data.session;
      this.messages = data.messages;
      this.mode = (this.session?.currentMode as typeof this.mode) || 'auto';

      // Scroll to bottom
      this.updateComplete.then(() => this.scrollToBottom());
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Failed to load Claude session:', err);
    } finally {
      this.loading = false;
    }
  }

  private connectWebSocket(): void {
    if (!this.sessionId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/claude-sessions/${this.sessionId}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);
      };

      this.ws.onclose = () => {
        logger.debug('WebSocket closed');
      };

      this.ws.onerror = (error) => {
        logger.error('WebSocket error:', error);
      };
    } catch (err) {
      logger.error('Failed to connect WebSocket:', err);
    }
  }

  private disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private reconnectWebSocket(): void {
    this.disconnectWebSocket();
    this.connectWebSocket();
  }

  private handleWebSocketMessage(data: { type: string; message?: ConversationMessage }): void {
    if (data.type === 'message' && data.message) {
      // Update or add message
      const existingIndex = this.messages.findIndex((m) => m.id === data.message?.id);
      if (existingIndex >= 0) {
        this.messages = [
          ...this.messages.slice(0, existingIndex),
          data.message,
          ...this.messages.slice(existingIndex + 1),
        ];
      } else {
        this.messages = [...this.messages, data.message];
      }
      this.scrollToBottom();
    }
  }

  private async handleSendMessage(e: CustomEvent): Promise<void> {
    const { message, mode } = e.detail;
    if (!message || this.sending) return;

    this.sending = true;

    // Optimistically add user message
    const tempUserMessage: ConversationMessage = {
      id: `temp-user-${Date.now()}`,
      sessionId: this.sessionId || '',
      role: 'user',
      content: message,
      timestamp: new Date().toISOString(),
    };
    this.messages = [...this.messages, tempUserMessage];
    this.scrollToBottom();

    try {
      const endpoint = this.sessionId
        ? `/api/claude-sessions/${this.sessionId}/messages`
        : '/api/claude-sessions';

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authClient.getAuthHeader(),
        },
        body: JSON.stringify({
          prompt: message,
          mode,
          workingDir: this.session?.workingDir,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const result = await response.json();

      // If this was a new session, update the session ID
      if (!this.sessionId && result.sessionId) {
        this.sessionId = result.sessionId;
        this.dispatchEvent(
          new CustomEvent('session-created', {
            detail: { sessionId: result.sessionId },
            bubbles: true,
            composed: true,
          })
        );
      }

      // Reload to get the response (or it will come via WebSocket)
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.loadSession();
      }
    } catch (err) {
      logger.error('Failed to send message:', err);
      // Remove the optimistic message on error
      this.messages = this.messages.filter((m) => m.id !== tempUserMessage.id);
    } finally {
      this.sending = false;
    }
  }

  private scrollToBottom(): void {
    if (this.messagesContainer) {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }

  private handleBack(): void {
    this.dispatchEvent(
      new CustomEvent('back', {
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    if (this.loading && !this.session) {
      return html`<div class="loading">Loading session...</div>`;
    }

    if (this.error) {
      return html`
        <div class="error">
          <div>⚠️ ${this.error}</div>
          <button @click=${this.handleBack}>Go Back</button>
        </div>
      `;
    }

    return html`
      <div class="session-header">
        <div class="session-info">
          <button class="back-button" @click=${this.handleBack} title="Back to list">
            ←
          </button>
          <div>
            <div class="session-title">
              Claude Session ${this.session?.id.slice(0, 8) || 'New'}
            </div>
            <div class="session-subtitle">${this.session?.workingDir || process.cwd()}</div>
          </div>
        </div>
        <div class="session-badges">
          <span class="badge badge-mode">${this.mode}</span>
        </div>
      </div>

      <div class="messages-container">
        ${
          this.messages.length === 0
            ? html`
              <div class="empty-state">
                <div class="empty-state-icon">💬</div>
                <div class="empty-state-title">Start a Conversation</div>
                <div>Send a message to start chatting with Claude</div>
              </div>
            `
            : this.messages.map(
                (msg) => html`
                <claude-message
                  .role=${msg.role}
                  .content=${msg.content}
                  .timestamp=${msg.timestamp}
                  .toolUse=${msg.toolUse || []}
                ></claude-message>
              `
              )
        }
      </div>

      <claude-input
        .disabled=${false}
        .loading=${this.sending}
        .mode=${this.mode}
        .showModeSelector=${true}
        placeholder="Message Claude..."
        @send-message=${this.handleSendMessage}
        @mode-change=${(e: CustomEvent) => (this.mode = e.detail.mode)}
      ></claude-input>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-session-view': ClaudeSessionView;
  }
}
