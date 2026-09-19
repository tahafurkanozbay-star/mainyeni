import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const packageJson = readJson('package.json');
const lock = readJson('package-lock.json');

const errors = [];
const warnings = [];
const dependencyNames = new Set(Object.keys(packageJson.dependencies ?? {}));
const devDependencyNames = new Set(Object.keys(packageJson.devDependencies ?? {}));

const requiredDev = new Map([
  ['vite', 8],
  ['typescript', 7],
  ['vitest', 5],
  ['oxlint', 1],
  ['@vitejs/plugin-react', 6],
]);
const forbidden = [
  'react-scripts',
  'crypto-js',
];

const major = (value) => {
  const match = String(value ?? '').match(/(\d+)/u);
  return match ? Number(match[1]) : null;
};

for (const name of forbidden) {
  if (dependencyNames.has(name) || devDependencyNames.has(name)) {
    errors.push(`Forbidden legacy package remains in package.json: ${name}`);
  }
}

for (const [name, expectedMajor] of requiredDev) {
  const declared = packageJson.devDependencies?.[name];
  if (!declared) {
    errors.push(`Required dev dependency is missing: ${name}`);
    continue;
  }
  const observed = major(declared);
  if (observed !== expectedMajor) {
    errors.push(`${name} must stay on major ${expectedMajor}; found ${declared}`);
  }
}

if (lock.lockfileVersion !== 3) {
  errors.push(`package-lock.json must use lockfileVersion 3; found ${lock.lockfileVersion}`);
}

const lockRoot = lock.packages?.[''];
if (!lockRoot) {
  errors.push('package-lock.json is missing the root package entry');
} else {
  const compareSection = (name, manifest, locked) => {
    const manifestEntries = Object.entries(manifest ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const lockedEntries = Object.entries(locked ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(manifestEntries) !== JSON.stringify(lockedEntries)) {
      errors.push(`package-lock root ${name} does not match package.json`);
    }
  };
  compareSection('dependencies', packageJson.dependencies, lockRoot.dependencies);
  compareSection('devDependencies', packageJson.devDependencies, lockRoot.devDependencies);
}

for (const runtimeOnly of ['@testing-library/jest-dom', '@testing-library/react', '@testing-library/user-event']) {
  if (dependencyNames.has(runtimeOnly)) {
    errors.push(`Test-only dependency must not ship in production dependencies: ${runtimeOnly}`);
  }
}

for (const packageName of dependencyNames) {
  if (!lock.packages?.[`node_modules/${packageName}`]) {
    errors.push(`Runtime dependency missing from lockfile: ${packageName}`);
  }
}
for (const packageName of devDependencyNames) {
  if (!lock.packages?.[`node_modules/${packageName}`]) {
    errors.push(`Dev dependency missing from lockfile: ${packageName}`);
  }
}

const nodeMajor = major(packageJson.engines?.node);
if (nodeMajor !== 24) errors.push(`Node engine must target major 24; found ${packageJson.engines?.node ?? 'unset'}`);
const npmMajor = major(packageJson.engines?.npm);
if (npmMajor !== 11) errors.push(`npm engine must target major 11; found ${packageJson.engines?.npm ?? 'unset'}`);

if (dependencyNames.has('esri-loader')) {
  warnings.push('esri-loader remains present; migrate GIS admin surfaces before removing it.');
}
if ((packageJson.dependencies?.react ?? '').startsWith('^18')) {
  warnings.push('React 18 is intentionally retained during build migration; React 19 requires component compatibility validation.');
}

if (errors.length > 0) {
  console.error('[dependency:verify] FAIL');
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log('[dependency:verify] PASS');
console.log(`[dependency:verify] runtime dependencies: ${dependencyNames.size}`);
console.log(`[dependency:verify] dev dependencies: ${devDependencyNames.size}`);
for (const warning of warnings) console.log(`[dependency:verify] NOTE: ${warning}`);
