/**
 * Claude Input Component
 *
 * Message input field with send button for Claude chat.
 */

import { css, html, LitElement } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

@customElement('claude-input')
export class ClaudeInput extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .input-container {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      padding: 0.625rem 0.875rem;
      background-color: rgb(30 35 40);
      border-top: 1px solid rgb(50 55 60);
    }

    .input-field {
      flex: 1;
      padding: 0.75rem 1.125rem;
      background-color: rgb(45 50 55);
      border: 1px solid rgb(60 65 70);
      border-radius: 1.5rem;
      color: #ffffff;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Consolas, monospace;
      font-size: 16px;
      outline: none;
      resize: none;
      min-height: 1.5rem;
      max-height: 8rem;
      overflow-y: auto;
    }

    .input-field:focus {
      border-color: #00a884;
      background-color: rgb(50 55 60);
      box-shadow: 0 0 0 2px rgba(0, 168, 132, 0.2);
    }

    .input-field::placeholder {
      color: rgb(140 145 150);
      opacity: 1;
    }

    .send-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.75rem;
      height: 2.75rem;
      background: linear-gradient(135deg, #00a884 0%, #008f72 100%);
      border: none;
      border-radius: 50%;
      color: white;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
      box-shadow: 0 2px 6px rgba(0, 168, 132, 0.3);
    }

    .send-button:hover:not(:disabled) {
      background: linear-gradient(135deg, #00c49a 0%, #00a884 100%);
      transform: scale(1.05);
      box-shadow: 0 3px 10px rgba(0, 168, 132, 0.4);
    }

    .send-button:active:not(:disabled) {
      transform: scale(0.95);
    }

    .send-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .send-button svg {
      width: 1.25rem;
      height: 1.25rem;
      transform: rotate(-45deg);
    }

    .mode-selector {
      display: flex;
      gap: 0.25rem;
      padding: 0.25rem;
      background-color: rgb(35 40 45);
      border-radius: 0.5rem;
    }

    .mode-button {
      padding: 0.375rem 0.75rem;
      background: transparent;
      border: none;
      border-radius: 0.375rem;
      color: rgb(var(--color-text-muted));
      font-size: 0.75rem;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .mode-button:hover {
      color: rgb(var(--color-text));
    }

    .mode-button.active {
      background-color: rgb(55 60 65);
      color: rgb(var(--color-text));
    }
  `;

  @property({ type: Boolean }) disabled = false;
  @property({ type: Boolean }) loading = false;
  @property({ type: String }) placeholder = 'Type a message...';
  @property({ type: String }) mode: 'auto' | 'manual' | 'plan' = 'auto';
  @property({ type: Boolean }) showModeSelector = false;

  @query('.input-field') private inputElement!: HTMLTextAreaElement;
  @state() private inputValue = '';

  private handleInput(e: Event): void {
    const target = e.target as HTMLTextAreaElement;
    this.inputValue = target.value;

    // Auto-resize textarea
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 128)}px`;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleSend(): void {
    if (!this.inputValue.trim() || this.disabled || this.loading) return;

    this.dispatchEvent(
      new CustomEvent('send-message', {
        detail: {
          message: this.inputValue.trim(),
          mode: this.mode,
        },
        bubbles: true,
        composed: true,
      })
    );

    this.inputValue = '';
    if (this.inputElement) {
      this.inputElement.value = '';
      this.inputElement.style.height = 'auto';
    }
  }

  private handleModeChange(newMode: 'auto' | 'manual' | 'plan'): void {
    this.mode = newMode;
    this.dispatchEvent(
      new CustomEvent('mode-change', {
        detail: { mode: newMode },
        bubbles: true,
        composed: true,
      })
    );
  }

  focus(): void {
    this.inputElement?.focus();
  }

  render() {
    return html`
      <div class="input-container">
        ${
          this.showModeSelector
            ? html`
              <div class="mode-selector">
                <button
                  class="mode-button ${this.mode === 'auto' ? 'active' : ''}"
                  @click=${() => this.handleModeChange('auto')}
                  title="Auto mode - tools run automatically"
                >
                  🚀 Auto
                </button>
                <button
                  class="mode-button ${this.mode === 'plan' ? 'active' : ''}"
                  @click=${() => this.handleModeChange('plan')}
                  title="Plan mode - Claude plans before executing"
                >
                  📝 Plan
                </button>
              </div>
            `
            : ''
        }
        <textarea
          class="input-field"
          .value=${this.inputValue}
          placeholder=${this.placeholder}
          ?disabled=${this.disabled || this.loading}
          @input=${this.handleInput}
          @keydown=${this.handleKeyDown}
          rows="1"
        ></textarea>
        <button
          class="send-button"
          ?disabled=${!this.inputValue.trim() || this.disabled || this.loading}
          @click=${this.handleSend}
          title="Send message"
        >
          ${
            this.loading
              ? html`<span class="spinning">⏳</span>`
              : html`
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              `
          }
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'claude-input': ClaudeInput;
  }
}
