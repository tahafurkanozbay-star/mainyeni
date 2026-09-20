#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(process.cwd());
const ADMIN_ROOT = "Webclient.admin";
const SOURCE_ROOT = path.join(ADMIN_ROOT, "src");
const PACKAGE_PATH = path.join(ADMIN_ROOT, "package.json");
const BASELINE_PATH = "tools/admin-modernization-baseline.json";
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts"]);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts"]);
const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec|fixture|mock)\.[^/]+$/iu;
const SKIP_DIRECTORIES = new Set(["node_modules", "build", "dist", "coverage", ".git", ".cache"]);
const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, info: 2 });

const normalize = (value) => value.split(path.sep).join("/");
const relative = (value) => normalize(path.relative(ROOT, value));
const isTestPath = (value) => TEST_PATH.test(normalize(value));

const walk = async (directory, files = []) => {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath, files);
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
};

const readJson = async (file) => JSON.parse(await fs.readFile(path.resolve(ROOT, file), "utf8"));
const lineCount = (source) => source === "" ? 0 : source.split(/\r?\n/u).length;

const finding = (severity, code, message, file = null, detail = null) =>
  Object.freeze({ severity, code, message, file, detail });

const countPattern = (source, pattern) => {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const matcher = new RegExp(pattern.source, flags);
  return [...source.matchAll(matcher)].length;
};

const isLikelyJsx = (source) =>
  /(?:return\s*\(|=>\s*\(|=\s*\()\s*<>?/u.test(source)
  || /<[A-Z][A-Za-z0-9.]*(?:\s|>|\/)/u.test(source)
  || /<[a-z][a-z0-9-]*(?:\s+[A-Za-z_:][^>]*)?>/u.test(source);

const domainOf = (file) => {
  const normalized = normalize(file);
  const marker = ADMIN_ROOT + "/src/";
  const offset = normalized.indexOf(marker);
  if (offset < 0) return "repository";
  return normalized.slice(offset + marker.length).split("/")[0] || "root";
};

const migrationPriority = (record) => {
  const domainWeight = Object.freeze({
    Business: 50,
    Components: 45,
    Pages: 40,
    Shared: 35,
    Core: 30,
    root: 25,
  });
  const sizeWeight = Math.min(50, Math.ceil(record.lines / 25));
  const jsxWeight = record.jsx ? 40 : 0;
  const riskWeight =
    record.signals.unsafeHtml * 30
    + record.signals.esriLoader * 30
    + record.signals.plainHttp * 20
    + record.signals.console * 3;
  return (domainWeight[record.domain] ?? 20) + sizeWeight + jsxWeight + riskWeight;
};

const readBaseline = async () => {
  const baseline = await readJson(BASELINE_PATH);
  if (baseline?.schemaVersion !== 1) {
    throw new Error("Admin modernization baseline schemaVersion=1 olmalıdır.");
  }
  for (const key of ["maxProductionJavascriptFiles", "maxJsxInJavascriptFiles"]) {
    if (!Number.isInteger(baseline[key]) || baseline[key] < 0) {
      throw new Error("Admin modernization baseline geçersiz: " + key);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    maxProductionJavascriptFiles: baseline.maxProductionJavascriptFiles,
    maxJsxInJavascriptFiles: baseline.maxJsxInJavascriptFiles,
    protectedTypedPaths: Object.freeze(
      Array.isArray(baseline.protectedTypedPaths) ? baseline.protectedTypedPaths.map(String) : [],
    ),
  });
};

export const auditAdminModernization = async () => {
  const baseline = await readBaseline();
  const packageJson = await readJson(PACKAGE_PATH);
  const files = (await walk(path.resolve(ROOT, SOURCE_ROOT)))
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .sort();

  const records = [];
  const findings = [];
  for (const file of files) {
    const filePath = relative(file);
    const source = await fs.readFile(file, "utf8");
    const extension = path.extname(file).toLowerCase();
    const javascript = JS_EXTENSIONS.has(extension);
    const typescript = TS_EXTENSIONS.has(extension);
    const test = isTestPath(filePath);
    const signals = Object.freeze({
      esriLoader: countPattern(source, /(?:from\s+["']esri-loader["']|require\(["']esri-loader["']\))/gu),
      reactScripts: countPattern(source, /react-scripts/gu),
      unsafeHtml: countPattern(source, /dangerouslySetInnerHTML/gu),
      plainHttp: countPattern(source, /["'`]http:\/\/(?!localhost(?::|\/)|127\.0\.0\.1(?::|\/)|\[::1\](?::|\/))/giu),
      processEnvCra: countPattern(source, /process\.env\.REACT_APP_/gu),
      console: countPattern(source, /\bconsole\.(?:log|debug|info|warn|error)\s*\(/gu),
      directWindowFetch: countPattern(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/gu),
    });
    const record = {
      path: filePath,
      extension,
      domain: domainOf(filePath),
      test,
      javascript,
      typescript,
      jsx: javascript && isLikelyJsx(source),
      bytes: Buffer.byteLength(source),
      lines: lineCount(source),
      signals,
    };
    record.priority = migrationPriority(record);
    records.push(Object.freeze(record));

    if (!test && signals.esriLoader > 0) {
      findings.push(finding(
        "error",
        "legacy-esri-loader",
        "Admin runtime doğrudan esri-loader kullanıyor; @arcgis/core ESM sınırına taşınmalıdır.",
        filePath,
        { occurrences: signals.esriLoader },
      ));
    }
    if (!test && signals.reactScripts > 0) {
      findings.push(finding(
        "error",
        "legacy-react-scripts-source",
        "Admin runtime react-scripts bağımlılığına referans veriyor.",
        filePath,
      ));
    }
    if (!test && signals.plainHttp > 0) {
      findings.push(finding(
        "error",
        "plain-http-runtime",
        "Admin runtime localhost dışı plain HTTP referansı içeriyor.",
        filePath,
        { occurrences: signals.plainHttp },
      ));
    }
    if (!test && signals.unsafeHtml > 0) {
      findings.push(finding(
        "warning",
        "unsafe-html-review",
        "Admin runtime dangerouslySetInnerHTML kullanıyor; güvenli text rendering tercih edilmelidir.",
        filePath,
        { occurrences: signals.unsafeHtml },
      ));
    }
    if (!test && signals.processEnvCra > 0) {
      findings.push(finding(
        "warning",
        "cra-env-compatibility",
        "Admin runtime CRA process.env sözleşmesine bağlı; Vite import.meta.env sınırına taşınmalıdır.",
        filePath,
        { occurrences: signals.processEnvCra },
      ));
    }
    if (!test && signals.console > 0) {
      findings.push(finding(
        "warning",
        "console-production",
        "Admin runtime doğrudan console logging kullanıyor; bounded diagnostics kullanılmalıdır.",
        filePath,
        { occurrences: signals.console },
      ));
    }
  }

  const production = records.filter((record) => !record.test);
  const productionJavascript = production.filter((record) => record.javascript);
  const jsxInJavascript = productionJavascript.filter((record) => record.jsx);
  const productionTypescript = production.filter((record) => record.typescript);

  if (productionJavascript.length > baseline.maxProductionJavascriptFiles) {
    findings.push(finding(
      "error",
      "javascript-ratchet-regression",
      "Admin production JavaScript dosya sayısı ratchet tavanını aştı.",
      null,
      {
        current: productionJavascript.length,
        ceiling: baseline.maxProductionJavascriptFiles,
      },
    ));
  }
  if (jsxInJavascript.length > baseline.maxJsxInJavascriptFiles) {
    findings.push(finding(
      "error",
      "jsx-in-javascript-ratchet-regression",
      "Admin JSX-in-JavaScript dosya sayısı ratchet tavanını aştı.",
      null,
      {
        current: jsxInJavascript.length,
        ceiling: baseline.maxJsxInJavascriptFiles,
      },
    ));
  }

  const packageDependencies = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };
  for (const forbidden of ["react-scripts", "esri-loader"]) {
    if (packageDependencies[forbidden]) {
      findings.push(finding(
        "error",
        "forbidden-legacy-dependency",
        "Admin dependency graph artık legacy build/ArcGIS loader paketini içermemelidir.",
        PACKAGE_PATH,
        { dependency: forbidden, version: packageDependencies[forbidden] },
      ));
    }
  }

  const requiredScripts = ["build", "typecheck", "test", "lint:strict"];
  for (const script of requiredScripts) {
    if (typeof packageJson.scripts?.[script] !== "string") {
      findings.push(finding(
        "error",
        "missing-quality-script",
        "Admin package kalite sözleşmesi eksik.",
        PACKAGE_PATH,
        { script },
      ));
    }
  }

  const protectedPaths = new Set(baseline.protectedTypedPaths);
  for (const file of protectedPaths) {
    const record = records.find((candidate) => candidate.path === file);
    if (!record) {
      findings.push(finding(
        "error",
        "protected-typed-path-missing",
        "Strict TypeScript'e taşınmış korumalı admin dosyası kayboldu.",
        file,
      ));
    } else if (!record.typescript) {
      findings.push(finding(
        "error",
        "protected-typed-path-regressed",
        "Strict TypeScript'e taşınmış admin dosyası yeniden JavaScript'e dönmüş.",
        file,
      ));
    }
  }

  const orderedFindings = Object.freeze([...findings].sort((left, right) =>
    (SEVERITY_ORDER[left.severity] ?? 99) - (SEVERITY_ORDER[right.severity] ?? 99)
    || String(left.file ?? "").localeCompare(String(right.file ?? ""))
    || left.code.localeCompare(right.code)));

  const migrationQueue = Object.freeze(
    productionJavascript
      .map((record) => Object.freeze({ ...record }))
      .sort((left, right) =>
        right.priority - left.priority
        || right.lines - left.lines
        || left.path.localeCompare(right.path))
      .slice(0, 100),
  );

  const errors = orderedFindings.filter((item) => item.severity === "error").length;
  const warnings = orderedFindings.filter((item) => item.severity === "warning").length;
  const summary = Object.freeze({
    passed: errors === 0,
    errors,
    warnings,
    productionFiles: production.length,
    productionJavascriptFiles: productionJavascript.length,
    productionTypescriptFiles: productionTypescript.length,
    jsxInJavascriptFiles: jsxInJavascript.length,
    typedProductionRatio: production.length === 0 ? 1 : productionTypescript.length / production.length,
    javascriptLines: productionJavascript.reduce((total, record) => total + record.lines, 0),
    typescriptLines: productionTypescript.reduce((total, record) => total + record.lines, 0),
  });

  return Object.freeze({
    schemaVersion: 1,
    baseline,
    summary,
    migrationQueue,
    findings: orderedFindings,
  });
};

const markdown = (report) => {
  const percent = (value) => (value * 100).toFixed(1) + "%";
  const lines = [
    "# Admin Modernization Audit",
    "",
    "Gate: **" + (report.summary.passed ? "PASS" : "FAIL") + "**",
    "",
    "- Production TypeScript files: **" + report.summary.productionTypescriptFiles + "**",
    "- Production JavaScript files: **" + report.summary.productionJavascriptFiles + "**",
    "- JSX-in-JavaScript files: **" + report.summary.jsxInJavascriptFiles + "**",
    "- Typed production ratio: **" + percent(report.summary.typedProductionRatio) + "**",
    "- TypeScript lines: **" + report.summary.typescriptLines + "**",
    "- JavaScript lines: **" + report.summary.javascriptLines + "**",
    "- Errors: **" + report.summary.errors + "**",
    "- Warnings: **" + report.summary.warnings + "**",
    "",
    "## Migration queue",
    "",
    "| Priority | Domain | File | Lines | JSX |",
    "| ---: | --- | --- | ---: | :---: |",
  ];
  if (!report.migrationQueue.length) lines.push("| - | - | _none_ | - | - |");
  else for (const item of report.migrationQueue.slice(0, 50)) {
    lines.push("| " + item.priority + " | " + item.domain + " | " + item.path + " | " + item.lines + " | " + (item.jsx ? "yes" : "no") + " |");
  }
  lines.push("", "## Findings", "", "| Severity | Code | File | Message |", "| --- | --- | --- | --- |");
  if (!report.findings.length) lines.push("| - | - | - | _none_ |");
  else for (const item of report.findings) {
    lines.push("| " + item.severity + " | " + item.code + " | " + (item.file ?? "") + " | " + item.message.replaceAll("|", "\\|") + " |");
  }
  lines.push("");
  return lines.join("\n");
};

const main = async () => {
  const strict = process.argv.includes("--strict");
  const report = await auditAdminModernization();
  const output = path.resolve(ROOT, "artifacts", "admin-modernization");
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(output, "report.md"), markdown(report) + "\n", "utf8");
  process.stdout.write(JSON.stringify(report.summary, null, 2) + "\n");
  if (strict && !report.summary.passed) process.exitCode = 2;
};

if (import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack : String(error)) + "\n");
    process.exitCode = 1;
  });
}
