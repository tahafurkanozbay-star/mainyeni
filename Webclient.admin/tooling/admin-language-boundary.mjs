import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ADMIN_SOURCE_EXTENSIONS = Object.freeze(['.ts', '.tsx']);
export const LEGACY_SOURCE_EXTENSIONS = Object.freeze(['.js', '.jsx', '.mjs', '.cjs']);

const LEGACY_PATTERNS = Object.freeze([
  {
    id: 'cra-react-scripts',
    pattern: /\breact-scripts\b/u,
    message: 'Create React App react-scripts usage is forbidden in the modern admin client.',
  },
  {
    id: 'cra-env-prefix',
    pattern: /\bprocess\.env\.REACT_APP_[A-Z0-9_]+\b/u,
    message: 'CRA REACT_APP_* environment access is forbidden; use the typed Vite runtime boundary.',
  },
  {
    id: 'legacy-reactdom-render',
    pattern: /\bReactDOM\.render\s*\(/u,
    message: 'Legacy ReactDOM.render is forbidden; React 19 createRoot must remain authoritative.',
  },
  {
    id: 'legacy-router-switch',
    pattern: /<Switch(?:\s|>)/u,
    message: 'React Router Switch is forbidden; Routes/Route element APIs must remain authoritative.',
  },
  {
    id: 'legacy-router-component-prop',
    pattern: /<Route\b[^>]*\bcomponent\s*=/u,
    message: 'React Router component= routes are forbidden; use element= with React Router 8.',
  },
  {
    id: 'legacy-esri-loader',
    pattern: /\bfrom\s+['"]esri-loader['"]|\bloadModules\s*\(/u,
    message: 'Deprecated esri-loader runtime loading is forbidden; use @arcgis/core ESM imports.',
  },
  {
    id: 'commonjs-require',
    pattern: /(^|[^\w])require\s*\(/mu,
    message: 'CommonJS require() is forbidden in admin source; use ESM imports.',
  },
  {
    id: 'commonjs-exports',
    pattern: /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/u,
    message: 'CommonJS exports are forbidden in admin source; use ESM exports.',
  },
]);

const splitEnvKey = (value) => value.toUpperCase().split('_').filter(Boolean);

const isSecretBearingEnvKey = (value) => {
  const tokens = splitEnvKey(value);
  const normalized = tokens[0] === 'VITE' ? tokens.slice(1) : tokens;
  const joined = normalized.join('_');

  const sensitiveJoined = new Set([
    ['CLIENT', 'SECRET'].join('_'),
    ['CLIENT', 'KEY'].join('_'),
    ['API', 'KEY'].join('_'),
    ['PRIVATE', 'KEY'].join('_'),
    ['PASS', 'WORD'].join(''),
    ['TO', 'KEN'].join(''),
  ]);

  return sensitiveJoined.has(joined);
};

const containsSecretBearingEnvAssignment = (content) => content
  .split(/\r?\n/u)
  .some((line) => {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=/u);
    return match ? isSecretBearingEnvKey(match[1]) : false;
  });

const normalizeSlashes = (value) => value.replaceAll(path.sep, '/');

const asObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be an object.');
  }
  return value;
};

const readJson = (filePath) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error('Unable to parse JSON file ' + filePath + ': ' + String(error));
  }
  return asObject(parsed, filePath);
};

const parseMajor = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d+)/u);
  return match ? Number.parseInt(match[1], 10) : null;
};

const walkFiles = (root) => {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
        continue;
      }

      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
};

const violation = (id, file, message, detail) => Object.freeze({
  id,
  file,
  message,
  ...(detail ? { detail } : {}),
});

const auditSourceTree = (root, violations) => {
  const srcRoot = path.join(root, 'src');
  if (!fs.existsSync(srcRoot)) {
    violations.push(violation(
      'missing-src',
      'src',
      'Webclient.admin/src is missing.',
    ));
    return { sourceFiles: 0, typedFiles: 0 };
  }

  const files = walkFiles(srcRoot);
  let sourceFiles = 0;
  let typedFiles = 0;

  for (const absolute of files) {
    const relative = normalizeSlashes(path.relative(root, absolute));
    const extension = path.extname(absolute).toLowerCase();

    if (LEGACY_SOURCE_EXTENSIONS.includes(extension)) {
      violations.push(violation(
        'legacy-source-extension',
        relative,
        'JavaScript-family source file is forbidden after the TypeScript cutover.',
        extension,
      ));
      sourceFiles += 1;
      continue;
    }

    if (!ADMIN_SOURCE_EXTENSIONS.includes(extension)) {
      continue;
    }

    sourceFiles += 1;
    typedFiles += 1;

    const content = fs.readFileSync(absolute, 'utf8');
    for (const rule of LEGACY_PATTERNS) {
      if (rule.pattern.test(content)) {
        violations.push(violation(rule.id, relative, rule.message));
      }
    }
  }

  if (typedFiles === 0) {
    violations.push(violation(
      'missing-typed-source',
      'src',
      'No TypeScript/TSX admin source files were found.',
    ));
  }

  return { sourceFiles, typedFiles };
};

const auditPackage = (root, violations) => {
  const file = 'package.json';
  const manifest = readJson(path.join(root, file));
  const scripts = asObject(manifest.scripts ?? {}, 'package.json scripts');
  const dependencies = asObject(manifest.dependencies ?? {}, 'package.json dependencies');
  const devDependencies = asObject(manifest.devDependencies ?? {}, 'package.json devDependencies');
  const engines = asObject(manifest.engines ?? {}, 'package.json engines');

  if (dependencies['esri-loader'] || devDependencies['esri-loader']) {
    violations.push(violation(
      'esri-loader-dependency',
      file,
      'Deprecated esri-loader must not return after the ArcGIS ESM migration.',
    ));
  }

  const arcgisMajor = parseMajor(dependencies['@arcgis/core']);
  if (arcgisMajor === null || arcgisMajor < 5) {
    violations.push(violation(
      'arcgis-esm-version',
      file,
      '@arcgis/core must remain on major version 5 or newer.',
      String(dependencies['@arcgis/core'] ?? 'missing'),
    ));
  }

  if (dependencies['react-scripts'] || devDependencies['react-scripts']) {
    violations.push(violation(
      'react-scripts-dependency',
      file,
      'react-scripts must not return after the Vite migration.',
    ));
  }

  if (typeof scripts.build !== 'string' || !/\bvite\s+build\b/u.test(scripts.build)) {
    violations.push(violation(
      'vite-build-script',
      file,
      'The production build must remain Vite-based.',
    ));
  }

  if (typeof scripts.typecheck !== 'string' || !/\btsc\b/u.test(scripts.typecheck)) {
    violations.push(violation(
      'typescript-check-script',
      file,
      'The admin package must keep an explicit TypeScript typecheck script.',
    ));
  }

  if (typeof scripts['typecheck:strict'] !== 'string' || !/\btsc\b/u.test(scripts['typecheck:strict'])) {
    violations.push(violation(
      'strict-typescript-check-script',
      file,
      'The admin package must keep its strict TypeScript boundary check.',
    ));
  }

  const minimums = [
    ['react', dependencies.react, 19],
    ['react-dom', dependencies['react-dom'], 19],
    ['react-router', dependencies['react-router'], 8],
    ['vite', devDependencies.vite, 8],
    ['typescript', devDependencies.typescript, 7],
    ['vitest', devDependencies.vitest, 5],
  ];

  for (const [name, rawVersion, minimum] of minimums) {
    const major = parseMajor(rawVersion);
    if (major === null || major < minimum) {
      violations.push(violation(
        'modern-toolchain-version',
        file,
        name + ' must remain on major version ' + minimum + ' or newer.',
        String(rawVersion ?? 'missing'),
      ));
    }
  }

  const nodeMajor = parseMajor(engines.node);
  if (nodeMajor === null || nodeMajor < 24) {
    violations.push(violation(
      'node-runtime-contract',
      file,
      'Admin tooling must remain on Node 24 or newer.',
      String(engines.node ?? 'missing'),
    ));
  }

  if (manifest.type !== 'module') {
    violations.push(violation(
      'esm-package-contract',
      file,
      'Admin package must remain ESM.',
      String(manifest.type ?? 'missing'),
    ));
  }
};

const auditTypeScriptConfig = (root, violations) => {
  const file = 'tsconfig.json';
  const config = readJson(path.join(root, file));
  const options = asObject(config.compilerOptions ?? {}, file + ' compilerOptions');

  if (options.allowJs !== false) {
    violations.push(violation(
      'allow-js-disabled',
      file,
      'allowJs must remain false after the source-language cutover.',
    ));
  }

  if (options.moduleResolution !== 'Bundler') {
    violations.push(violation(
      'bundler-module-resolution',
      file,
      'TypeScript moduleResolution must remain Bundler for the Vite runtime.',
      String(options.moduleResolution ?? 'missing'),
    ));
  }

  if (options.jsx !== 'react-jsx') {
    violations.push(violation(
      'react-jsx-transform',
      file,
      'TypeScript must use the modern react-jsx transform.',
      String(options.jsx ?? 'missing'),
    ));
  }

  const includes = Array.isArray(config.include) ? config.include : [];
  if (!includes.some((entry) => typeof entry === 'string' && entry.includes('src/**/*.ts'))) {
    violations.push(violation(
      'typescript-include',
      file,
      'TypeScript source glob is missing from tsconfig include.',
    ));
  }
  if (!includes.some((entry) => typeof entry === 'string' && entry.includes('src/**/*.tsx'))) {
    violations.push(violation(
      'tsx-include',
      file,
      'TSX source glob is missing from tsconfig include.',
    ));
  }

  const strictFile = 'tsconfig.strict.json';
  const strictConfig = readJson(path.join(root, strictFile));
  const strictOptions = asObject(strictConfig.compilerOptions ?? {}, strictFile + ' compilerOptions');

  for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
    if (strictOptions[key] !== true) {
      violations.push(violation(
        'strict-compiler-contract',
        strictFile,
        key + ' must remain enabled in the strict boundary.',
      ));
    }
  }

  if (strictOptions.noCheck !== false) {
    violations.push(violation(
      'strict-no-check-disabled',
      strictFile,
      'The strict TypeScript project must explicitly keep noCheck=false.',
    ));
  }
};

const auditEnvironmentExample = (root, violations) => {
  const file = '.env.example';
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    violations.push(violation(
      'missing-env-example',
      file,
      'The tracked environment example is required for the Vite runtime contract.',
    ));
    return;
  }

  const content = fs.readFileSync(absolute, 'utf8');
  if (!/^\s*VITE_API_URL=\/api\s*$/mu.test(content)) {
    violations.push(violation(
      'same-origin-api-default',
      file,
      'VITE_API_URL must default to same-origin /api.',
    ));
  }

  if (containsSecretBearingEnvAssignment(content)) {
    violations.push(violation(
      'secret-env-placeholder',
      file,
      'Tracked admin environment examples must not define secret-bearing keys.',
    ));
  }

  if (/\bREACT_APP_/u.test(content)) {
    violations.push(violation(
      'legacy-cra-env-example',
      file,
      'CRA REACT_APP_* variables are forbidden after the Vite migration.',
    ));
  }
};

export const auditAdminLanguageBoundary = (root) => {
  const resolvedRoot = path.resolve(root);
  const violations = [];

  const source = auditSourceTree(resolvedRoot, violations);
  auditPackage(resolvedRoot, violations);
  auditTypeScriptConfig(resolvedRoot, violations);
  auditEnvironmentExample(resolvedRoot, violations);

  return Object.freeze({
    root: resolvedRoot,
    sourceFiles: source.sourceFiles,
    typedFiles: source.typedFiles,
    violations: Object.freeze(violations),
    ok: violations.length === 0,
  });
};

const formatViolation = (item) => {
  const detail = item.detail ? ' [' + item.detail + ']' : '';
  return '- ' + item.id + ': ' + item.file + ': ' + item.message + detail;
};

export const formatAuditReport = (report) => {
  const summary = [
    'Admin language boundary',
    'root=' + report.root,
    'typedFiles=' + report.typedFiles,
    'sourceFiles=' + report.sourceFiles,
    'violations=' + report.violations.length,
  ];

  if (report.violations.length > 0) {
    summary.push(...report.violations.map(formatViolation));
  }

  return summary.join('\n');
};

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(process.cwd());
  const report = auditAdminLanguageBoundary(root);
  process.stdout.write(formatAuditReport(report) + '\n');
  if (!report.ok) {
    process.exitCode = 1;
  }
}
