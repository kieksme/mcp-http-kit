#!/usr/bin/env node
/**
 * Build `dist/` when missing (git installs). Published npm tarballs already
 * include `dist`, so prepare is a no-op there and does not need typescript.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(root, 'dist', 'index.js');
const srcEntry = join(root, 'src', 'index.ts');
const tsconfig = join(root, 'tsconfig.build.json');

if (existsSync(distEntry) && process.env.MCP_HTTP_KIT_FORCE_PREPARE !== '1') {
  process.exit(0);
}

if (!existsSync(srcEntry) || !existsSync(tsconfig)) {
  console.error(
    '@kieksme/mcp-http-kit: dist is missing and sources are unavailable; cannot prepare',
  );
  process.exit(1);
}

console.info('@kieksme/mcp-http-kit: building dist (git install / missing build)…');

const localTsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const useLocal = existsSync(localTsc);
const result = useLocal
  ? spawnSync(process.execPath, [localTsc, '-p', 'tsconfig.build.json'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    })
  : spawnSync(
      'npx',
      ['--yes', '-p', 'typescript@5.9.3', 'tsc', '-p', 'tsconfig.build.json'],
      {
        cwd: root,
        stdio: 'inherit',
        env: process.env,
        shell: process.platform === 'win32',
      },
    );

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
