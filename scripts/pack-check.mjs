#!/usr/bin/env node
/**
 * Sanity-check the npm pack contents before publish.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mcp-http-kit-pack-'));
try {
  const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
    encoding: 'utf8',
  });
  const [{ filename }] = JSON.parse(packed);
  const listing = execFileSync('tar', ['-tzf', join(dir, filename)], { encoding: 'utf8' });
  const files = listing.split('\n').filter(Boolean);
  const required = [
    'package/package.json',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/test/index.js',
    'package/README.md',
    'package/LICENSE',
    'package/templates/Dockerfile',
    'package/templates/railway.json',
    'package/templates/server.json',
    'package/templates/smithery.yaml',
    'package/docs/migration.md',
  ];
  const missing = required.filter(path => !files.includes(path));
  if (missing.length > 0) {
    console.error('pack:check missing files:\n' + missing.join('\n'));
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (pkg.name !== '@kieksme/mcp-http-kit') {
    console.error(`Unexpected package name: ${pkg.name}`);
    process.exit(1);
  }
  console.log(`pack:check ok (${files.length} files in ${filename})`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
