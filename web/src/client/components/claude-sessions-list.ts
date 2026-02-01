/**
 * Claude Sessions List Component
 *
 * Displays a list of Claude SDK sessions (from Telegram or Web).
 */

import { css, html, LitElement } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createLogger } from '../utils/logger.js';
import { authClient } from '../services/auth-client.js';

const logger = createLogger('claude-sessions-list');

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

@customElement('claude-sessions-list')
export class ClaudeSessionsList extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow-y: auto;
      background-color: rgb(var(--color-bg-secondary));
    }

    .sessions-container {
      padding: 1rem;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid rgb(var(--color-border));
    }

    .header h2 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: rgb(var(--color-text));
    }

    .new-session-btn {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.5rem 1rem;
      background: linear-gradient(135deg, #00a884 0%, #008f72 100%);
      border: none;
      border-radius: 0.5rem;
      color: white;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .new-session-btn:hover {
      background: linear-gradient(135deg, #00c49a 0%, #00a884 100%);
      transform: translateY(-1px);
    }

    .session-card {
      background-color: rgb(var(--color-bg-elevated));
      border: 1px solid rgb(var(--color-border));
      border-radius: 0.5rem;
      padding: 1rem;
      margin-bottom: 0.75rem;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .session-card:hover {
      border-color: rgb(var(--color-accent-green));
      background-color: rgb(var(--color-bg-elevated) / 0.8);
    }

    .session-card.selected {
      border-color: rgb(var(--color-accent-green));
      background-color: rgb(var(--color-accent-green) / 0.1);
    }

    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 0.5rem;
    }

    .session-id {
      font-family: ui-monospace, monospace;
      font-size: 0.75rem;
      color: rgb(var(--color-text-muted));
      word-break: break-all;
    }

    .session-badges {
      display: flex;
      gap: 0.25rem;
      flex-shrink: 0;
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

    .badge-telegram {
      background-color: rgb(var(--color-accent-purple) / 0.2);
      color: rgb(var(--color-accent-purple));
    }

    .badge-unsafe {
      background-color: rgb(var(--color-status-error) / 0.2);
      color: rgb(var(--color-status-error));
    }

    .session-info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .session-info-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: rgb(var(--color-text-muted));
    }

    .session-info-row .icon {
      width: 1rem;
      opacity: 0.7;
    }

    .session-info-row .value {
      color: rgb(var(--color-text));
    }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: rgb(var(--color-text-muted));
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
      text-align: center;
      padding: 2rem;
      color: rgb(var(--color-text-muted));
    }
  `;

  @property({ type: String }) selectedSessionId: string | null = null;
  @state() private sessions: ClaudeSessionInfo[] = [];
  @state() private loading = true;
  @state() private error = '';

  connectedCallback(): void {
    super.connectedCallback();
    this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    this.loading = true;
    this.error = '';

    try {
      const response = await fetch('/api/claude-sessions', {
        headers: authClient.getAuthHeader(),
      });

      if (!response.ok) {
        throw new Error('Failed to load sessions');
      }

      this.sessions = await response.json();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Failed to load Claude sessions:', err);
    } finally {
      this.loading = false;
    }
  }

  private handleSessionClick(session: ClaudeSessionInfo): void {
    this.dispatchEvent(
      new CustomEvent('session-selected', {
        detail: { sessionId: session.id },
        bubbles: true,
        composed: true,
      })
    );
  }

  private handleNewSession(): void {
    this.dispatchEvent(
      new CustomEvent('new-session', {
        bubbles: true,
        composed: true,
      })
    );
  }

  private formatDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }

  render() {
    if (this.loading) {
      return html`<div class="loading">Loading sessions...</div>`;
    }

    if (this.error) {
      return html`<div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <div class="empty-state-title">Error Loading Sessions</div>
        <div>${this.error}</div>
      </div>`;
    }

    return html`
      <div class="sessions-container">
        <div class="header">
          <h2>Claude Sessions</h2>
          <button class="new-session-btn" @click=${this.handleNewSession}>
            <span>+</span>
            <span>New Session</span>
          </button>
        </div>

        ${this.sessions.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-state-icon">💬</div>
                <div class="empty-state-title">No Claude Sessions</div>
                <div>Start a new session to chat with Claude</div>
              </div>
            `
          : this.sessions.map(
              (session) => html`
                <div
                  class="session-card ${this.selectedSessionId === session.id ? 'selected' : ''}"
                  @click=${() => this.handleSessionClick(session)}
                >
                  <div class="session-header">
                    <div class="session-id">${session.id.slice(0, 12)}...</div>
                    <div class="session-badges">
                      <span class="badge badge-mode">${session.currentMode}</span>
                      ${session.telegramUserId
                        ? html`<span class="badge badge-telegram">Telegram</span>`
                        : ''}
                      ${session.unsafeMode
                        ? html`<span class="badge badge-unsafe">Unsafe</span>`
                        : ''}
                    </div>
                  </div>
                  <div class="session-info">
                    <div class="session-info-row">
                      <span class="icon">📁</span>
                      <span class="value">${session.workingDir}</span>
                    </div>
                    <div class="session-info-row">
                      <span class="icon">💬</span>
                      <span class="value">${session.messageCount} messages</span>
                    </div>
                    <div class="session-info-row">
                      <span class="icon">🕒</span>
                      <span class="value">${this.formatDate(session.lastActivity)}</span>
                    </div>
                  </div>
                </div>
              `
            )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-sessions-list': ClaudeSessionsList;
  }
}
