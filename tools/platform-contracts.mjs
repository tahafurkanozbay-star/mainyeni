#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_ROOT = path.resolve(process.cwd());
const WEBCLIENT_DIR = 'Webclient.app';

const REQUIRED_WEB_SCRIPTS = Object.freeze([
  'dev',
  'build',
  'build:verify',
  'quality:module-graph',
  'quality:language-ratchet',
  'quality:platform-boundaries',
  'quality:browser-runtime',
  'lint',
  'lint:strict',
  'test:ci',
  'typecheck',
  'verify',
]);

const MODERN_WEB_BASELINE = Object.freeze({
  dependencies: Object.freeze({
    react: 19,
    'react-dom': 19,
    bootstrap: 5,
  }),
  devDependencies: Object.freeze({
    typescript: 7,
    vite: 8,
    vitest: 5,
    oxlint: 1,
    '@vitejs/plugin-react': 6,
  }),
  engines: Object.freeze({
    node: 24,
    npm: 11,
  }),
});

const EXPECTED_TSC_PROJECTS = Object.freeze([
  'tsconfig.json',
  'tsconfig.platform.json',
  'tsconfig.gis.json',
  'tsconfig.experience.json',
  'tsconfig.data-search.json',
]);

const WEB_ENTRYPOINTS = Object.freeze([
  'index.html',
  'src/main.tsx',
  'vite.config.ts',
  'vitest.config.ts',
]);

const normalizePath = (value) => value.split(path.sep).join('/');
const relative = (root, file) => normalizePath(path.relative(root, file));

const exists = async (file) => {
  try {
    const stats = await fs.stat(file);
    return stats.isFile();
  } catch {
    return false;
  }
};

const readText = async (file) => fs.readFile(file, 'utf8');
const readJson = async (file) => JSON.parse(await readText(file));

const firstNumericMajor = (value) => {
  const match = String(value ?? '').match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
};

const xmlValue = (text, tag) => {
  const match = text.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i'));
  return match?.[1]?.trim() ?? null;
};

const addFinding = (report, severity, code, message, file = null, detail = null) => {
  report.findings.push(Object.freeze({ severity, code, message, file, detail }));
};

const compareMajor = (report, source, name, expectedMajor, file, codePrefix) => {
  const spec = source?.[name];
  if (!spec) {
    addFinding(report, 'error', `${codePrefix}-missing`, `${name} must be declared for the modern platform baseline.`, file);
    return;
  }

  const major = firstNumericMajor(spec);
  if (!Number.isFinite(major) || major < expectedMajor) {
    addFinding(
      report,
      'error',
      `${codePrefix}-version`,
      `${name} must use major version ${expectedMajor} or newer.`,
      file,
      { declared: spec, expectedMajor },
    );
  }
};

const collectTscProjects = (scripts = {}) => {
  const projects = new Set();
  for (const command of Object.values(scripts)) {
    for (const segment of String(command).split(/&&|\|\|/)) {
      if (!/\btsc\b/.test(segment)) continue;
      const match = segment.match(/(?:--project|-p)\s+["']?([^"';&|\s]+)["']?/);
      if (match?.[1]) projects.add(match[1]);
    }
  }
  return [...projects].sort();
};

const resolveExtendedPath = (file, extended) => {
  if (!extended.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(file), extended);
  return path.extname(candidate) ? candidate : `${candidate}.json`;
};

const resolveTsconfig = async (file, seen = new Set()) => {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) throw new Error(`Circular tsconfig extends chain: ${resolved}`);

  const nextSeen = new Set(seen);
  nextSeen.add(resolved);
  const config = await readJson(resolved);
  let inherited = {};

  if (typeof config.extends === 'string') {
    const parentPath = resolveExtendedPath(resolved, config.extends);
    if (parentPath) inherited = await resolveTsconfig(parentPath, nextSeen);
  }

  return {
    ...inherited,
    ...config,
    compilerOptions: {
      ...(inherited.compilerOptions || {}),
      ...(config.compilerOptions || {}),
    },
    include: config.include ?? inherited.include,
    exclude: config.exclude ?? inherited.exclude,
  };
};

const validateCompilerOptions = (report, config, file, root) => {
  const options = config.compilerOptions || {};
  const display = relative(root, file);
  const expectedTrue = [
    'strict',
    'noEmit',
    'isolatedModules',
    'noUncheckedIndexedAccess',
    'useUnknownInCatchVariables',
    'forceConsistentCasingInFileNames',
  ];

  for (const option of expectedTrue) {
    if (options[option] !== true) {
      addFinding(report, 'error', `tsconfig-${option}`, `TypeScript project must enable ${option}.`, display);
    }
  }

  if (String(options.moduleResolution || '').toLowerCase() !== 'bundler') {
    addFinding(
      report,
      'error',
      'tsconfig-module-resolution',
      'TypeScript project must use Bundler module resolution for the Vite runtime.',
      display,
      { declared: options.moduleResolution ?? null },
    );
  }

  const targetMajor = firstNumericMajor(options.target);
  if (!Number.isFinite(targetMajor) || targetMajor < 2022) {
    addFinding(
      report,
      'error',
      'tsconfig-target',
      'TypeScript project target must be ES2022 or newer.',
      display,
      { declared: options.target ?? null },
    );
  }
};

const validateTypeScriptProjects = async (root, webRoot, packageJson, report) => {
  const referenced = collectTscProjects(packageJson.scripts);

  for (const expected of EXPECTED_TSC_PROJECTS) {
    if (!referenced.includes(expected)) {
      addFinding(
        report,
        'error',
        'tsconfig-not-gated',
        `${expected} must be executed by a package typecheck script.`,
        relative(root, path.join(webRoot, 'package.json')),
        { expected },
      );
    }
  }

  for (const project of referenced) {
    const file = path.resolve(webRoot, project);
    if (!await exists(file)) {
      addFinding(
        report,
        'error',
        'tsconfig-missing',
        `Typecheck script references a missing TypeScript project: ${project}.`,
        relative(root, path.join(webRoot, 'package.json')),
        { project },
      );
      continue;
    }

    try {
      const config = await resolveTsconfig(file);
      validateCompilerOptions(report, config, file, root);
    } catch (error) {
      addFinding(
        report,
        'error',
        'tsconfig-invalid',
        `Unable to resolve ${project}.`,
        relative(root, file),
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  const platformConfigPath = path.join(webRoot, 'tsconfig.platform.json');
  if (await exists(platformConfigPath)) {
    try {
      const platformConfig = await resolveTsconfig(platformConfigPath);
      if (platformConfig.compilerOptions?.allowJs !== false) {
        addFinding(
          report,
          'error',
          'tsconfig-platform-allow-js',
          'Platform TypeScript boundary must explicitly disable allowJs after the typed runtime cutover.',
          relative(root, platformConfigPath),
        );
      }
    } catch (error) {
      addFinding(
        report,
        'error',
        'tsconfig-platform-invalid',
        'Platform TypeScript configuration cannot be resolved.',
        relative(root, platformConfigPath),
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  const rootConfigPath = path.join(webRoot, 'tsconfig.json');
  if (await exists(rootConfigPath)) {
    try {
      const rootConfig = await resolveTsconfig(rootConfigPath);
      const options = rootConfig.compilerOptions || {};
      for (const option of ['exactOptionalPropertyTypes', 'verbatimModuleSyntax']) {
        if (options[option] !== true) {
          addFinding(
            report,
            'error',
            `tsconfig-root-${option}`,
            `Root TypeScript project must enable ${option}.`,
            relative(root, rootConfigPath),
          );
        }
      }

      if (options.allowJs === true) {
        addFinding(
          report,
          'warning',
          'typescript-legacy-js-bridge',
          'Root TypeScript still allows JavaScript imports. Keep this only while legacy consumers are actively migrating.',
          relative(root, rootConfigPath),
        );
      }
    } catch (error) {
      addFinding(
        report,
        'error',
        'tsconfig-root-invalid',
        'Root TypeScript configuration cannot be resolved.',
        relative(root, rootConfigPath),
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
};

const validateWebclient = async (root, report) => {
  const webRoot = path.join(root, WEBCLIENT_DIR);
  const packageFile = path.join(webRoot, 'package.json');

  if (!await exists(packageFile)) {
    addFinding(report, 'error', 'webclient-package-missing', 'Webclient.app/package.json is required.', WEBCLIENT_DIR);
    return;
  }

  let packageJson;
  try {
    packageJson = await readJson(packageFile);
  } catch (error) {
    addFinding(
      report,
      'error',
      'webclient-package-invalid',
      'Webclient package.json must be valid JSON.',
      relative(root, packageFile),
      { error: error instanceof Error ? error.message : String(error) },
    );
    return;
  }

  if (packageJson.private !== true) {
    addFinding(report, 'error', 'webclient-private', 'Application package must remain private.', relative(root, packageFile));
  }
  if (packageJson.type !== 'module') {
    addFinding(report, 'error', 'webclient-esm', 'Application package must use native ESM.', relative(root, packageFile));
  }

  const scripts = packageJson.scripts || {};
  for (const script of REQUIRED_WEB_SCRIPTS) {
    if (!scripts[script]) {
      addFinding(report, 'error', 'webclient-script-missing', `Required webclient script is missing: ${script}.`, relative(root, packageFile), { script });
    }
  }

  const allCommands = Object.values(scripts).join('\n');
  if (/\breact-scripts\b/.test(allCommands)) {
    addFinding(report, 'error', 'cra-script', 'CRA/react-scripts commands are not allowed in the modern Vite runtime.', relative(root, packageFile));
  }
  if (!/\bvite\s+build\b/.test(String(scripts.build || ''))) {
    addFinding(report, 'error', 'vite-build-script', 'Production build must execute vite build.', relative(root, packageFile));
  }
  if (!/\bvitest\s+run\b/.test(String(scripts['test:ci'] || ''))) {
    addFinding(report, 'error', 'vitest-ci-script', 'CI tests must execute vitest run.', relative(root, packageFile));
  }
  if (!/\boxlint\b/.test(String(scripts['lint:strict'] || ''))) {
    addFinding(report, 'error', 'oxlint-script', 'Strict lint must execute Oxlint.', relative(root, packageFile));
  }

  const dependencies = packageJson.dependencies || {};
  const devDependencies = packageJson.devDependencies || {};
  for (const forbidden of ['react-scripts', 'craco', '@craco/craco']) {
    if (dependencies[forbidden] || devDependencies[forbidden]) {
      addFinding(report, 'error', 'legacy-build-dependency', `${forbidden} is not allowed in the modern webclient toolchain.`, relative(root, packageFile));
    }
  }

  for (const [name, major] of Object.entries(MODERN_WEB_BASELINE.dependencies)) {
    compareMajor(report, dependencies, name, major, relative(root, packageFile), `dependency-${name}`);
  }
  for (const [name, major] of Object.entries(MODERN_WEB_BASELINE.devDependencies)) {
    compareMajor(report, devDependencies, name, major, relative(root, packageFile), `dev-dependency-${name}`);
  }
  for (const [name, major] of Object.entries(MODERN_WEB_BASELINE.engines)) {
    compareMajor(report, packageJson.engines || {}, name, major, relative(root, packageFile), `engine-${name}`);
  }

  for (const entry of WEB_ENTRYPOINTS) {
    const file = path.join(webRoot, entry);
    if (!await exists(file)) {
      addFinding(report, 'error', 'webclient-entrypoint-missing', `Modern webclient entrypoint/config is missing: ${entry}.`, relative(root, file));
    }
  }

  const legacyIndex = path.join(webRoot, 'src', 'index.js');
  if (await exists(legacyIndex)) {
    addFinding(
      report,
      'warning',
      'legacy-js-entrypoint',
      'Legacy src/index.js still exists; the production entrypoint should stay on main.tsx.',
      relative(root, legacyIndex),
    );
  }

  await validateTypeScriptProjects(root, webRoot, packageJson, report);
};

const validateDotnet = async (root, report) => {
  const globalJsonFile = path.join(root, 'global.json');
  const buildPropsFile = path.join(root, 'Directory.Build.props');
  const packagePropsFile = path.join(root, 'Directory.Packages.props');

  if (!await exists(globalJsonFile)) {
    addFinding(report, 'error', 'dotnet-global-json-missing', 'global.json is required to pin the .NET SDK.', 'global.json');
  } else {
    try {
      const globalJson = await readJson(globalJsonFile);
      const sdk = globalJson.sdk || {};
      if (firstNumericMajor(sdk.version) < 10) {
        addFinding(report, 'error', 'dotnet-sdk-version', '.NET SDK must remain on major version 10 or newer.', 'global.json', { declared: sdk.version ?? null });
      }
      if (sdk.allowPrerelease !== false) {
        addFinding(report, 'error', 'dotnet-sdk-prerelease', '.NET SDK prerelease resolution must remain disabled.', 'global.json');
      }
      if (sdk.rollForward !== 'latestPatch') {
        addFinding(report, 'warning', 'dotnet-sdk-rollforward', 'SDK rollForward should stay latestPatch for deterministic servicing updates.', 'global.json', { declared: sdk.rollForward ?? null });
      }
      if (globalJson.test?.runner !== 'Microsoft.Testing.Platform') {
        addFinding(report, 'error', 'dotnet-test-runner', 'global.json must use Microsoft.Testing.Platform.', 'global.json');
      }
    } catch (error) {
      addFinding(report, 'error', 'dotnet-global-json-invalid', 'global.json must be valid JSON.', 'global.json', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!await exists(buildPropsFile)) {
    addFinding(report, 'error', 'dotnet-build-props-missing', 'Directory.Build.props is required for the shared backend baseline.', 'Directory.Build.props');
  } else {
    const text = await readText(buildPropsFile);
    const targetFramework = xmlValue(text, 'TargetFramework');
    const langVersion = xmlValue(text, 'LangVersion');
    const nullable = String(xmlValue(text, 'Nullable') || '').toLowerCase();
    const analyzers = String(xmlValue(text, 'EnableNETAnalyzers') || '').toLowerCase();
    const analysisLevel = String(xmlValue(text, 'AnalysisLevel') || '').toLowerCase();
    const deterministic = String(xmlValue(text, 'Deterministic') || '').toLowerCase();
    const restoreAuditMode = String(xmlValue(text, 'RestoreAuditMode') || '').toLowerCase();
    const restoreAuditLevel = String(xmlValue(text, 'RestoreAuditLevel') || '').toLowerCase();
    const warningsAsErrors = xmlValue(text, 'WarningsAsErrors') || '';

    if (targetFramework !== 'net10.0') {
      addFinding(report, 'error', 'dotnet-target-framework', 'Shared backend target must remain net10.0.', 'Directory.Build.props', { declared: targetFramework });
    }
    if (firstNumericMajor(langVersion) < 14) {
      addFinding(report, 'error', 'dotnet-language-version', 'Shared backend language baseline must remain C# 14 or newer.', 'Directory.Build.props', { declared: langVersion });
    }
    if (!['annotations', 'enable'].includes(nullable)) {
      addFinding(
        report,
        'error',
        'dotnet-nullable-disabled',
        'Nullable annotations must be enabled globally as the staged path toward full nullable analysis.',
        'Directory.Build.props',
        { declared: nullable || null },
      );
    }
    if (nullable === 'annotations') {
      addFinding(
        report,
        'warning',
        'dotnet-nullable-staged',
        'Nullable annotations are enabled but warnings remain staged; migrate projects to nullable=enable incrementally.',
        'Directory.Build.props',
      );
    }
    if (analyzers !== 'true') {
      addFinding(report, 'error', 'dotnet-analyzers', '.NET analyzers must remain enabled.', 'Directory.Build.props');
    }
    if (analysisLevel !== 'latest') {
      addFinding(report, 'error', 'dotnet-analysis-level', '.NET analyzer level must remain latest.', 'Directory.Build.props', { declared: analysisLevel || null });
    }
    if (deterministic !== 'true') {
      addFinding(report, 'error', 'dotnet-deterministic', 'Deterministic builds must remain enabled.', 'Directory.Build.props');
    }
    if (restoreAuditMode !== 'all' || !['low', 'moderate'].includes(restoreAuditLevel)) {
      addFinding(
        report,
        'error',
        'dotnet-restore-audit',
        'NuGet restore audit must cover all dependencies at moderate-or-stricter severity.',
        'Directory.Build.props',
        { mode: restoreAuditMode || null, level: restoreAuditLevel || null },
      );
    }
    for (const code of ['NU1903', 'NU1904']) {
      if (!warningsAsErrors.includes(code)) {
        addFinding(report, 'error', 'dotnet-vulnerability-gate', `${code} must remain a build error.`, 'Directory.Build.props');
      }
    }
  }

  if (!await exists(packagePropsFile)) {
    addFinding(report, 'error', 'dotnet-package-props-missing', 'Directory.Packages.props is required for central package management.', 'Directory.Packages.props');
  } else {
    const text = await readText(packagePropsFile);
    if (String(xmlValue(text, 'ManagePackageVersionsCentrally') || '').toLowerCase() !== 'true') {
      addFinding(report, 'error', 'dotnet-central-package-management', 'Central package management must remain enabled.', 'Directory.Packages.props');
    }
  }
};

const summarize = (report) => {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of report.findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  return Object.freeze({
    generatedAt: new Date().toISOString(),
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    passed: counts.error === 0,
  });
};

const markdown = (report) => {
  const rows = report.findings.length
    ? report.findings
      .map((finding) => `| ${finding.severity} | ${finding.code} | ${finding.file || ''} | ${finding.message.replace(/\|/g, '\\|')} |`)
      .join('\n')
    : '| _none_ | | | |';

  return `# Platform Contracts\n\nGenerated: ${report.summary.generatedAt}\n\n` +
    `- Errors: **${report.summary.errors}**\n` +
    `- Warnings: **${report.summary.warnings}**\n` +
    `- Gate: **${report.summary.passed ? 'PASS' : 'FAIL'}**\n\n` +
    `## Findings\n\n| Severity | Code | File | Message |\n| --- | --- | --- | --- |\n${rows}\n\n` +
    `## Contract scope\n\n` +
    `This gate validates the modern Vite/React/TypeScript toolchain, strict TypeScript project wiring, ` +
    `.NET 10 / C# 14 SDK and analyzer posture, centralized package management, and vulnerability-audit build gates. ` +
    `It intentionally does not introduce WMS/WFS or alter product behavior.\n`;
};

export async function runPlatformContracts(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const report = { findings: [] };
  await validateWebclient(resolvedRoot, report);
  await validateDotnet(resolvedRoot, report);
  report.findings.sort((left, right) =>
    left.severity.localeCompare(right.severity) ||
    String(left.file || '').localeCompare(String(right.file || '')) ||
    left.code.localeCompare(right.code));
  report.summary = summarize(report);
  return report;
}

async function main() {
  const report = await runPlatformContracts(DEFAULT_ROOT);
  const outDir = path.join(DEFAULT_ROOT, 'artifacts', 'platform-audit');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'platform-contracts.json'), `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(path.join(outDir, 'platform-contracts.md'), markdown(report));
  console.log(JSON.stringify(report.summary, null, 2));
  if (!report.summary.passed) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
