#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(process.cwd());

const MIGRATED_WIDGETS = Object.freeze([
  'src/Components/Widget/Basemap/BasemapWidget',
  'src/Components/Widget/Bookmark/BookmarkWidget',
  'src/Components/Widget/ContextMenu/ContextMenuWidget',
  'src/Components/Widget/Feedback/FeedbackForm',
  'src/Components/Widget/Feedback/FeedbackWidget',
  'src/Components/Widget/GlobalIdentify/GlobalIdentifyWidget',
  'src/Components/Widget/Sketch/SketchWidget',
  'src/Components/Widget/StreetView/StreetViewWidget',
]);

const REQUIRED_FILES = Object.freeze([
  'src/Components/Widget/_shared/MapWidgetRuntime.ts',
  'src/Components/Widget/_shared/MapWidgetSurface.tsx',
  'src/Components/Widget/_shared/MapWidgetSurface.css',
  'tsconfig.experience-widgets.json',
]);

const FORBIDDEN_SOURCE_PATTERNS = Object.freeze([
  {
    code: 'direct-popup',
    pattern: /window\.open\s*\(/gu,
    message: 'External navigation must use the shared safe URL boundary.',
  },
  {
    code: 'recurring-timer',
    pattern: /setInterval\s*\(/gu,
    message: 'Experience widgets must not introduce recurring polling timers.',
  },
  {
    code: 'console-runtime',
    pattern: /console\.(?:log|warn|error|debug)\s*\(/gu,
    message: 'Migrated widgets must not bypass bounded application diagnostics.',
  },
  {
    code: 'remote-style',
    pattern: /(?:@import\s+url|<link[^>]+stylesheet)[^\n]*(?:https?:)?\/\//giu,
    message: 'Widget presentation must not add remote stylesheets.',
  },
]);

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

export const auditSourceText = (relative, source) => {
  const findings = [];
  for (const rule of FORBIDDEN_SOURCE_PATTERNS) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(source)) {
      findings.push({
        severity: 'error',
        code: rule.code,
        file: relative,
        message: rule.message,
      });
    }
  }
  return findings;
};

const auditMigrationPairs = () => {
  const findings = [];
  for (const stem of MIGRATED_WIDGETS) {
    const typed = `${stem}.tsx`;
    const legacyJs = `${stem}.js`;
    const legacyJsx = `${stem}.jsx`;

    if (!exists(typed)) {
      findings.push({
        severity: 'error',
        code: 'missing-typescript-widget',
        file: typed,
        message: 'Canonical migrated widget TSX file is missing.',
      });
    }
    for (const legacy of [legacyJs, legacyJsx]) {
      if (exists(legacy)) {
        findings.push({
          severity: 'error',
          code: 'legacy-shadow',
          file: legacy,
          message: 'Migrated widget still has a JavaScript shadow.',
        });
      }
    }
  }
  return findings;
};

const auditRequiredContracts = () => {
  const findings = [];
  for (const file of REQUIRED_FILES) {
    if (!exists(file)) {
      findings.push({
        severity: 'error',
        code: 'missing-contract',
        file,
        message: 'Required Experience widget modernization contract is missing.',
      });
    }
  }
  if (findings.length > 0) return findings;

  const runtime = read('src/Components/Widget/_shared/MapWidgetRuntime.ts');
  const surface = read('src/Components/Widget/_shared/MapWidgetSurface.tsx');
  const styles = read('src/Components/Widget/_shared/MapWidgetSurface.css');
  const config = read('tsconfig.experience-widgets.json');

  const runtimeMarkers = [
    'createLatestOperationGate',
    'Promise.race',
    'sanitizeExternalUrl',
    'safeRecordEntries',
    'decodeBookmarks',
    'clampContextMenuPosition',
  ];
  for (const marker of runtimeMarkers) {
    if (!runtime.includes(marker)) {
      findings.push({
        severity: 'error',
        code: 'runtime-contract',
        file: 'src/Components/Widget/_shared/MapWidgetRuntime.ts',
        message: `Runtime safety marker is missing: ${marker}`,
      });
    }
  }

  const surfaceMarkers = [
    'aria-busy',
    'aria-labelledby',
    'MapWidgetEmptyState',
    'MapWidgetSkeleton',
    'CommonQueryWindowTools',
  ];
  for (const marker of surfaceMarkers) {
    if (!surface.includes(marker)) {
      findings.push({
        severity: 'error',
        code: 'surface-contract',
        file: 'src/Components/Widget/_shared/MapWidgetSurface.tsx',
        message: `Accessible surface marker is missing: ${marker}`,
      });
    }
  }

  const styleMarkers = [
    ':focus-visible',
    '@media (prefers-reduced-motion: reduce)',
    '@media (forced-colors: active)',
    '@media (max-width: 767.98px)',
  ];
  for (const marker of styleMarkers) {
    if (!styles.includes(marker)) {
      findings.push({
        severity: 'error',
        code: 'style-contract',
        file: 'src/Components/Widget/_shared/MapWidgetSurface.css',
        message: `Responsive/accessibility CSS marker is missing: ${marker}`,
      });
    }
  }

  if (!config.includes('"strict": true') || !config.includes('GlobalIdentifyWidget.tsx')) {
    findings.push({
      severity: 'error',
      code: 'typescript-boundary',
      file: 'tsconfig.experience-widgets.json',
      message: 'Dedicated widget TypeScript boundary is incomplete.',
    });
  }

  return findings;
};

export const runExperienceWidgetAudit = () => {
  const findings = [
    ...auditMigrationPairs(),
    ...auditRequiredContracts(),
  ];

  for (const stem of MIGRATED_WIDGETS) {
    const relative = `${stem}.tsx`;
    if (exists(relative)) findings.push(...auditSourceText(relative, read(relative)));
  }
  for (const relative of [
    'src/Components/Widget/_shared/MapWidgetRuntime.ts',
    'src/Components/Widget/_shared/MapWidgetSurface.tsx',
    'src/Components/Widget/_shared/MapWidgetSurface.css',
  ]) {
    if (exists(relative)) findings.push(...auditSourceText(relative, read(relative)));
  }

  return Object.freeze({
    findings: Object.freeze(findings),
    errors: findings.filter((item) => item.severity === 'error').length,
    migratedWidgets: MIGRATED_WIDGETS.length,
  });
};

const selfTest = () => {
  assert.equal(auditSourceText('x.tsx', '<div />').length, 0);
  assert.equal(auditSourceText('x.tsx', 'window.open(url)').at(0)?.code, 'direct-popup');
  assert.equal(auditSourceText('x.tsx', 'setInterval(fn, 1000)').at(0)?.code, 'recurring-timer');
  assert.equal(auditSourceText('x.tsx', 'console.error(error)').at(0)?.code, 'console-runtime');
  process.stdout.write('Experience widget audit self-test: PASS\n');
};

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const report = runExperienceWidgetAudit();
  for (const finding of report.findings) {
    process.stdout.write(`${finding.severity.toUpperCase()} [${finding.code}] ${finding.file}: ${finding.message}\n`);
  }
  process.stdout.write(
    `Experience widget audit: ${report.errors} error(s), ${report.migratedWidgets} migrated widget(s).\n`,
  );
  if (report.errors > 0) process.exitCode = 1;
}
