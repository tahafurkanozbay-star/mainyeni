import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const migrated = Object.freeze([
  ['src/Components/Common/Error.js', 'src/Components/Common/Error.tsx'],
  ['src/Components/Common/Loading.js', 'src/Components/Common/Loading.tsx'],
  ['src/Components/Common/MessageAlert.js', 'src/Components/Common/MessageAlert.tsx'],
  ['src/Components/Common/MessageBar.js', 'src/Components/Common/MessageBar.tsx'],
  ['src/Components/Common/MessageToast.js', 'src/Components/Common/MessageToast.tsx'],
  ['src/Components/Common/SharedGISIcon.js', 'src/Components/Common/SharedGISIcon.tsx'],
  ['src/Components/Common/QueryWindowRegistry.js', 'src/Components/Common/QueryWindowRegistry.tsx'],
  ['src/Components/App/SidebarCatalog.js', 'src/Components/App/SidebarCatalog.ts'],
  ['src/Toolbox/GisCommonHelper.js', 'src/Toolbox/GisCommonHelper.ts'],
  ['src/Toolbox/useDebounce.js', 'src/Toolbox/useDebounce.ts'],
  ['src/reportWebVitals.js', 'src/reportWebVitals.ts'],
] as const);

describe('shared-shell TypeScript cutover', () => {
  it('keeps one canonical typed source for migrated stems', () => {
    for (const [legacy, typed] of migrated) {
      expect(fs.existsSync(path.join(ROOT, legacy)), legacy).toBe(false);
      expect(fs.existsSync(path.join(ROOT, typed)), typed).toBe(true);
    }
  });
  it('contains no TypeScript diagnostic opt-outs', () => {
    for (const [, typed] of migrated) {
      expect(fs.readFileSync(path.join(ROOT, typed), 'utf8')).not.toMatch(/@ts-(?:nocheck|ignore|expect-error)/u);
    }
  });
  it('keeps notification surfaces free from caller-record mutation', () => {
    for (const file of ['MessageAlert.tsx', 'MessageBar.tsx', 'MessageToast.tsx']) {
      const source = fs.readFileSync(path.join(ROOT, 'src/Components/Common', file), 'utf8');
      expect(source).not.toMatch(/\.hours\s*=|\.minutes\s*=|\.seconds\s*=|\.typeIcon\s*=/u);
    }
  });
  it('keeps local Web Vitals runtime transport-free', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/observability/webVitalsRuntime.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|axios|XMLHttpRequest|WebSocket|EventSource/u);
  });
  it('keeps sidebar catalog ids unique and grouped', async () => {
    const { SIDEBAR_GROUPS, SIDEBAR_ITEMS } = await import('../App/SidebarCatalog');
    expect(new Set(SIDEBAR_GROUPS.map((group) => group.id)).size).toBe(SIDEBAR_GROUPS.length);
    expect(new Set(SIDEBAR_ITEMS.map((item) => item.windowId)).size).toBe(SIDEBAR_ITEMS.length);
    const groups = new Set(SIDEBAR_GROUPS.map((group) => group.id));
    expect(SIDEBAR_ITEMS.every((item) => groups.has(item.group))).toBe(true);
  });
});
