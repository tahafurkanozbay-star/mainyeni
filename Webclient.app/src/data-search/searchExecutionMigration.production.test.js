import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('search core TypeScript migration ratchet', () => {
  it('keeps the execution runtime on strict TypeScript', () => {
    const sourceRoot = resolve(process.cwd(), 'src', 'Toolbox');
    expect(existsSync(resolve(sourceRoot, 'SearchExecutionRuntime.ts'))).toBe(true);
    expect(existsSync(resolve(sourceRoot, 'SearchExecutionRuntime.js'))).toBe(false);
  });
});
