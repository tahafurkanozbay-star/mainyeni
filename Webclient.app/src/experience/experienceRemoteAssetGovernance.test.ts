import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

interface ScannedFile {
  readonly path: string;
  readonly source: string;
}

interface GovernanceFinding {
  readonly file: string;
  readonly rule: string;
  readonly line: number;
  readonly excerpt: string;
}

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(TEST_DIRECTORY, '..');
const EXPERIENCE_ROOT = resolve(SRC_ROOT, 'experience');
const EXPERIENCE_COMPONENT_ROOT = resolve(SRC_ROOT, 'Components', 'Common');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);
const EXPERIENCE_COMPONENT_PATTERN = /^(Experience|experience-)/;
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.)/;
const GENERATED_PATTERN = /(?:\.d\.ts$|\/dist\/|\/coverage\/)/;

const REMOTE_URL_PATTERN = /https?:\/\//i;
const REMOTE_FONT_PATTERN = /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|typekit\.net|use\.typekit\.net)/i;
const ANALYTICS_PATTERN = /(?:google-analytics\.com|googletagmanager\.com|plausible\.io|segment\.com|mixpanel\.com|hotjar\.com)/i;
const DIRECT_NETWORK_PATTERN = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;
const DYNAMIC_SCRIPT_PATTERN = /(?:document\.createElement\(\s*['"]script['"]|new\s+Function\s*\(|\beval\s*\()/;
const CSS_REMOTE_IMPORT_PATTERN = /@import\s+(?:url\()?\s*['"]?https?:\/\//i;
const CSS_REMOTE_ASSET_PATTERN = /url\(\s*['"]?https?:\/\//i;

const readTree = (
  root: string,
  include: (path: string) => boolean,
): readonly ScannedFile[] => {
  const files: ScannedFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!stats.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(extname(entry))) continue;
      if (!include(absolute)) continue;
      files.push(Object.freeze({
        path: relative(SRC_ROOT, absolute).replaceAll('\\', '/'),
        source: readFileSync(absolute, 'utf8'),
      }));
    }
  };
  visit(root);
  return Object.freeze(files);
};

const EXPERIENCE_FILES = readTree(EXPERIENCE_ROOT, path => (
  !TEST_FILE_PATTERN.test(path)
  && !GENERATED_PATTERN.test(path)
));

const EXPERIENCE_COMPONENT_FILES = readTree(EXPERIENCE_COMPONENT_ROOT, path => {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  return EXPERIENCE_COMPONENT_PATTERN.test(name)
    && !TEST_FILE_PATTERN.test(path)
    && !GENERATED_PATTERN.test(path);
});

const GOVERNED_FILES = Object.freeze([
  ...EXPERIENCE_FILES,
  ...EXPERIENCE_COMPONENT_FILES,
]);

const lineNumberAt = (source: string, index: number): number => (
  source.slice(0, Math.max(0, index)).split('\n').length
);

const excerptAt = (source: string, index: number): string => {
  const start = source.lastIndexOf('\n', index) + 1;
  const endIndex = source.indexOf('\n', index);
  const end = endIndex === -1 ? source.length : endIndex;
  return source.slice(start, end).trim().slice(0, 180);
};

const collectPatternFindings = (
  file: ScannedFile,
  rule: string,
  pattern: RegExp,
): readonly GovernanceFinding[] => {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  const findings: GovernanceFinding[] = [];
  let match = matcher.exec(file.source);
  while (match) {
    findings.push(Object.freeze({
      file: file.path,
      rule,
      line: lineNumberAt(file.source, match.index),
      excerpt: excerptAt(file.source, match.index),
    }));
    if (matcher.lastIndex === match.index) matcher.lastIndex += 1;
    match = matcher.exec(file.source);
  }
  return findings;
};

const formatFindings = (findings: readonly GovernanceFinding[]): string => (
  findings.length === 0
    ? 'No findings.'
    : findings
        .map(finding => `${finding.file}:${finding.line} [${finding.rule}] ${finding.excerpt}`)
        .join('\n')
);

const sourceFilesOnly = GOVERNED_FILES.filter(file => !file.path.endsWith('.css'));
const cssFilesOnly = GOVERNED_FILES.filter(file => file.path.endsWith('.css'));

const collectAll = (
  files: readonly ScannedFile[],
  rule: string,
  pattern: RegExp,
): readonly GovernanceFinding[] => files.flatMap(file => collectPatternFindings(file, rule, pattern));

describe('Experience remote asset and browser-network governance', () => {
  test('governance scan has a non-empty bounded source scope', () => {
    expect(GOVERNED_FILES.length).toBeGreaterThan(10);
    expect(GOVERNED_FILES.length).toBeLessThan(250);
    expect(new Set(GOVERNED_FILES.map(file => file.path)).size).toBe(GOVERNED_FILES.length);
  });

  test('Experience runtime source does not embed remote font providers', () => {
    const findings = collectAll(GOVERNED_FILES, 'remote-font-provider', REMOTE_FONT_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('Experience CSS does not use remote @import statements', () => {
    const findings = collectAll(cssFilesOnly, 'remote-css-import', CSS_REMOTE_IMPORT_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('Experience CSS does not reference remote url() assets', () => {
    const findings = collectAll(cssFilesOnly, 'remote-css-asset', CSS_REMOTE_ASSET_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('Experience runtime source does not embed analytics destinations', () => {
    const findings = collectAll(GOVERNED_FILES, 'analytics-destination', ANALYTICS_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('Experience components do not introduce direct browser network carriers', () => {
    const findings = collectAll(sourceFilesOnly, 'direct-browser-network', DIRECT_NETWORK_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('Experience source does not create dynamic script or eval execution paths', () => {
    const findings = collectAll(sourceFilesOnly, 'dynamic-code-execution', DYNAMIC_SCRIPT_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('new remote URLs require explicit review rather than being silently accepted', () => {
    const findings = collectAll(GOVERNED_FILES, 'remote-url-review', REMOTE_URL_PATTERN);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('governed CSS includes modern accessibility presentation coverage', () => {
    const css = cssFilesOnly.map(file => file.source).join('\n');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('forced-colors');
    expect(css).toContain('pointer: coarse');
    expect(css).toContain(':focus-visible');
  });

  test('governed sources remain free of WMS and WFS service URLs', () => {
    const servicePattern = /https?:\/\/[^\s'"`]*(?:wms|wfs)[^\s'"`]*/i;
    const findings = collectAll(GOVERNED_FILES, 'wms-wfs-url', servicePattern);
    expect(findings, formatFindings(findings)).toEqual([]);
  });

  test('diagnostic output is bounded and does not dump entire source files', () => {
    const synthetic: ScannedFile = {
      path: 'synthetic.ts',
      source: `const url = 'https://example.invalid/${'x'.repeat(500)}';`,
    };
    const findings = collectPatternFindings(synthetic, 'remote-url-review', REMOTE_URL_PATTERN);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.excerpt.length).toBeLessThanOrEqual(180);
    expect(formatFindings(findings).length).toBeLessThan(260);
  });
});
