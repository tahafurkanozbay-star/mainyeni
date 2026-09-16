#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), '..');
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.mts', '.cjs', '.cts']);
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const TEST_FILE_PATTERN = /(?:\.test\.|\.spec\.|\/__tests__\/|\/setupTests\.)/i;
const PACKAGE_SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];
const FORBIDDEN_VERSION_SPECIFIER = /^(?:\*|latest|next|https?:|git(?:\+|:)|github:|file:|link:|workspace:)/i;
const FORBIDDEN_PACKAGES = new Set(['react-scripts']);

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

export const analyzeDependencyContract = ({ manifest, lockfile, inventory }) => {
  const source = validateSourceDependencies(inventory, manifest);
  const errors = [
    ...validateLockfile(manifest, lockfile),
    ...validateVersionSpecifiers({
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
    }),
    ...validateModernToolchain(manifest),
    ...source.errors,
  ];

  return {
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    sourceFiles: inventory.length,
    runtimePackages: Object.freeze(source.usedRuntime),
    developmentPackages: Object.freeze(source.usedDevelopment),
  };
};

const loadInventory = async () => {
  const files = await walkSourceFiles(SOURCE_ROOT);
  const inventory = [];
  for (const file of files.sort()) {
    const source = await readFile(file, 'utf8');
    inventory.push({
      path: relative(PROJECT_ROOT, file).replaceAll('\\', '/'),
      references: collectPackageReferences(source),
    });
  }
  return inventory;
};

export const runDependencyContract = async (root = PROJECT_ROOT) => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  const inventory = root === PROJECT_ROOT
    ? await loadInventory()
    : await (async () => {
      const sourceRoot = resolve(root, 'src');
      const files = await walkSourceFiles(sourceRoot);
      const result = [];
      for (const file of files.sort()) {
        result.push({
          path: relative(root, file).replaceAll('\\', '/'),
          references: collectPackageReferences(await readFile(file, 'utf8')),
        });
      }
      return result;
    })();

  return analyzeDependencyContract({ manifest, lockfile, inventory });
};

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
  console.log('[dependency:verify] Manifest, lockfile, source imports and modern toolchain contract are consistent.');
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  await main();
}
