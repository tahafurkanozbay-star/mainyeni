import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true })
  .flatMap(entry => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

describe('Business production language boundary', () => {
  const srcRoot = resolve(process.cwd(), 'src');
  const businessRoot = resolve(srcRoot, 'Business');

  it('allows only the explicitly staged CommonBusiness legacy runtime', () => {
    const productionJavaScript = walk(businessRoot)
      .filter(path => ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(path)))
      .filter(path => !/\.(?:test|spec)\.[^.]+$/u.test(path))
      .map(path => path.slice(businessRoot.length + 1).replaceAll('\\', '/'))
      .sort();

    expect(productionJavaScript).toEqual(['CommonBusiness.js']);
  });

  it('contains no JavaScript tests in the Business domain', () => {
    const javascriptTests = walk(businessRoot)
      .filter(path => /\.(?:test|spec)\.(?:js|jsx|mjs|cjs)$/u.test(path))
      .map(path => path.slice(businessRoot.length + 1).replaceAll('\\', '/'));

    expect(javascriptTests).toEqual([]);
  });

  it('keeps route, numbering and TKGM production surfaces TypeScript-only', () => {
    for (const runtime of [
      'RouteQueryBusiness',
      'NumberingQueryBusiness',
      'TkgmQueryBusiness',
    ]) {
      expect(existsSync(resolve(businessRoot, `${runtime}.ts`))).toBe(true);
      expect(existsSync(resolve(businessRoot, `${runtime}.js`))).toBe(false);
    }
  });

  it('fails closed if the dedicated Business compiler boundary accepts JavaScript', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.business.json'), 'utf8'),
    ) as {
      compilerOptions?: { allowJs?: boolean; checkJs?: boolean };
      include?: string[];
    };

    expect(config.compilerOptions?.allowJs).toBe(false);
    expect(config.compilerOptions?.checkJs).toBe(false);
    expect(config.include).toContain('src/Business/runtime/**/*.ts');
    expect(config.include).toContain('src/Business/RouteQueryBusiness.ts');
    expect(config.include).toContain('src/Business/NumberingQueryBusiness.ts');
    expect(config.include).toContain('src/Business/TkgmQueryBusiness.ts');
  });

  it('keeps Business strict typecheck in the default verification path', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['typecheck:business'])
      .toBe('tsc --noEmit -p tsconfig.business.json');
    expect(packageJson.scripts?.typecheck).toContain('typecheck:business');
  });

  it('ratchets repository language baseline to one production and zero test JavaScript files', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), '../tools/platform-language-baseline.json'), 'utf8'),
    ) as {
      domains?: Record<string, number>;
      testDomains?: Record<string, number>;
    };

    expect(baseline.domains?.business).toBe(1);
    expect(baseline.testDomains?.business).toBe(0);
  });
});
