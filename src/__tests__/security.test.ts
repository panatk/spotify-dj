import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_DIR = path.join(import.meta.dirname, '..');
const ROOT_DIR = path.join(SRC_DIR, '..');

function readAllSourceFiles(): Array<{ name: string; content: string; path: string }> {
  const files: Array<{ name: string; content: string; path: string }> = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push({ name: entry.name, content: fs.readFileSync(full, 'utf-8'), path: full });
      }
    }
  }
  walk(SRC_DIR);
  return files;
}

function readAllTrackedFiles(): Array<{ name: string; content: string; path: string }> {
  const files: Array<{ name: string; content: string; path: string }> = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push({ name: entry.name, content: fs.readFileSync(full, 'utf-8'), path: full });
      }
    }
  }
  walk(ROOT_DIR);
  return files;
}

describe('Security: No hardcoded secrets', () => {
  const allFiles = readAllTrackedFiles();

  // Patterns that look like real secrets (not variable names or type definitions)
  const SECRET_PATTERNS = [
    // Spotify tokens (40+ char hex/base64)
    /(?:access_token|refresh_token|client_secret)\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/i,
    // Generic API keys
    /(?:api[_-]?key|apikey|secret[_-]?key)\s*[:=]\s*["'][A-Za-z0-9_-]{16,}["']/i,
    // GitHub tokens
    /gh[pousr]_[A-Za-z0-9_]{36,}/,
    // AWS keys
    /AKIA[0-9A-Z]{16}/,
    // Private keys
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
    // .env file content patterns
    /^[A-Z_]+=["']?[A-Za-z0-9_\-/+=]{20,}["']?\s*$/m,
  ];

  it('no source files contain hardcoded secrets', () => {
    for (const file of allFiles) {
      // Skip package-lock.json (has integrity hashes that look like secrets)
      if (file.name === 'package-lock.json') continue;
      // Skip test files
      if (file.path.includes('__tests__')) continue;

      for (const pattern of SECRET_PATTERNS) {
        const matches = file.content.match(pattern);
        if (matches) {
          // Allow patterns that are clearly template/placeholder values
          const match = matches[0];
          const isPlaceholder = /your_|example|placeholder|xxxxxx/i.test(match);
          const isEnvRef = /process\.env|env\./i.test(match);
          if (!isPlaceholder && !isEnvRef) {
            expect.fail(
              `Potential secret found in ${file.name}: ${match.slice(0, 40)}...`,
            );
          }
        }
      }
    }
  });
});

describe('Security: File permissions on all writes', () => {
  const sourceFiles = readAllSourceFiles();

  it('all writeFileSync calls include mode: 0o600', () => {
    for (const file of sourceFiles) {
      if (file.path.includes('__tests__')) continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('writeFileSync') && !lines[i].trim().startsWith('//')) {
          // Look at this line and the next few for the mode parameter
          const context = lines.slice(i, i + 5).join(' ');
          const hasMode = /mode:\s*0o600/.test(context);
          if (!hasMode) {
            expect.fail(
              `${file.name}:${i + 1} — writeFileSync without mode: 0o600`,
            );
          }
        }
      }
    }
  });

  it('all mkdirSync calls include mode: 0o700', () => {
    for (const file of sourceFiles) {
      if (file.path.includes('__tests__')) continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('mkdirSync') && !lines[i].trim().startsWith('//')) {
          const context = lines.slice(i, i + 5).join(' ');
          const hasMode = /mode:\s*0o700/.test(context);
          if (!hasMode) {
            expect.fail(
              `${file.name}:${i + 1} — mkdirSync without mode: 0o700`,
            );
          }
        }
      }
    }
  });
});

describe('Security: Shell injection protection', () => {
  const sourceFiles = readAllSourceFiles();

  it('no execSync/exec calls interpolate user-controlled variables', () => {
    // Safe patterns: hardcoded osascript commands, afplay, open with URL-encoded auth URL
    // Unsafe: template literals with variables from Spotify API responses (track names, artist names)
    for (const file of sourceFiles) {
      if (file.path.includes('__tests__')) continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if ((line.includes('execSync(') || line.includes('exec(')) && !line.trim().startsWith('//')) {
          // Check if it uses template literals with potentially dangerous variables
          // Safe: hardcoded strings, afplay with hardcoded path, open with authUrl
          // Dangerous: interpolating trackName, artistName, windowTitle, etc.
          const dangerous = /exec(?:Sync)?\s*\(\s*`[^`]*\$\{(?:track|artist|title|name|message|dj_info)/.test(
            lines.slice(i, i + 3).join(' '),
          );
          if (dangerous) {
            expect.fail(
              `${file.name}:${i + 1} — shell command interpolates user-controlled data`,
            );
          }
        }
      }
    }
  });

  it('notify.sh does not exist (was deleted for shell injection risk)', () => {
    const notifyShPath = path.join(ROOT_DIR, 'notify.sh');
    expect(fs.existsSync(notifyShPath)).toBe(false);
  });
});

describe('Security: OAuth server configuration', () => {
  it('OAuth callback server binds to 127.0.0.1 only', () => {
    const clientSrc = fs.readFileSync(path.join(SRC_DIR, 'spotify-client.ts'), 'utf-8');
    expect(clientSrc).toContain("server.listen(REDIRECT_PORT, '127.0.0.1')");
    // Must NOT have a bare server.listen(PORT) without host
    const bareListenPattern = /server\.listen\(\s*REDIRECT_PORT\s*\)/;
    expect(bareListenPattern.test(clientSrc)).toBe(false);
  });
});

describe('Security: .gitignore coverage', () => {
  it('.gitignore exists and covers sensitive patterns', () => {
    const gitignorePath = path.join(ROOT_DIR, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules');
    expect(content).toContain('dist');
    expect(content).toContain('.env');
  });
});

describe('Security: Credentials via environment variables', () => {
  it('spotify_auth reads from env vars before params', () => {
    const indexSrc = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf-8');
    expect(indexSrc).toContain('process.env.SPOTIFY_CLIENT_ID');
    expect(indexSrc).toContain('process.env.SPOTIFY_CLIENT_SECRET');
  });

  it('client_id and client_secret params are optional', () => {
    const indexSrc = fs.readFileSync(path.join(SRC_DIR, 'index.ts'), 'utf-8');
    // The zod schema should mark them as optional
    expect(indexSrc).toMatch(/client_id:\s*z\.string\(\)\.optional\(\)/);
    expect(indexSrc).toMatch(/client_secret:\s*z\.string\(\)\.optional\(\)/);
  });
});

describe('Security: No sensitive data in git-tracked files', () => {
  it('no .env files are tracked', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT_DIR, '.env.local'))).toBe(false);
  });

  it('no token/credential JSON files are tracked', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'tokens.json'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT_DIR, 'credentials.json'))).toBe(false);
  });
});
