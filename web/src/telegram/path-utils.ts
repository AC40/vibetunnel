/**
 * Path utilities for Telegram bot path resolution and validation
 */

import * as fs from 'fs';
import * as path from 'path';
import { expandTildePath } from '../server/utils/path-utils.js';

export interface PathValidationResult {
  valid: boolean;
  resolved: string;
  error?: string;
}

/**
 * Resolve and validate a path for use as a working directory
 * - Expands ~ to home directory
 * - Resolves relative paths from basePath
 * - Validates that the path exists and is a directory
 */
export function resolveAndValidatePath(inputPath: string, basePath: string): PathValidationResult {
  // Expand ~ to home directory
  let resolved = expandTildePath(inputPath);

  // If relative, resolve from basePath
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(basePath, resolved);
  }

  // Check existence
  if (!fs.existsSync(resolved)) {
    return { valid: false, resolved, error: `Directory does not exist: ${resolved}` };
  }

  // Check it's a directory
  try {
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      return { valid: false, resolved, error: `Not a directory: ${resolved}` };
    }
  } catch (_error) {
    return {
      valid: false,
      resolved,
      error: `Cannot access: ${resolved}`,
    };
  }

  return { valid: true, resolved };
}

/**
 * List subdirectories in a given path
 * Returns only visible directories (not starting with .)
 */
export async function listSubdirectories(dirPath: string, limit = 8): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Check if a path can go up (has a parent that's not root)
 */
export function canGoUp(dirPath: string): boolean {
  const parent = path.dirname(dirPath);
  return parent !== dirPath; // root directory has parent === itself
}

/**
 * Get parent directory path
 */
export function getParentPath(dirPath: string): string {
  return path.dirname(dirPath);
}

/**
 * Get directory name from path
 */
export function getDirectoryName(dirPath: string): string {
  return path.basename(dirPath) || dirPath;
}
