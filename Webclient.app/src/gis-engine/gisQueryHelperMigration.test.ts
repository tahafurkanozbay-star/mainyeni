import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GIS query helper TypeScript migration ratchet', () => {
  it('keeps the central GIS query helper on strict TypeScript', () => {
    const toolboxRoot = resolve(process.cwd(), 'src', 'Toolbox');
    expect(existsSync(resolve(toolboxRoot, 'GisQueryHelper.ts'))).toBe(true);
    expect(existsSync(resolve(toolboxRoot, 'GisQueryHelper.js'))).toBe(false);
  });
});
