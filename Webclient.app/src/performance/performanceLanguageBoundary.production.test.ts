import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true })
  .flatMap(entry => {
    const path = resolve(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

describe('performance production language boundary', () => {
  const srcRoot = resolve(process.cwd(), 'src');
  const performanceRoot = resolve(srcRoot, 'performance');

  it('keeps the performance production domain TypeScript-only', () => {
    const productionJavaScript = walk(performanceRoot)
      .filter(path => ['.js', '.jsx', '.mjs', '.cjs'].includes(extname(path)))
      .filter(path => !/\.(?:test|spec)\.[^.]+$/u.test(path));

    expect(productionJavaScript).toEqual([]);
  });

  it('migrates the legacy web-vitals facade to TypeScript', () => {
    expect(existsSync(resolve(srcRoot, 'reportWebVitals.ts'))).toBe(true);
    expect(existsSync(resolve(srcRoot, 'reportWebVitals.js'))).toBe(false);
  });

  it('fails closed if the dedicated performance compiler boundary accepts JavaScript', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'tsconfig.performance.json'), 'utf8'),
    );

    expect(config.compilerOptions?.allowJs).toBe(false);
    expect(config.compilerOptions?.checkJs).toBe(false);
    expect(config.include).toContain('src/performance/**/*.ts');
    expect(config.include).toContain('src/platform/performance/performanceMonitor.ts');
    expect(config.include).toContain('src/reportWebVitals.ts');
  });

  it('keeps performance typecheck in the default verification path', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );

    expect(packageJson.scripts?.['typecheck:performance'])
      .toBe('tsc --noEmit -p tsconfig.performance.json');
    expect(packageJson.scripts?.typecheck).toContain('typecheck:performance');
  });

  it('requires explicit lifecycle disposal in the application entry', () => {
    const entry = readFileSync(resolve(srcRoot, 'main.tsx'), 'utf8');
    expect(entry).toContain('performanceLifecycleHandle.dispose()');
    expect(entry).toContain('webVitalsRegistration.stop()');
    expect(entry).toContain('recordPerformanceDiagnostic');
  });
});
