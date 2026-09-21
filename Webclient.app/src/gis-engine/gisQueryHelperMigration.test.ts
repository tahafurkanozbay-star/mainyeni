import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GIS query helper TypeScript migration ratchet', () => {
  it('keeps the central GIS query helper on strict TypeScript', () => {
    const toolboxRoot = resolve(process.cwd(), 'src', 'Toolbox');
    expect(existsSync(resolve(toolboxRoot, 'GisQueryHelper.ts'))).toBe(true);
    expect(existsSync(resolve(toolboxRoot, 'GisQueryHelper.js'))).toBe(false);

    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.gis-modern-core.json'), 'utf8'),
    ) as { files?: string[] };
    expect(config.files).toContain('src/Toolbox/GisQueryHelper.ts');
  });
});
