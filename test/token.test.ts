import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readToken, getTokenPath, TOKEN_FILE_NAME } from '../src/bridge/token';

describe('Token Discovery', () => {
  it('returns default token path in temp directory', () => {
    const tokenPath = getTokenPath();
    assert.ok(tokenPath.endsWith(TOKEN_FILE_NAME));
    assert.ok(tokenPath.length > TOKEN_FILE_NAME.length);
  });

  it('returns null when token file does not exist', () => {
    const nonExistentPath = path.join(os.tmpdir(), 'non_existent_token_' + Date.now());
    assert.equal(readToken(nonExistentPath), null);
  });

  it('reads token successfully from file', () => {
    const tempFile = path.join(os.tmpdir(), 'test_voxcode_' + Date.now() + '.token');
    try {
      const secret = 'super_secret_token_12345';
      fs.writeFileSync(tempFile, secret + '\n', 'utf-8');
      assert.equal(readToken(tempFile), secret);
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });

  it('returns null for empty token file', () => {
    const tempFile = path.join(os.tmpdir(), 'empty_voxcode_' + Date.now() + '.token');
    try {
      fs.writeFileSync(tempFile, '   \n  ', 'utf-8');
      assert.equal(readToken(tempFile), null);
    } finally {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    }
  });
});
