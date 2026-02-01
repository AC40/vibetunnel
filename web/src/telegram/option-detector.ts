/**
 * Option Detector
 *
 * Detects interactive options in Claude's output for generating inline keyboards.
 *
 * NOTE: For Claude's AskUserQuestion tool, detection happens in output-formatter.ts
 * by parsing the tool input JSON directly. This file only handles legacy/external
 * question formats like yes/no prompts and Gemini CLI format.
 */

import type { InteractiveOption } from './types.js';

/**
 * Detect interactive options in content
 *
 * Supports:
 * - Yes/No questions: "(y/n)"
 * - Permission prompts: "Allow execution of..."
 * - Gemini CLI format: "● 1. Yes, allow once"
 *
 * NOTE: Numbered lists (1), 2), etc.) are NOT detected here because they cause
 * false positives when Claude outputs informational numbered lists. Claude's
 * proper question format (AskUserQuestion tool) is detected in output-formatter.ts.
 */
export function detectInteractiveOptions(content: string): InteractiveOption[] | null {
  // Detect yes/no questions
  if (/\(y\/n\)|\[y\/n\]|yes\/no/i.test(content)) {
    return [
      { label: 'Yes', response: 'y' },
      { label: 'No', response: 'n' },
    ];
  }

  // Detect "Allow execution" prompts (Claude Code permission dialogs)
  if (/Allow execution of/i.test(content)) {
    return [
      { label: 'Yes, allow once', response: '1' },
      { label: 'Yes, allow always', response: '2' },
      { label: 'No', response: '3' },
    ];
  }

  // Detect Gemini CLI permission format like:
  // ● 1. Yes, allow once
  //   2. Yes, allow always ...
  //   3. No, suggest changes (esc)
  const geminiPattern = /[●\s]*(\d+)\.\s+(.+?)(?:\s*\.{3}|\s*\(esc\))?$/gm;
  const geminiMatches: InteractiveOption[] = [];

  for (const match of content.matchAll(geminiPattern)) {
    const label = match[2]
      .trim()
      .replace(/\s*\.{3}$/, '')
      .replace(/\s*\(esc\)$/, '');
    geminiMatches.push({ label, response: match[1] });
  }

  if (geminiMatches.length >= 2) {
    return geminiMatches;
  }

  return null;
}
