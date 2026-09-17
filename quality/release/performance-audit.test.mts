import { describe, expect, it } from 'vitest';
import { auditPerformance } from './performance-audit.mts';
import type { FileKind, RepositoryInventory, SourceFile } from './contracts.mts';

function kind(path: string): FileKind {
  if (/\.tsx?$/.test(path)) return 'typescript';
  if (/\.jsx?$/.test(path)) return 'javascript';
  if (/\.json$/.test(path)) return 'json';
  if (/\.css$/.test(path)) return 'css';
  return 'other';
}

function source(path: string, text: string): SourceFile {
  const lastDot = path.lastIndexOf('.');
  return {
    absolutePath: `/repo/${path}`,
    repositoryPath: path,
    extension: lastDot >= 0 ? path.slice(lastDot) : '',
    kind: kind(path),
    bytes: new TextEncoder().encode(text).byteLength,
    lines: text.split('\n').length,
    text,
  };
}

function inventory(entries: readonly [string, string][]): RepositoryInventory {
  const files = entries.map(([path, text]) => source(path, text));
  return {
    root: '/repo',
    files,
    ignoredDirectories: [],
    languageStats: [],
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + file.lines, 0),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    generatedAt: '2026-09-17T00:00:00.000Z',
  };
}

function ids(entries: readonly [string, string][]): string[] {
  return auditPerformance(inventory(entries)).findings.map(finding => finding.id);
}

describe('performance release audit', () => {
  it('keeps ordinary bounded modules clean', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/feature.ts', 'export const value = 1;'],
      ['Webclient.app/src/feature.css', '.root { display: grid; }'],
    ]));
    expect(result.findings).toEqual([]);
    expect(result.summary.synchronousLoopCandidates).toBe(0);
  });

  it('reports oversized source byte budgets', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/huge.ts', `export const payload = '${'x'.repeat(450_100)}';`],
    ]));
    expect(result.findings.some(finding => finding.id === 'performance-source-file-bytes')).toBe(true);
  });

  it('reports oversized source line budgets', () => {
    const text = Array.from({ length: 4_010 }, (_, index) => `export const v${index} = ${index};`).join('\n');
    const result = auditPerformance(inventory([['Webclient.app/src/huge-lines.ts', text]]));
    expect(result.findings.some(finding => finding.id === 'performance-source-file-lines')).toBe(true);
  });

  it('escalates files beyond twice the configured byte budget', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/extreme.ts', `export const payload = '${'x'.repeat(900_100)}';`],
    ]));
    const finding = result.findings.find(item => item.id === 'performance-source-file-bytes');
    expect(finding?.severity).toBe('high');
  });

  it('detects large application JSON assets', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/data/catalog.json', JSON.stringify({ payload: 'x'.repeat(250_100) })],
    ]));
    expect(result.summary.largeJsonFiles).toEqual(['Webclient.app/src/data/catalog.json']);
    expect(result.findings.some(finding => finding.id === 'performance-large-json-asset')).toBe(true);
  });

  it('does not treat package-lock as an application JSON payload', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/package-lock.json', JSON.stringify({ payload: 'x'.repeat(300_000) })],
    ]));
    expect(result.summary.largeJsonFiles).toEqual([]);
    expect(result.findings.some(finding => finding.id === 'performance-large-json-asset')).toBe(false);
  });

  it('records dynamic import evidence', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/routes.ts', "export const load = () => import('./HeavyRoute');"],
    ]));
    expect(result.summary.lazyImportFiles).toEqual(['Webclient.app/src/routes.ts']);
  });

  it('records React.lazy evidence', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/routes.tsx', "import { lazy } from 'react';\nexport const Heavy = lazy(() => import('./Heavy'));"],
    ]));
    expect(result.summary.lazyImportFiles).toEqual(['Webclient.app/src/routes.tsx']);
  });

  it('detects dense eager query/window imports', () => {
    const imports = Array.from({ length: 8 }, (_, index) => `import Q${index} from './QueryWindow${index}';`).join('\n');
    const result = auditPerformance(inventory([['Webclient.app/src/eager.ts', imports]]));
    expect(result.summary.eagerQueryWindowImports).toEqual(['Webclient.app/src/eager.ts']);
    expect(result.findings.some(finding => finding.id === 'performance-eager-query-window-imports')).toBe(true);
  });

  it('does not flag seven query/window imports as dense', () => {
    const imports = Array.from({ length: 7 }, (_, index) => `import Q${index} from './QueryWindow${index}';`).join('\n');
    expect(ids([['Webclient.app/src/eager.ts', imports]])).not.toContain('performance-eager-query-window-imports');
  });

  it('detects nested synchronous loops', () => {
    const text = 'for (const row of rows) { for (const cell of row.cells) { consume(cell); } }';
    expect(ids([['Webclient.app/src/grid.ts', text]])).toContain('performance-nested-loop-review');
  });

  it('keeps a single bounded loop out of nested-loop findings', () => {
    const text = 'for (const row of rows) { consume(row); }';
    expect(ids([['Webclient.app/src/grid.ts', text]])).not.toContain('performance-nested-loop-review');
  });

  it('escalates repeated nested-loop candidates', () => {
    const candidate = 'for (const row of rows) { for (const cell of row.cells) { consume(cell); } }\n';
    const result = auditPerformance(inventory([['Webclient.app/src/grid.ts', candidate.repeat(4)]]));
    const finding = result.findings.find(item => item.id === 'performance-nested-loop-review');
    expect(finding?.severity).toBe('high');
  });

  it('counts synchronous iteration candidates for release telemetry', () => {
    const text = 'items.map(render);\nitems.forEach(index);\nconst total = items.reduce(sum, 0);\nwhile (ready()) { tick(); }';
    const result = auditPerformance(inventory([['Webclient.app/src/work.ts', text]]));
    expect(result.summary.synchronousLoopCandidates).toBe(4);
  });

  it('counts memoization signals without converting them into findings', () => {
    const text = 'const a = useMemo(build, []);\nconst b = useCallback(run, []);\nexport default memo(View);';
    const result = auditPerformance(inventory([['Webclient.app/src/View.tsx', text]]));
    expect(result.summary.memoizationSignals).toBe(3);
  });

  it('counts virtualization readiness signals', () => {
    const text = "import { FixedSizeList } from 'react-window';\nconst overscan = 4;\nconst mode = 'virtualized';";
    const result = auditPerformance(inventory([['Webclient.app/src/List.tsx', text]]));
    expect(result.summary.virtualizationSignals).toBeGreaterThanOrEqual(3);
  });

  it('excludes quality/release implementation from application performance findings', () => {
    const text = `export const payload = '${'x'.repeat(500_000)}';`;
    const result = auditPerformance(inventory([['quality/release/fixture.ts', text]]));
    expect(result.findings).toEqual([]);
    expect(result.summary.largestFiles).toEqual([]);
  });

  it('sorts largest files by bytes and caps diagnostics to twenty entries', () => {
    const entries: [string, string][] = Array.from({ length: 25 }, (_, index) => [
      `Webclient.app/src/file-${index}.ts`,
      `export const value = '${'x'.repeat(index + 1)}';`,
    ]);
    const result = auditPerformance(inventory(entries));
    expect(result.summary.largestFiles).toHaveLength(20);
    expect(result.summary.largestFiles[0]?.file).toBe('Webclient.app/src/file-24.ts');
    expect(result.summary.largestFiles.at(-1)?.file).toBe('Webclient.app/src/file-5.ts');
  });

  it('preserves deterministic finding ordering across input order', () => {
    const largeA = `export const payload = '${'a'.repeat(450_100)}';`;
    const largeB = `export const payload = '${'b'.repeat(450_100)}';`;
    const first = auditPerformance(inventory([
      ['Webclient.app/src/b.ts', largeB],
      ['Webclient.app/src/a.ts', largeA],
    ])).findings.map(finding => `${finding.id}:${finding.location?.file}`);
    const second = auditPerformance(inventory([
      ['Webclient.app/src/a.ts', largeA],
      ['Webclient.app/src/b.ts', largeB],
    ])).findings.map(finding => `${finding.id}:${finding.location?.file}`);
    expect(first).toEqual(second);
  });

  it('honors custom budgets for focused release profiles', () => {
    const result = auditPerformance(
      inventory([['Webclient.app/src/module.ts', 'export const payload = 123456789;']]),
      {
        maxSourceFileBytes: 10,
        maxSourceFileLines: 100,
        maxInlineJsonBytes: 100,
        maxSynchronousLoopLines: 100,
        maxRemoteAssetHosts: 0,
        maxDuplicateLiteralOccurrences: 10,
      },
    );
    expect(result.findings.some(finding => finding.id === 'performance-source-file-bytes')).toBe(true);
  });

  it('emits actionable budget metadata', () => {
    const result = auditPerformance(
      inventory([['Webclient.app/src/module.ts', 'export const payload = 123456789;']]),
      {
        maxSourceFileBytes: 10,
        maxSourceFileLines: 100,
        maxInlineJsonBytes: 100,
        maxSynchronousLoopLines: 100,
        maxRemoteAssetHosts: 0,
        maxDuplicateLiteralOccurrences: 10,
      },
    );
    const finding = result.findings.find(item => item.id === 'performance-source-file-bytes');
    expect(finding?.evidence?.metadata).toMatchObject({ budget: 10, unit: 'bytes' });
    expect(finding?.remediation).toContain('lazy-load');
  });

  it('reports section timing as a non-negative value', () => {
    const result = auditPerformance(inventory([['Webclient.app/src/module.ts', 'export const x = 1;']]));
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps findings tied to repository-relative locations', () => {
    const result = auditPerformance(inventory([
      ['Webclient.app/src/huge.ts', `export const payload = '${'x'.repeat(450_100)}';`],
    ]));
    expect(result.findings[0]?.location).toMatchObject({ file: 'Webclient.app/src/huge.ts', line: 1 });
  });
});
