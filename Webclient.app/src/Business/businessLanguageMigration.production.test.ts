import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sourceRoot = resolve(process.cwd(), 'src');

const migratedModules = Object.freeze([
  'Business/AuthBusiness',
  'Business/CommonBusiness',
  'Business/EventQueryBusiness',
  'Business/FeedbackBusiness',
  'Business/GoogleMapsBusiness',
  'Business/HalkEkmekQueryBusiness',
  'Business/HttpBusiness',
  'Business/LoggingBusiness',
  'Business/NumberingQueryBusiness',
  'Business/RouteQueryBusiness',
  'Toolbox/GisGraphicsHelper',
  'Toolbox/GisQueryHelper',
]);

describe('business strict TypeScript migration ratchet', () => {
  test.each(migratedModules)('%s exists only as TypeScript', (modulePath) => {
    expect(existsSync(resolve(sourceRoot, `${modulePath}.ts`))).toBe(true);
    expect(existsSync(resolve(sourceRoot, `${modulePath}.js`))).toBe(false);
  });

  test('migrated runtime modules do not introduce ts-ignore escape hatches', () => {
    const violations = migratedModules.flatMap((modulePath) => {
      const filePath = resolve(sourceRoot, `${modulePath}.ts`);
      const source = readFileSync(filePath, 'utf8');
      return /@ts-(?:ignore|nocheck)/u.test(source) ? [modulePath] : [];
    });

    expect(violations).toEqual([]);
  });

  test('network and GIS query boundaries keep explicit abort semantics', () => {
    const http = readFileSync(resolve(sourceRoot, 'Business/HttpBusiness.ts'), 'utf8');
    const gis = readFileSync(resolve(sourceRoot, 'Toolbox/GisQueryHelper.ts'), 'utf8');

    expect(http).toContain('AbortController');
    expect(http).toContain('HttpBusinessTimeoutError');
    expect(http).toContain('maxResponseBytes');
    expect(gis).toContain('AbortSignal');
    expect(gis).toContain('abortInFlight: true');
  });

  test('legacy query modules consume centralized safe where builders', () => {
    const event = readFileSync(resolve(sourceRoot, 'Business/EventQueryBusiness.ts'), 'utf8');
    const route = readFileSync(resolve(sourceRoot, 'Business/RouteQueryBusiness.ts'), 'utf8');
    const numbering = readFileSync(resolve(sourceRoot, 'Business/NumberingQueryBusiness.ts'), 'utf8');

    expect(event).toContain('buildArcGisUpperContainsFilter');
    expect(event).toContain('buildArcGisEqualsFilter');
    expect(route).toContain('buildArcGisIntegerEqualsFilter');
    expect(route).not.toMatch(/objectid\s*=\s*["'`]?\s*\+?/u);
    expect(numbering).toContain('buildArcGisInFilter');
    expect(numbering).toContain('buildArcGisEqualsFilter');
  });

  test('client logging keeps sensitive-field redaction', () => {
    const logging = readFileSync(resolve(sourceRoot, 'Business/LoggingBusiness.ts'), 'utf8');
    expect(logging).toContain('SENSITIVE_KEY_PATTERN');
    expect(logging).toContain('[REDACTED]');
    expect(logging).not.toContain('console.log');
  });

  test('CommonBusiness uses Vite-native asset base and safe popup links', () => {
    const common = readFileSync(resolve(sourceRoot, 'Business/CommonBusiness.ts'), 'utf8');
    expect(common).toContain('import.meta.env.BASE_URL');
    expect(common).not.toContain('process.env.PUBLIC_URL');
    expect(common).toContain("anchor.rel = 'noopener noreferrer'");
    expect(common).toContain('normalizeHttpUrl');
  });
});
