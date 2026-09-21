import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const storeDir = join(currentDir, '..');

const walk = (directory: string): string[] => {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(path));
    else output.push(path);
  }
  return output;
};

describe('Store runtime production boundary', () => {
  it('keeps production Store runtime entirely in TypeScript', () => {
    const productionJs = walk(storeDir)
      .filter((path) => ['.js', '.jsx'].includes(extname(path)))
      .filter((path) => !path.includes('.test.'))
      .map((path) => relative(storeDir, path));
    expect(productionJs).toEqual([]);
  });

  it('does not introduce direct network, telemetry or browser persistence transports', () => {
    const forbidden = [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /XMLHttpRequest/,
      /WebSocket/,
      /EventSource/,
      /localStorage/,
      /sessionStorage/,
      /indexedDB/,
    ];
    const offenders: string[] = [];
    for (const path of walk(currentDir).filter((item) => item.endsWith('.ts') && !item.includes('.test.'))) {
      const source = readFileSync(path, 'utf8');
      if (forbidden.some((pattern) => pattern.test(source))) {
        offenders.push(relative(storeDir, path));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps runtime history privacy-safe by excluding action payload storage', () => {
    const source = readFileSync(join(currentDir, 'stateRuntime.ts'), 'utf8');
    expect(source).not.toMatch(/payload\s*:/);
    expect(source).not.toMatch(/JSON\.stringify\(input\.action/);
  });
});
