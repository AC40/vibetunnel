/**
 * Keyboard Builders for Telegram Bot
 *
 * Creates inline keyboards for interactive options.
 */

import { InlineKeyboard } from 'grammy';
import type { InteractiveOption } from './types.js';

/**
 * Build an inline keyboard from detected options
 */
export function buildOptionKeyboard(options: InteractiveOption[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const option of options) {
    // Truncate label if too long for button
    const label = option.label.length > 50 ? `${option.label.slice(0, 47)}...` : option.label;
    keyboard.text(`[${option.response}] ${label}`, `option:${option.response}`).row();
  }

  // Add cancel button
  keyboard.text('❌ Cancel', 'option:cancel');

  return keyboard;
}

/**
 * Build a simple yes/no confirmation keyboard
 */
export function buildConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('✅ Yes', 'confirm:yes').text('❌ No', 'confirm:no');
}

/**
 * Build a mode selection keyboard
 */
export function buildModeKeyboard(currentMode: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const modes = [
    { value: 'default', label: '👋 Default', description: 'Normal prompts' },
    { value: 'acceptEdits', label: '✏️ Accept Edits', description: 'Auto-accept edits' },
    { value: 'plan', label: '📝 Plan', description: 'Plan before executing' },
    { value: 'dontAsk', label: "🚀 Don't Ask", description: 'Skip all prompts' },
    { value: 'bypassPermissions', label: '⚠️ Bypass', description: 'Skip permission checks' },
  ];

  for (const mode of modes) {
    const isCurrent = mode.value === currentMode;
    const indicator = isCurrent ? ' ✓' : '';
    keyboard.text(`${mode.label}${indicator}`, `mode:${mode.value}`).row();
  }

  return keyboard;
}

/**
 * Build session list keyboard
 */
export function buildSessionListKeyboard(
  sessions: Array<{ id: string; name: string; isCurrent: boolean }>
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const session of sessions) {
    const indicator = session.isCurrent ? ' ✓' : '';
    const label = session.name.length > 30 ? `${session.name.slice(0, 27)}...` : session.name;
    keyboard.text(`${label}${indicator}`, `session:${session.id}`).row();
  }

  keyboard.text('➕ New Session', 'session:new');

  return keyboard;
}

/**
 * Build quick action keyboard for common operations
 */
export function buildQuickActionsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('📊 Status', 'quick:status')
    .text('📝 Changes', 'quick:changes')
    .row()
    .text('💾 Commit', 'quick:commit')
    .text('🚀 Push', 'quick:push')
    .row()
    .text('🔀 PR', 'quick:pr')
    .text('❌ Cancel', 'quick:cancel');
}
