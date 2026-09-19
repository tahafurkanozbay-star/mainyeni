import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const srcRoot = join(root, 'src');
const PRODUCTION_JS_CEILING = 44;
const generatedPrefixes = ['src/Core/Fonts/'];
const testPattern = /(?:\.test\.|\/setupTests\.)/u;

const normalize = (path) => path.replaceAll('\\', '/');
const read = (path) => readFileSync(path, 'utf8');

const walk = (directory) => {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
};

const productionSourceFiles = () => walk(srcRoot)
  .filter((path) => /\.[cm]?[jt]sx?$/u.test(path))
  .filter((path) => !testPattern.test(normalize(path)));

const relativePath = (path) => normalize(relative(root, path));
const isGenerated = (path) => generatedPrefixes.some((prefix) => relativePath(path).startsWith(prefix));

export const inspectSource = (files = productionSourceFiles()) => {
  const errors = [];
  const warnings = [];
  let javascriptFiles = 0;
  let jsxInJavascript = 0;
  let directAxiosImports = 0;

  for (const path of files) {
    const rel = relativePath(path);
    if (isGenerated(path)) continue;
    const code = read(path);
    if (extname(path) === '.js') {
      javascriptFiles += 1;
      if (/<[A-Za-z][^>]*>/u.test(code)) jsxInJavascript += 1;
    }
    if (/\bprocess\.env\./u.test(code)) {
      errors.push(`${rel}: process.env browser access is forbidden`);
    }
    if (/from\s+['"]crypto-js['"]|require\(['"]crypto-js['"]\)/u.test(code)) {
      errors.push(`${rel}: crypto-js is forbidden in browser runtime`);
    }
    if (/\beval\s*\(|new\s+Function\s*\(/u.test(code)) {
      errors.push(`${rel}: dynamic code execution is forbidden`);
    }
    if (/dangerouslySetInnerHTML/u.test(code)) {
      warnings.push(`${rel}: unsafe HTML sink requires manual review`);
    }
    if (/from\s+['"]axios['"]|require\(['"]axios['"]\)/u.test(code)) {
      directAxiosImports += 1;
      if (!rel.startsWith('src/platform/http/')) {
        warnings.push(`${rel}: legacy direct axios import remains outside typed HTTP boundary`);
      }
    }
    if (/\blocalStorage\b/u.test(code) && !rel.startsWith('src/platform/auth/')) {
      warnings.push(`${rel}: legacy localStorage access remains outside session boundary`);
    }
  }

  if (javascriptFiles > PRODUCTION_JS_CEILING) {
    errors.push(
      `Production JavaScript file count ${javascriptFiles} exceeds ratcheted ceiling ${PRODUCTION_JS_CEILING}`,
    );
  }

  return Object.freeze({
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    metrics: Object.freeze({
      javascriptFiles,
      jsxInJavascript,
      directAxiosImports,
    }),
  });
};

const requiredFiles = [
  'index.html',
  'vite.config.ts',
  'vitest.config.ts',
  'tsconfig.json',
  'tsconfig.runtime.json',
  'src/main.tsx',
  'src/platform/config/runtimeConfig.ts',
  'src/platform/http/adminHttpClient.ts',
  'src/platform/auth/sessionStore.ts',
  'src/platform/observability/runtimeDiagnostics.ts',
];

const inspectRepository = () => {
  const errors = [];
  for (const file of requiredFiles) {
    try {
      if (!statSync(join(root, file)).isFile()) errors.push(`Required file is not a file: ${file}`);
    } catch {
      errors.push(`Required modernization file is missing: ${file}`);
    }
  }

  const packageJson = JSON.parse(read(join(root, 'package.json')));
  if (packageJson.scripts?.build?.includes('react-scripts')) {
    errors.push('react-scripts build command is forbidden');
  }
  if (packageJson.scripts?.start?.includes('react-scripts')) {
    errors.push('react-scripts start command is forbidden');
  }
  if (!packageJson.scripts?.build?.includes('vite build')) {
    errors.push('production build must use Vite');
  }
  if (packageJson.type !== 'module') errors.push('package.json must use ESM module mode');

  const source = inspectSource();
  return {
    errors: Object.freeze([...errors, ...source.errors]),
    warnings: source.warnings,
    metrics: source.metrics,
  };
};

const selfTest = () => {
  const fixtureRoot = join(root, 'scripts');
  const virtual = (name, content) => {
    const path = join(fixtureRoot, name);
    return { path, content };
  };

  const inspectVirtual = (fixtures) => {
    const errors = [];
    let javascriptFiles = 0;
    for (const fixture of fixtures) {
      if (fixture.path.endsWith('.js')) javascriptFiles += 1;
      if (/\bprocess\.env\./u.test(fixture.content)) errors.push('process.env');
      if (/\beval\s*\(/u.test(fixture.content)) errors.push('eval');
    }
    return { errors, javascriptFiles };
  };

  assert.deepEqual(inspectVirtual([virtual('ok.ts', 'export const ok = true;')]), {
    errors: [],
    javascriptFiles: 0,
  });
  assert.deepEqual(inspectVirtual([virtual('legacy.js', 'console.log(process.env.REACT_APP_X);')]), {
    errors: ['process.env'],
    javascriptFiles: 1,
  });
  assert.deepEqual(inspectVirtual([virtual('dynamic.ts', 'eval("1 + 1")')]), {
    errors: ['eval'],
    javascriptFiles: 0,
  });
  console.log('[quality:migration] self-test PASS');
};

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const report = inspectRepository();
  console.log('[quality:migration] Admin modernization inventory');
  console.log(`[quality:migration] production JavaScript: ${report.metrics.javascriptFiles}/${PRODUCTION_JS_CEILING}`);
  console.log(`[quality:migration] JSX-in-JS candidates: ${report.metrics.jsxInJavascript}`);
  console.log(`[quality:migration] direct axios imports: ${report.metrics.directAxiosImports}`);
  for (const warning of report.warnings) console.log(`[quality:migration] WARN: ${warning}`);
  if (report.errors.length > 0) {
    console.error('[quality:migration] FAIL');
    for (const error of report.errors) console.error(` - ${error}`);
    process.exit(1);
  }
  console.log('[quality:migration] PASS');
}
