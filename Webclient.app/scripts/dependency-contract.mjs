#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), '..');
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src');
const POLICY_FILE = resolve(PROJECT_ROOT, 'scripts', 'dependency-policy.json');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts']);
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|\/__tests__\/|\/setupTests\.)/i;
const PACKAGE_SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /(?<![.$\w])require\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const FORBIDDEN_VERSION_SPECIFIER = /^(?:\*|latest|next|https?:|git(?:\+|:)|github:|file:|link:|workspace:)/i;
const FORBIDDEN_PACKAGES = new Set(['react-scripts']);
const POLICY_ISSUES = Object.freeze([
  'deprecated-direct',
  'install-script-direct',
  'unused-runtime',
]);
const POLICY_ISSUE_SET = new Set(POLICY_ISSUES);
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXCEPTION_REASON_CHARS = 240;

export const packageNameFromSpecifier = (specifier) => {
  if (!specifier || typeof specifier !== 'string') return null;
  const value = specifier.trim();
  if (!value || value.startsWith('.') || value.startsWith('/') || value.startsWith('#')) return null;
  if (value.includes(':') && (value.startsWith('node:') || value.startsWith('data:') || value.startsWith('http:') || value.startsWith('https:'))) {
    return null;
  }
  if (value.startsWith('@')) {
    const [scope, name] = value.split('/');
    return scope && name ? `${scope}/${name}` : null;
  }
  return value.split('/')[0] || null;
};

export const collectPackageReferences = (source) => {
  const references = new Set();
  for (const pattern of PACKAGE_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const packageName = packageNameFromSpecifier(match[1]);
      if (packageName && !BUILTINS.has(packageName)) references.add(packageName);
    }
  }
  return [...references].sort();
};

export const isTestSource = (path) => TEST_FILE_PATTERN.test(path.replaceAll('\\', '/'));

const sortedObject = (value = {}) => Object.fromEntries(
  Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
);

const stableJson = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

export const compareManifestSection = (name, manifestSection = {}, lockSection = {}) => {
  const manifest = sortedObject(manifestSection);
  const locked = sortedObject(lockSection);
  if (stableJson(manifest) === stableJson(locked)) return [];

  const errors = [];
  const names = new Set([...Object.keys(manifest), ...Object.keys(locked)]);
  for (const dependency of [...names].sort()) {
    if (!(dependency in manifest)) {
      errors.push(`${name}: lockfile contains undeclared dependency ${dependency}`);
      continue;
    }
    if (!(dependency in locked)) {
      errors.push(`${name}: package-lock is missing ${dependency}`);
      continue;
    }
    if (manifest[dependency] !== locked[dependency]) {
      errors.push(`${name}: ${dependency} specifier differs (${manifest[dependency]} != ${locked[dependency]})`);
    }
  }
  return errors;
};

export const validateVersionSpecifiers = (sections) => {
  const errors = [];
  for (const [sectionName, section] of Object.entries(sections)) {
    for (const [name, specifier] of Object.entries(section ?? {})) {
      if (FORBIDDEN_VERSION_SPECIFIER.test(String(specifier).trim())) {
        errors.push(`${sectionName}: ${name} uses non-release specifier ${specifier}`);
      }
      if (FORBIDDEN_PACKAGES.has(name)) {
        errors.push(`${sectionName}: ${name} is forbidden by the Vite migration contract`);
      }
    }
  }
  return errors;
};

const majorFromSpecifier = (specifier) => {
  const match = String(specifier ?? '').match(/(?:^|[^\d])(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : null;
};

export const validateModernToolchain = (manifest) => {
  const errors = [];
  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};

  const contracts = [
    ['react', dependencies.react, 19],
    ['react-dom', dependencies['react-dom'], 19],
    ['react-redux', dependencies['react-redux'], 9],
    ['redux', dependencies.redux, 5],
    ['vite', devDependencies.vite, 8],
    ['vitest', devDependencies.vitest, 5],
    ['typescript', devDependencies.typescript, 7],
  ];

  for (const [name, specifier, minimumMajor] of contracts) {
    const major = majorFromSpecifier(specifier);
    if (major === null) {
      errors.push(`toolchain: ${name} is missing from the expected dependency section`);
    } else if (major < minimumMajor) {
      errors.push(`toolchain: ${name} major ${major} is below required ${minimumMajor}`);
    }
  }

  const nodeMajor = majorFromSpecifier(manifest.engines?.node);
  if (nodeMajor === null || nodeMajor < 24) errors.push('toolchain: Node engine must require Node 24 or newer');
  const npmMajor = majorFromSpecifier(manifest.engines?.npm);
  if (npmMajor === null || npmMajor < 11) errors.push('toolchain: npm engine must require npm 11 or newer');

  return errors;
};

const walkSourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkSourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
};

export const validateSourceDependencies = (inventory, manifest) => {
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const devDependencies = new Set(Object.keys(manifest.devDependencies ?? {}));
  const errors = [];
  const usedRuntime = new Set();
  const usedDevelopment = new Set();

  for (const item of inventory) {
    const developmentOnly = isTestSource(item.path);
    for (const dependency of item.references) {
      if (developmentOnly) usedDevelopment.add(dependency);
      else usedRuntime.add(dependency);

      if (!dependencies.has(dependency) && !devDependencies.has(dependency)) {
        errors.push(`${item.path}: imports undeclared package ${dependency}`);
        continue;
      }
      if (!developmentOnly && devDependencies.has(dependency) && !dependencies.has(dependency)) {
        errors.push(`${item.path}: runtime source imports devDependency ${dependency}`);
      }
    }
  }

  return {
    errors,
    usedRuntime: [...usedRuntime].sort(),
    usedDevelopment: [...usedDevelopment].sort(),
  };
};

export const validateLockfile = (manifest, lockfile) => {
  const errors = [];
  if (lockfile.lockfileVersion !== 3) errors.push(`lockfile: expected lockfileVersion 3, received ${lockfile.lockfileVersion}`);
  const root = lockfile.packages?.[''];
  if (!root) return [...errors, 'lockfile: root package metadata is missing'];

  if (root.name !== manifest.name) errors.push(`lockfile: root name differs (${root.name} != ${manifest.name})`);
  if (root.version !== manifest.version) errors.push(`lockfile: root version differs (${root.version} != ${manifest.version})`);
  errors.push(...compareManifestSection('dependencies', manifest.dependencies, root.dependencies));
  errors.push(...compareManifestSection('devDependencies', manifest.devDependencies, root.devDependencies));
  errors.push(...compareManifestSection('engines', manifest.engines, root.engines));
  return errors;
};

const lockPathForPackage = (packageName) => `node_modules/${packageName}`;

const collectDirectLockErrors = (manifest, lockfile) => {
  const errors = [];
  const sections = [
    ['dependencies', manifest.dependencies ?? {}],
    ['devDependencies', manifest.devDependencies ?? {}],
  ];

  for (const [sectionName, section] of sections) {
    for (const packageName of Object.keys(section).sort()) {
      const entry = lockfile.packages?.[lockPathForPackage(packageName)];
      if (!entry) {
        errors.push(`lockfile: ${sectionName} package ${packageName} has no resolved package entry`);
        continue;
      }
      if (typeof entry.version !== 'string' || entry.version.trim().length === 0) {
        errors.push(`lockfile: ${packageName} has no concrete resolved version`);
      }
      if (typeof entry.resolved !== 'string' || entry.resolved.trim().length === 0) {
        errors.push(`lockfile: ${packageName} is missing registry provenance (resolved)`);
      }
      if (typeof entry.integrity !== 'string' || entry.integrity.trim().length === 0) {
        errors.push(`lockfile: ${packageName} is missing integrity metadata`);
      }
    }
  }

  return errors;
};

export const collectDependencyHygieneIssues = ({ manifest, lockfile, source }) => {
  const issues = [];
  const usedRuntime = new Set(source.usedRuntime ?? []);
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();

  for (const packageName of dependencies) {
    const entry = lockfile.packages?.[lockPathForPackage(packageName)] ?? {};
    if (!usedRuntime.has(packageName)) {
      issues.push(Object.freeze({ package: packageName, issue: 'unused-runtime' }));
    }
    if (typeof entry.deprecated === 'string' && entry.deprecated.trim().length > 0) {
      issues.push(Object.freeze({ package: packageName, issue: 'deprecated-direct' }));
    }
    if (entry.hasInstallScript === true) {
      issues.push(Object.freeze({ package: packageName, issue: 'install-script-direct' }));
    }
  }

  return Object.freeze(issues.sort((left, right) => (
    left.package.localeCompare(right.package) || left.issue.localeCompare(right.issue)
  )));
};

const issueKey = ({ package: packageName, issue }) => `${packageName}\u0000${issue}`;

const normalizeDate = (value) => {
  if (value instanceof Date) return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
};

export const validateDependencyPolicy = ({ manifest, issues, policy, now = new Date() }) => {
  const errors = [];
  if (!policy || typeof policy !== 'object') {
    return { errors: ['dependency-policy: policy document is required'], exceptions: [] };
  }
  if (policy.schemaVersion !== 1) {
    errors.push(`dependency-policy: expected schemaVersion 1, received ${policy.schemaVersion}`);
  }

  const directPackages = new Set(Object.keys(manifest.dependencies ?? {}));
  const observed = new Set(issues.map(issueKey));
  const exceptions = Array.isArray(policy.exceptions) ? policy.exceptions : [];
  const exceptionKeys = new Set();
  const today = normalizeDate(now) ?? new Date();

  for (const [index, exception] of exceptions.entries()) {
    const prefix = `dependency-policy: exceptions[${index}]`;
    const packageName = String(exception?.package ?? '').trim();
    const owner = String(exception?.owner ?? '').trim();
    const reason = String(exception?.reason ?? '').trim();
    const expiresOn = String(exception?.expiresOn ?? '').trim();
    const issueNames = Array.isArray(exception?.issues) ? [...new Set(exception.issues)] : [];

    if (!packageName) errors.push(`${prefix} package is required`);
    else if (!directPackages.has(packageName)) errors.push(`${prefix} references non-runtime dependency ${packageName}`);
    if (!owner) errors.push(`${prefix} owner is required`);
    if (!reason) errors.push(`${prefix} reason is required`);
    else if (reason.length > MAX_EXCEPTION_REASON_CHARS) errors.push(`${prefix} reason exceeds ${MAX_EXCEPTION_REASON_CHARS} characters`);
    if (!DATE_ONLY_PATTERN.test(expiresOn)) errors.push(`${prefix} expiresOn must use YYYY-MM-DD`);
    const expiry = DATE_ONLY_PATTERN.test(expiresOn) ? normalizeDate(expiresOn) : null;
    if (!expiry) {
      if (DATE_ONLY_PATTERN.test(expiresOn)) errors.push(`${prefix} expiresOn is not a valid calendar date`);
    } else if (expiry < today) {
      errors.push(`${prefix} expired on ${expiresOn}`);
    }
    if (issueNames.length === 0) errors.push(`${prefix} must list at least one issue`);

    for (const issue of issueNames) {
      if (!POLICY_ISSUE_SET.has(issue)) {
        errors.push(`${prefix} uses unknown issue ${issue}`);
        continue;
      }
      const key = issueKey({ package: packageName, issue });
      if (exceptionKeys.has(key)) errors.push(`${prefix} duplicates exception ${packageName}/${issue}`);
      exceptionKeys.add(key);
      if (!observed.has(key)) errors.push(`${prefix} is stale; ${packageName}/${issue} is no longer observed`);
    }
  }

  for (const current of issues) {
    const key = issueKey(current);
    if (!exceptionKeys.has(key)) {
      errors.push(`dependency-policy: unreviewed ${current.issue} issue for ${current.package}`);
    }
  }

  const budgets = policy.budgets ?? {};
  const counts = Object.fromEntries(POLICY_ISSUES.map((issue) => [issue, issues.filter((item) => item.issue === issue).length]));
  const totalBudget = Number(budgets.maxExceptions);
  if (!Number.isInteger(totalBudget) || totalBudget < 0) {
    errors.push('dependency-policy: budgets.maxExceptions must be a non-negative integer');
  } else if (exceptionKeys.size > totalBudget) {
    errors.push(`dependency-policy: ${exceptionKeys.size} exception issues exceed maxExceptions budget ${totalBudget}`);
  }

  for (const issue of POLICY_ISSUES) {
    const budgetName = issue === 'unused-runtime'
      ? 'maxUnusedRuntime'
      : issue === 'deprecated-direct'
        ? 'maxDeprecatedDirect'
        : 'maxInstallScriptDirect';
    const budget = Number(budgets[budgetName]);
    if (!Number.isInteger(budget) || budget < 0) {
      errors.push(`dependency-policy: budgets.${budgetName} must be a non-negative integer`);
    } else if (counts[issue] > budget) {
      errors.push(`dependency-policy: ${counts[issue]} ${issue} issues exceed ${budgetName} budget ${budget}`);
    }
  }

  return {
    errors,
    exceptions: [...exceptionKeys].sort(),
    counts: Object.freeze(counts),
  };
};

export const validateDependencyHygiene = ({ manifest, lockfile, source, policy, now }) => {
  const issues = collectDependencyHygieneIssues({ manifest, lockfile, source });
  const policyResult = validateDependencyPolicy({ manifest, issues, policy, now });
  return {
    errors: [
      ...collectDirectLockErrors(manifest, lockfile),
      ...policyResult.errors,
    ],
    issues,
    counts: policyResult.counts ?? Object.freeze({}),
  };
};

export const analyzeDependencyContract = ({ manifest, lockfile, inventory, policy = null, now }) => {
  const source = validateSourceDependencies(inventory, manifest);
  const hygiene = policy
    ? validateDependencyHygiene({ manifest, lockfile, source, policy, now })
    : { errors: [], issues: Object.freeze([]), counts: Object.freeze({}) };
  const errors = [
    ...validateLockfile(manifest, lockfile),
    ...validateVersionSpecifiers({
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
    }),
    ...validateModernToolchain(manifest),
    ...source.errors,
    ...hygiene.errors,
  ];

  return {
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    sourceFiles: inventory.length,
    runtimePackages: Object.freeze(source.usedRuntime),
    developmentPackages: Object.freeze(source.usedDevelopment),
    hygieneIssues: hygiene.issues,
    hygieneCounts: hygiene.counts,
  };
};

const loadInventory = async (root = PROJECT_ROOT) => {
  const sourceRoot = resolve(root, 'src');
  const files = await walkSourceFiles(sourceRoot);
  const inventory = [];
  for (const file of files.sort()) {
    const source = await readFile(file, 'utf8');
    inventory.push({
      path: relative(root, file).replaceAll('\\', '/'),
      references: collectPackageReferences(source),
    });
  }
  return inventory;
};

export const runDependencyContract = async (root = PROJECT_ROOT) => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const policy = JSON.parse(await readFile(root === PROJECT_ROOT ? POLICY_FILE : resolve(root, 'scripts', 'dependency-policy.json'), 'utf8'));
  const inventory = await loadInventory(root);
  return analyzeDependencyContract({ manifest, lockfile, inventory, policy });
};

const formatHygieneIssue = ({ package: packageName, issue }) => `${packageName} (${issue})`;

const main = async () => {
  const result = await runDependencyContract();
  if (!result.ok) {
    console.error('[dependency:verify] Dependency contract failed:');
    result.errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }

  console.log(`[dependency:verify] ${result.sourceFiles} source files inspected.`);
  console.log(`[dependency:verify] Runtime package imports: ${result.runtimePackages.join(', ') || '(none)'}`);
  console.log(`[dependency:verify] Test/dev package imports: ${result.developmentPackages.join(', ') || '(none)'}`);
  console.log(`[dependency:verify] Reviewed dependency debt: ${result.hygieneIssues.map(formatHygieneIssue).join(', ') || '(none)'}`);
  console.log('[dependency:verify] Manifest, lockfile, source imports, supply-chain hygiene and modern toolchain contract are consistent.');
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  await main();
}
