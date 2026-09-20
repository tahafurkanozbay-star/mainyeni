import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SCRIPT_SOURCE = await fs.readFile(
  new URL("./admin-modernization-audit.mjs", import.meta.url),
  "utf8",
);

const makeRepo = async (options = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-modernization-"));
  await fs.mkdir(path.join(root, "tools"), { recursive: true });
  await fs.mkdir(path.join(root, "Webclient.admin", "src", "Components"), { recursive: true });
  await fs.writeFile(path.join(root, "tools", "admin-modernization-audit.mjs"), SCRIPT_SOURCE);
  await fs.writeFile(
    path.join(root, "tools", "admin-modernization-baseline.json"),
    JSON.stringify({
      schemaVersion: 1,
      maxProductionJavascriptFiles: options.maxJs ?? 2,
      maxJsxInJavascriptFiles: options.maxJsx ?? 1,
      protectedTypedPaths: options.protectedTypedPaths ?? [],
    }),
  );
  await fs.writeFile(
    path.join(root, "Webclient.admin", "package.json"),
    JSON.stringify({
      type: "module",
      dependencies: options.dependencies ?? { react: "19.3.0" },
      scripts: {
        build: "vite build",
        typecheck: "tsc --noEmit",
        test: "vitest run",
        "lint:strict": "oxlint --deny-warnings src",
      },
    }),
  );
  return root;
};

const importAudit = async (root) => {
  const previous = process.cwd();
  process.chdir(root);
  try {
    const modulePath = new URL(
      "file://" + path.join(root, "tools", "admin-modernization-audit.mjs"),
    );
    return await import(modulePath.href + "?test=" + Math.random());
  } finally {
    process.chdir(previous);
  }
};

test("passes a typed-only admin source tree", async () => {
  const root = await makeRepo();
  await fs.writeFile(
    path.join(root, "Webclient.admin", "src", "Components", "Panel.tsx"),
    "export const Panel = () => null;\n",
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?typed"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, true);
    assert.equal(report.summary.productionJavascriptFiles, 0);
    assert.equal(report.summary.productionTypescriptFiles, 1);
  } finally {
    process.chdir(previous);
  }
});

test("blocks react-scripts and esri-loader dependencies", async () => {
  const root = await makeRepo({
    dependencies: { react: "19.3.0", "react-scripts": "4.0.3", "esri-loader": "3.0.0" },
  });
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?deps"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, false);
    assert.equal(
      report.findings.filter((item) => item.code === "forbidden-legacy-dependency").length,
      2,
    );
  } finally {
    process.chdir(previous);
  }
});

test("blocks direct runtime esri-loader imports", async () => {
  const root = await makeRepo();
  await fs.writeFile(
    path.join(root, "Webclient.admin", "src", "Components", "Legacy.js"),
    'import { loadModules } from "esri-loader";\nexport const x = loadModules;\n',
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?esri"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, false);
    assert.ok(report.findings.some((item) => item.code === "legacy-esri-loader"));
  } finally {
    process.chdir(previous);
  }
});

test("blocks non-local plain HTTP runtime literals", async () => {
  const root = await makeRepo();
  await fs.writeFile(
    path.join(root, "Webclient.admin", "src", "Components", "Network.ts"),
    'export const endpoint = "http://example.test/api";\n',
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?http"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, false);
    assert.ok(report.findings.some((item) => item.code === "plain-http-runtime"));
  } finally {
    process.chdir(previous);
  }
});

test("permits localhost HTTP development literals", async () => {
  const root = await makeRepo();
  await fs.writeFile(
    path.join(root, "Webclient.admin", "src", "Components", "Network.ts"),
    'export const endpoint = "http://localhost:5000/api";\n',
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?local"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, true);
  } finally {
    process.chdir(previous);
  }
});

test("enforces JavaScript ratchet ceilings", async () => {
  const root = await makeRepo({ maxJs: 0, maxJsx: 0 });
  await fs.writeFile(
    path.join(root, "Webclient.admin", "src", "Components", "Legacy.js"),
    "export const value = 1;\n",
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?ratchet"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, false);
    assert.ok(report.findings.some((item) => item.code === "javascript-ratchet-regression"));
  } finally {
    process.chdir(previous);
  }
});

test("protects files already migrated to TypeScript", async () => {
  const root = await makeRepo({
    protectedTypedPaths: ["Webclient.admin/src/Components/Panel.tsx"],
  });
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?protected"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, false);
    assert.ok(report.findings.some((item) => item.code === "protected-typed-path-missing"));
  } finally {
    process.chdir(previous);
  }
});

test("warns rather than silently allowing unsafe HTML and console usage", async () => {
  const root = await makeRepo();
  await fs.writeFile(
    path.join(root, "Webclient.admin", "src", "Components", "Legacy.js"),
    'console.log("x");\nexport const x = { dangerouslySetInnerHTML: { __html: "x" } };\n',
  );
  const previous = process.cwd();
  process.chdir(root);
  try {
    const { auditAdminModernization } = await import(
      new URL("file://" + path.join(root, "tools", "admin-modernization-audit.mjs")).href + "?warnings"
    );
    const report = await auditAdminModernization();
    assert.equal(report.summary.passed, true);
    assert.ok(report.findings.some((item) => item.code === "unsafe-html-review"));
    assert.ok(report.findings.some((item) => item.code === "console-production"));
  } finally {
    process.chdir(previous);
  }
});
