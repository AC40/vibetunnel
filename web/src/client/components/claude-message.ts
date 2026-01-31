/**
 * Claude Message Component
 *
 * Displays a single message in the Claude chat view.
 */

import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';

interface ToolUse {
  name: string;
  status: 'running' | 'complete';
}

@customElement('claude-message')
export class ClaudeMessage extends LitElement {
  static styles = css`
    :host {
      display: block;
      margin-bottom: 1rem;
    }

    .message {
      display: flex;
      flex-direction: column;
      animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
      padding: 0 0.5rem;
    }

    .message-icon {
      font-size: 1rem;
    }

    .message-sender {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.025em;
      color: rgb(var(--color-text-muted));
    }

    .message-time {
      font-size: 0.625rem;
      color: rgb(var(--color-text-muted));
      opacity: 0.7;
    }

    .message-bubble {
      background-color: rgb(var(--color-bg-elevated));
      border-radius: 1rem;
      padding: 0.75rem 1rem;
      max-width: 85%;
      word-break: break-word;
    }

    .message.user .message-bubble {
      background: linear-gradient(135deg, #00a884 0%, #008f72 100%);
      color: white;
      align-self: flex-end;
      margin-left: auto;
    }

    .message.assistant .message-bubble {
      background-color: rgb(45 50 55);
      color: rgb(var(--color-text));
      align-self: flex-start;
    }

    .message-content {
      margin: 0;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
      font-size: 0.875rem;
      line-height: 1.5;
    }

    .tool-indicators {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid rgb(var(--color-border) / 0.3);
    }

    .tool-indicator {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.7rem;
      padding: 0.25rem 0.5rem;
      border-radius: 0.25rem;
      background-color: rgb(var(--color-bg) / 0.5);
    }

    .tool-indicator.running {
      color: rgb(var(--color-accent-blue));
    }

    .tool-indicator.complete {
      color: rgb(var(--color-status-success));
    }

    .tool-icon {
      font-size: 0.75rem;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .spinning {
      animation: spin 1s linear infinite;
    }
  `;

  @property({ type: String }) role: 'user' | 'assistant' = 'assistant';
  @property({ type: String }) content = '';
  @property({ type: String }) timestamp = '';
  @property({ type: Array }) toolUse: ToolUse[] = [];

  private formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  render() {
    const isUser = this.role === 'user';

    return html`
      <div class="message ${this.role}">
        <div class="message-header">
          <span class="message-icon">${isUser ? '👤' : '🤖'}</span>
          <span class="message-sender">${isUser ? 'You' : 'Claude'}</span>
          <span class="message-time">${this.formatTime(this.timestamp)}</span>
        </div>
        <div class="message-bubble">
          <pre class="message-content">${this.content}</pre>
          ${this.toolUse && this.toolUse.length > 0
            ? html`
                <div class="tool-indicators">
                  ${this.toolUse.map(
                    (tool) => html`
                      <div class="tool-indicator ${tool.status}">
                        <span class="tool-icon ${tool.status === 'running' ? 'spinning' : ''}">
                          ${tool.status === 'running' ? '⚙️' : '✓'}
                        </span>
                        <span>${tool.name}</span>
                      </div>
                    `
                  )}
                </div>
              `
            : ''}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-message': ClaudeMessage;
  }
}
