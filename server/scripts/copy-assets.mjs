#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const pairs = [
  { from: 'src/db/migrations', to: 'dist/db/migrations' },
];

for (const { from, to } of pairs) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  if (!existsSync(src)) {
    console.warn(`[copy-assets] skip (missing): ${from}`);
    continue;
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`[copy-assets] ${from} -> ${to}`);
}
