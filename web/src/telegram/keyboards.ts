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

/**
 * Build directory picker keyboard for interactive folder navigation
 */
export function buildDirectoryPickerKeyboard(
  directories: string[],
  canGoUp: boolean
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Directory buttons (2 per row)
  for (let i = 0; i < directories.length; i += 2) {
    const row = directories.slice(i, i + 2);
    for (const dir of row) {
      // Truncate long directory names
      const label = dir.length > 18 ? `${dir.slice(0, 15)}...` : dir;
      keyboard.text(`📁 ${label}`, `dir:${dir}`);
    }
    keyboard.row();
  }

  // Action buttons
  keyboard.text('📂 Select This', 'dir:select');
  if (canGoUp) {
    keyboard.text('⬆️ Parent', 'dir:parent');
  }
  keyboard.row();
  keyboard.text('❌ Cancel', 'dir:cancel');

  return keyboard;
}

/**
 * Build session switcher keyboard
 */
export function buildSessionSwitcherKeyboard(
  sessions: Array<{ id: string; name: string; emoji: string; isActive: boolean }>
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const session of sessions) {
    const indicator = session.isActive ? ' ✓' : '';
    const label = session.name.length > 20 ? `${session.name.slice(0, 17)}...` : session.name;
    keyboard.text(`${session.emoji} ${label}${indicator}`, `switch:${session.id}`).row();
  }

  keyboard.text('➕ New Session', 'switch:new');

  return keyboard;
}

/**
 * Build delete confirmation keyboard
 */
export function buildDeleteConfirmKeyboard(sessionName: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('🗑️ Yes, delete', `delete:confirm:${sessionName}`)
    .text('❌ Cancel', 'delete:cancel');
}
