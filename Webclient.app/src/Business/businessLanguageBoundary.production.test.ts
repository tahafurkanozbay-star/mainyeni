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
  const toolboxRoot = resolve(srcRoot, 'Toolbox');

  it('contains no production JavaScript in the Business domain', () => {
    const productionJavaScript = walk(businessRoot)
      .filter(path => ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(path)))
      .filter(path => !/\.(?:test|spec)\.[^.]+$/u.test(path))
      .map(path => path.slice(businessRoot.length + 1).replaceAll('\\', '/'))
      .sort();

    expect(productionJavaScript).toEqual([]);
  });

  it('contains no JavaScript tests in the Business domain', () => {
    const javascriptTests = walk(businessRoot)
      .filter(path => /\.(?:test|spec)\.(?:js|jsx|mjs|cjs)$/u.test(path))
      .map(path => path.slice(businessRoot.length + 1).replaceAll('\\', '/'));

    expect(javascriptTests).toEqual([]);
  });

  it('keeps the shared GIS helpers TypeScript-only', () => {
    for (const runtime of ['GisGraphicsHelper', 'GisQueryHelper']) {
      expect(existsSync(resolve(toolboxRoot, `${runtime}.ts`))).toBe(true);
      expect(existsSync(resolve(toolboxRoot, `${runtime}.js`))).toBe(false);
    }
  });

  it('keeps the major Business production surfaces TypeScript-only', () => {
    for (const runtime of [
      'CommonBusiness',
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
    expect(config.include).toContain('src/Business/**/*.ts');
    expect(config.include).toContain('src/Toolbox/GisGraphicsHelper.ts');
    expect(config.include).toContain('src/Toolbox/GisQueryHelper.ts');
  });

  it('keeps Business strict typecheck in the default verification path', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['typecheck:business'])
      .toBe('tsc --noEmit -p tsconfig.business.json');
    expect(packageJson.scripts?.typecheck).toContain('typecheck:business');
  });

  it('ratchets production JavaScript ceilings to zero for Business and GIS helpers', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(process.cwd(), '../tools/platform-language-baseline.json'), 'utf8'),
    ) as {
      domains?: Record<string, number>;
      testDomains?: Record<string, number>;
    };

    expect(baseline.domains?.business).toBe(0);
    expect(baseline.domains?.toolbox).toBe(0);
    expect(baseline.testDomains?.business).toBe(0);
  });
});
