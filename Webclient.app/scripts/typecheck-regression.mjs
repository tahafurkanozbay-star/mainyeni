#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [, , baselinePath, currentPath] = process.argv;
if (!baselinePath || !currentPath) {
  console.error('Usage: node scripts/typecheck-regression.mjs <baseline-log> <current-log>');
  process.exit(2);
}

const DIAGNOSTIC = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const normalizePath = (value) => value
  .replaceAll('\\', '/')
  .replace(/^.*\/Webclient\.app\//, '')
  .replace(/^\.\//, '');

const readDiagnostics = (file) => {
  const content = fs.readFileSync(path.resolve(file), 'utf8');
  const diagnostics = new Map();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(DIAGNOSTIC);
    if (!match) continue;
    const [, fileName, , , code, message] = match;
    const key = `${normalizePath(fileName)}|${code}|${message.trim()}`;
    diagnostics.set(key, line.trim());
  }
  return diagnostics;
};

const baseline = readDiagnostics(baselinePath);
const current = readDiagnostics(currentPath);
const added = [...current.entries()].filter(([key]) => !baseline.has(key));
const resolved = [...baseline.keys()].filter((key) => !current.has(key));

console.log(`[typecheck:regression] baseline diagnostics: ${baseline.size}`);
console.log(`[typecheck:regression] current diagnostics: ${current.size}`);
console.log(`[typecheck:regression] resolved diagnostics: ${resolved.length}`);
console.log(`[typecheck:regression] added diagnostics: ${added.length}`);

if (added.length > 0) {
  console.error('[typecheck:regression] New TypeScript diagnostics are not allowed:');
  for (const [, line] of added) console.error(`  ${line}`);
  process.exit(1);
}

console.log('[typecheck:regression] PASS: candidate introduces no new TypeScript diagnostics versus exact PR base.');
