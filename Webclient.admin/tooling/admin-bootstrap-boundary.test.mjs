import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { auditAdminBootstrapBoundary } from './admin-bootstrap-boundary.mjs';

const write = (root, relative, content) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

const withFixture = (callback) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-bootstrap-boundary-'));
  try {
    write(root, 'src/App.tsx', `
import { lazy } from 'react';
import { FullScreenLoading } from './Components/Loading';
import { readAdminSession } from './runtime/adminSession';
const LoginPage = lazy(async () => ({ default: (await import('./Pages/Auth/LoginPage')).LoginPage }));
const AdminAuthenticatedShell = lazy(async () => ({ default: (await import('./Components/AdminAuthenticatedShell')).AdminAuthenticatedShell }));
export const App = () => readAdminSession() ? <AdminAuthenticatedShell /> : <LoginPage />;
`);
    write(root, 'src/Components/Loading.tsx', `
import './Loading.css';
export const FullScreenLoading = () => <div>loading</div>;
`);
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const ids = (report) => new Set(report.findings.map((item) => item.id));

test('accepts a lightweight lazy bootstrap boundary', () => {
  withFixture((root) => {
    const report = auditAdminBootstrapBoundary(root);
    assert.equal(report.ok, true);
    assert.equal(report.findings.length, 0);
  });
});

test('rejects a static auth client import', () => {
  withFixture((root) => {
    const file = path.join(root, 'src', 'App.tsx');
    fs.appendFileSync(file, "\nimport { AuthBusiness } from './Business/AuthBusiness';\n");

    const report = auditAdminBootstrapBoundary(root);
    assert.ok(ids(report).has('forbidden-bootstrap-static-import'));
    assert.ok(ids(report).has('auth-client-in-bootstrap'));
  });
});

test('rejects static router and page imports in App', () => {
  withFixture((root) => {
    const file = path.join(root, 'src', 'App.tsx');
    fs.appendFileSync(file, "\nimport { HashRouter } from 'react-router';\nimport { HomePage } from './Pages/Home/HomePage';\n");

    const report = auditAdminBootstrapBoundary(root);
    assert.ok(ids(report).has('forbidden-bootstrap-static-import'));
  });
});

test('requires LoginPage to remain lazy', () => {
  withFixture((root) => {
    const file = path.join(root, 'src', 'App.tsx');
    const source = fs.readFileSync(file, 'utf8')
      .replace("import('./Pages/Auth/LoginPage')", "Promise.resolve({ LoginPage: () => null })");
    fs.writeFileSync(file, source);

    const report = auditAdminBootstrapBoundary(root);
    assert.ok(ids(report).has('login-not-lazy'));
  });
});

test('requires authenticated shell to remain lazy', () => {
  withFixture((root) => {
    const file = path.join(root, 'src', 'App.tsx');
    const source = fs.readFileSync(file, 'utf8')
      .replace("import('./Components/AdminAuthenticatedShell')", "Promise.resolve({ AdminAuthenticatedShell: () => null })");
    fs.writeFileSync(file, source);

    const report = auditAdminBootstrapBoundary(root);
    assert.ok(ids(report).has('authenticated-shell-not-lazy'));
  });
});

test('rejects UI/runtime libraries from the shared loading module', () => {
  withFixture((root) => {
    fs.writeFileSync(
      path.join(root, 'src', 'Components', 'Loading.tsx'),
      "import { Button } from 'react-bootstrap';\nexport const FullScreenLoading = () => <Button />;\n",
    );

    const report = auditAdminBootstrapBoundary(root);
    assert.ok(ids(report).has('forbidden-bootstrap-static-import'));
  });
});
