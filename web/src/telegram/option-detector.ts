/**
 * Option Detector
 *
 * Detects interactive options in Claude's output for generating inline keyboards.
 * Ported from terminal-chat-view.ts
 */

import type { InteractiveOption } from './types.js';

/**
 * Detect interactive options in content
 *
 * Supports:
 * - Gemini CLI format: "● 1. Yes, allow once"
 * - Numbered options: "1) Option one"
 * - Lettered options: "a) Option one"
 * - Bracketed options: "[1] Option one"
 * - Yes/No questions: "(y/n)"
 * - Permission prompts: "Allow execution of..."
 */
export function detectInteractiveOptions(content: string): InteractiveOption[] | null {
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

  // Detect numbered options like:
  // 1) Option one
  // 2) Option two
  const numberedPattern = /^\s*(\d+)\)\s+(.+)$/gm;
  const matches: InteractiveOption[] = [];

  for (const match of content.matchAll(numberedPattern)) {
    matches.push({ label: match[2].trim(), response: match[1] });
  }

  if (matches.length >= 2) {
    return matches;
  }

  // Detect lettered options like:
  // a) Option one
  // b) Option two
  const letteredPattern = /^\s*([a-z])\)\s+(.+)$/gm;
  const letterMatches: InteractiveOption[] = [];

  for (const match of content.matchAll(letteredPattern)) {
    letterMatches.push({ label: match[2].trim(), response: match[1] });
  }

  if (letterMatches.length >= 2) {
    return letterMatches;
  }

  // Detect bracketed options like:
  // [1] Option one
  // [2] Option two
  const bracketPattern = /^\s*\[(\d+)\]\s+(.+)$/gm;
  const bracketMatches: InteractiveOption[] = [];

  for (const match of content.matchAll(bracketPattern)) {
    bracketMatches.push({ label: match[2].trim(), response: match[1] });
  }

  if (bracketMatches.length >= 2) {
    return bracketMatches;
  }

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

  return null;
}
