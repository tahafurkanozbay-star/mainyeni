import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP_SHELL_ROOT = resolve(process.cwd(), 'src/Components/App');
const STRICT_TYPESCRIPT_SHELL_MODULES = [
  'CompanyLogo',
  'MapAna',
  'MapComponent',
  'NavigationBar',
  'SidebarModern',
] as const;

describe('application shell TypeScript migration boundary', () => {
  it.each(STRICT_TYPESCRIPT_SHELL_MODULES)('%s remains TypeScript-only', (moduleName) => {
    expect(existsSync(resolve(APP_SHELL_ROOT, `${moduleName}.tsx`))).toBe(true);
    expect(existsSync(resolve(APP_SHELL_ROOT, `${moduleName}.js`))).toBe(false);
    expect(existsSync(resolve(APP_SHELL_ROOT, `${moduleName}.jsx`))).toBe(false);
  });
});
