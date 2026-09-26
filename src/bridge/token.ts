import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

export const TOKEN_FILE_NAME = 'voxcode.token';

/**
 * Resolves the path to the ephemeral token file.
 * Prefers globalStorageUri, then VOXCODE_STORAGE_DIR, falling back to %TEMP%.
 */
export function getTokenPath(storage?: vscode.ExtensionContext | string): string {
  if (storage) {
    const dir = typeof storage === 'string' ? storage : storage.globalStorageUri.fsPath;
    return path.join(dir, TOKEN_FILE_NAME);
  }
  if (process.env.VOXCODE_STORAGE_DIR) {
    return path.join(process.env.VOXCODE_STORAGE_DIR, TOKEN_FILE_NAME);
  }
  const tempDir = process.env.TEMP || process.env.TMP || os.tmpdir();
  return path.join(tempDir, TOKEN_FILE_NAME);
}

/**
 * Attempts to read the authentication security token.
 * Checks VOXCODE_TOKEN environment variable first, then the specified or default file path.
 * Returns null if the token is not found or empty.
 */
export function readToken(customPath?: string): string | null {
  // 1. In-memory / process environment variable priority
  if (process.env.VOXCODE_TOKEN && process.env.VOXCODE_TOKEN.trim().length > 0) {
    return process.env.VOXCODE_TOKEN.trim();
  }

  // 2. File-based token storage
  const tokenPath = customPath || getTokenPath();
  try {
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, 'utf-8').trim();
      if (token.length > 0) {
        return token;
      }
    }
    return null;
  } catch (error) {
    console.warn(`[VoxCode] Failed to read token:`, error);
    return null;
  }
}
