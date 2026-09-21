import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APP_PATH = path.join('src', 'App.tsx');
const LOADING_PATH = path.join('src', 'Components', 'Loading.tsx');

const FORBIDDEN_APP_STATIC_IMPORTS = Object.freeze([
  './Business/',
  './Pages/',
  './Shared/',
  'axios',
  'react-router',
  'react-bootstrap',
  'react-icons',
  '@arcgis/core',
]);

const FORBIDDEN_LOADING_IMPORTS = Object.freeze([
  'axios',
  'react-router',
  'react-bootstrap',
  'react-icons',
  '@arcgis/core',
]);

const read = (root, relative) =>
  fs.readFileSync(path.join(root, relative), 'utf8');

const staticImportSources = (source) => [
  ...source.matchAll(/^import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"];?\s*$/gmu),
].map((match) => match[1]);

const finding = (id, file, message, detail = undefined) => Object.freeze({
  id,
  file,
  message,
  ...(detail === undefined ? {} : { detail }),
});

const auditImports = (source, file, forbidden, findings) => {
  for (const imported of staticImportSources(source)) {
    for (const prefix of forbidden) {
      if (imported === prefix || imported.startsWith(prefix)) {
        findings.push(finding(
          'forbidden-bootstrap-static-import',
          file,
          'Heavy runtime dependency must not be statically reachable from the admin bootstrap.',
          imported,
        ));
      }
    }
  }
};

export const auditAdminBootstrapBoundary = (root = process.cwd()) => {
  const resolvedRoot = path.resolve(root);
  const findings = [];
  const app = read(resolvedRoot, APP_PATH);
  const loading = read(resolvedRoot, LOADING_PATH);

  auditImports(app, APP_PATH, FORBIDDEN_APP_STATIC_IMPORTS, findings);
  auditImports(loading, LOADING_PATH, FORBIDDEN_LOADING_IMPORTS, findings);

  if (!/import\(['"]\.\/Pages\/Auth\/LoginPage['"]\)/u.test(app)) {
    findings.push(finding(
      'login-not-lazy',
      APP_PATH,
      'LoginPage must remain a dynamic import so axios/form dependencies stay off the bootstrap path.',
    ));
  }

  if (!/import\(['"]\.\/Components\/AdminAuthenticatedShell['"]\)/u.test(app)) {
    findings.push(finding(
      'authenticated-shell-not-lazy',
      APP_PATH,
      'Authenticated router/navigation shell must remain a dynamic import.',
    ));
  }

  if (!/from\s+['"]\.\/runtime\/adminSession['"]/u.test(app)) {
    findings.push(finding(
      'session-runtime-boundary',
      APP_PATH,
      'Bootstrap session detection must use the lightweight adminSession runtime.',
    ));
  }

  if (/AuthBusiness/u.test(app)) {
    findings.push(finding(
      'auth-client-in-bootstrap',
      APP_PATH,
      'AuthBusiness pulls the HTTP client and must not return to the bootstrap module.',
    ));
  }

  return Object.freeze({
    ok: findings.length === 0,
    findings: Object.freeze(findings),
    appStaticImports: Object.freeze(staticImportSources(app)),
    loadingStaticImports: Object.freeze(staticImportSources(loading)),
  });
};

export const formatAdminBootstrapBoundary = (report) => [
  'Admin bootstrap boundary',
  `gate=${report.ok ? 'PASS' : 'FAIL'}`,
  `appStaticImports=${report.appStaticImports.length}`,
  `loadingStaticImports=${report.loadingStaticImports.length}`,
  `violations=${report.findings.length}`,
  ...report.findings.map((item) =>
    `- ${item.id}: ${item.file}: ${item.message}${item.detail ? ` [${item.detail}]` : ''}`),
].join('\n');

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const report = auditAdminBootstrapBoundary(process.cwd());
  process.stdout.write(formatAdminBootstrapBoundary(report) + '\n');
  if (!report.ok) process.exitCode = 1;
}
