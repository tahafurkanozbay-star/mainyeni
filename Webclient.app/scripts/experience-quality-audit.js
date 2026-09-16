#!/usr/bin/env node

/**
 * Kent Rehberi Experience quality guard.
 *
 * Dependency-free by design so it can run before CRA/Jest and during toolchain
 * migrations. The guard blocks new remote presentation assets, destructive
 * keyboard-focus suppression and competing GIS icon registries. Existing debt
 * is explicit and narrow; removing an allowlisted item should remove its budget.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOTS = ["src", "public"];
const TEXT_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".html", ".htm"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);
const LARGE_ASSET_BYTES = 1024 * 1024;
const CANONICAL_ICON_REGISTRY = "src/gis-engine/iconRegistry.json";
const ICON_RESOLVER = "src/gis-engine/iconResolver.js";
const ICON_PRESENTATION = "src/gis-engine/iconPresentation.js";

const LEGACY_DEBT = Object.freeze({
    remotePresentation: new Map([
        ["src/styles.css", ["fonts.googleapis.com/css?family=Mukta"]],
        ["public/index.html", ["js.arcgis.com/4.25/esri/css/main.css"]]
    ]),
    destructiveFocus: new Map([
        ["src/styles.css", [".btn:focus-visible"]]
    ])
});

const normalise = value => value.split(path.sep).join("/");
const relativeToRoot = value => normalise(path.relative(ROOT, value));

function walk(directory, files = []) {
    if (!fs.existsSync(directory)) return files;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "build" || entry.name === ".git") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute, files);
        else files.push(absolute);
    }
    return files;
}

function lineNumber(content, index) {
    return content.slice(0, index).split("\n").length;
}

function debtAllows(kind, relativeFile, context) {
    const entries = LEGACY_DEBT[kind]?.get(normalise(relativeFile).replace(/^\.\//, "")) || [];
    return entries.some(token => String(context).includes(token));
}

function finding(kind, severity, file, line, message) {
    return { kind, severity, file, line, message };
}

function isPresentationElement(tag) {
    if (/^<script\b/i.test(tag)) return true;
    if (!/^<link\b/i.test(tag)) return false;
    const rel = tag.match(/\brel=["']([^"']+)["']/i)?.[1] || "";
    return rel.split(/\s+/).some(token => token.toLowerCase() === "stylesheet");
}

function auditRemotePresentationAssets(file, content) {
    const relativeFile = relativeToRoot(file);
    const findings = [];
    const patterns = [
        { regex: /@import\s+(?:url\()?\s*["']?(https?:\/\/[^\s"')]+)["']?\s*\)?/gi, presentationOnly: false },
        { regex: /<(?:link|script)\b[^>]+(?:href|src)=["'](https?:\/\/[^"']+)["'][^>]*>/gi, presentationOnly: true }
    ];

    for (const { regex, presentationOnly } of patterns) {
        let match;
        while ((match = regex.exec(content)) !== null) {
            if (presentationOnly && !isPresentationElement(match[0])) continue;
            const target = match[1] || match[0];
            const line = lineNumber(content, match.index);
            const allowed = debtAllows("remotePresentation", relativeFile, target);
            findings.push(finding(
                "remote-presentation",
                allowed ? "warning" : "error",
                relativeFile,
                line,
                `${allowed ? "Legacy allowlist" : "Remote presentation asset"}: ${target}`
            ));
        }
    }

    return findings;
}

function splitCssRules(content) {
    const rules = [];
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rulePattern.exec(content)) !== null) {
        rules.push({ selector: match[1].trim(), body: match[2], index: match.index });
    }
    return rules;
}

function isPointerOnlyFocusException(selector) {
    return selector.includes(":focus:not(:focus-visible)");
}

function hasVisibleShadow(body) {
    return /box-shadow\s*:\s*(?!\s*none\b)[^;]+/i.test(body);
}

function auditFocusVisibility(file, content) {
    if (path.extname(file).toLowerCase() !== ".css") return [];
    const relativeFile = relativeToRoot(file);
    const findings = [];

    for (const rule of splitCssRules(content)) {
        if (!/:focus(?:-visible)?\b/.test(rule.selector)) continue;
        if (isPointerOnlyFocusException(rule.selector)) continue;

        const removesOutline = /outline\s*:\s*(?:0|none)\s*!important/i.test(rule.body);
        const destructive = removesOutline && !hasVisibleShadow(rule.body);
        if (!destructive) continue;

        const line = lineNumber(content, rule.index);
        const allowed = debtAllows("destructiveFocus", relativeFile, rule.selector);
        findings.push(finding(
            "focus-visibility",
            allowed ? "warning" : "error",
            relativeFile,
            line,
            `${allowed ? "Legacy allowlist" : "Keyboard focus suppressed"}: ${rule.selector.replace(/\s+/g, " ")}`
        ));
    }

    return findings;
}

function auditLargeAsset(file) {
    if (!ASSET_EXTENSIONS.has(path.extname(file).toLowerCase())) return [];
    const size = fs.statSync(file).size;
    if (size <= LARGE_ASSET_BYTES) return [];
    return [finding(
        "large-asset",
        "warning",
        relativeToRoot(file),
        1,
        `Asset ${(size / 1024 / 1024).toFixed(2)} MiB; verify it is compressed, local and lazy-loaded when appropriate.`
    )];
}

function auditIconAuthority(allFiles) {
    const findings = [];
    const registries = allFiles
        .map(relativeToRoot)
        .filter(file => path.basename(file).toLowerCase() === "iconregistry.json");

    if (!registries.includes(CANONICAL_ICON_REGISTRY)) {
        findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, 1, "Canonical GIS icon registry is missing."));
        return findings;
    }
    if (registries.length !== 1) {
        findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, 1, `Expected one iconRegistry.json, found ${registries.length}: ${registries.join(", ")}`));
    }

    const registryPath = path.join(ROOT, CANONICAL_ICON_REGISTRY);
    let registry;
    try {
        registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    } catch (error) {
        findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, 1, `Registry is not valid JSON: ${error.message}`));
        return findings;
    }

    if (!Array.isArray(registry) || registry.length === 0) {
        findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, 1, "Registry must be a non-empty array."));
        return findings;
    }

    const ids = new Set();
    for (const [index, item] of registry.entries()) {
        if (!item || typeof item.id !== "string" || !item.id.trim()) {
            findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, index + 1, "Every icon entry needs a stable id."));
            continue;
        }
        if (ids.has(item.id)) findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, index + 1, `Duplicate icon id: ${item.id}`));
        ids.add(item.id);
        if (typeof item.icon !== "string" || !item.icon.trim()) findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, index + 1, `Icon ${item.id} has no asset path.`));
        else if (/^(?:https?:)?\/\//i.test(item.icon)) findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, index + 1, `Icon ${item.id} uses a remote asset.`));
    }
    if (!ids.has("default")) findings.push(finding("icon-authority", "error", CANONICAL_ICON_REGISTRY, 1, "Registry must define the deterministic default icon."));

    const resolverPath = path.join(ROOT, ICON_RESOLVER);
    if (!fs.existsSync(resolverPath)) {
        findings.push(finding("icon-authority", "error", ICON_RESOLVER, 1, "Shared icon resolver is missing."));
    } else {
        const resolver = fs.readFileSync(resolverPath, "utf8");
        if (!resolver.includes("buildIconRegistry") || !resolver.includes("resolveIcon")) {
            findings.push(finding("icon-authority", "error", ICON_RESOLVER, 1, "Shared icon resolver must expose deterministic registry construction and resolution."));
        }
    }

    const presentationPath = path.join(ROOT, ICON_PRESENTATION);
    if (!fs.existsSync(presentationPath)) {
        findings.push(finding("icon-authority", "error", ICON_PRESENTATION, 1, "Shared icon presentation adapter is missing."));
    } else {
        const presentation = fs.readFileSync(presentationPath, "utf8");
        if (!presentation.includes("iconRegistry.json") || !presentation.includes("iconResolver")) {
            findings.push(finding("icon-authority", "error", ICON_PRESENTATION, 1, "Shared presentation adapter must connect iconRegistry.json to iconResolver."));
        }
    }

    return findings;
}

function runAudit() {
    const files = SOURCE_ROOTS.flatMap(root => walk(path.join(ROOT, root)));
    const findings = [];

    for (const file of files) {
        const extension = path.extname(file).toLowerCase();
        if (TEXT_EXTENSIONS.has(extension)) {
            const content = fs.readFileSync(file, "utf8");
            findings.push(...auditRemotePresentationAssets(file, content));
            findings.push(...auditFocusVisibility(file, content));
        }
        findings.push(...auditLargeAsset(file));
    }
    findings.push(...auditIconAuthority(files));
    return findings;
}

function selfTest() {
    const tempRoot = path.join(ROOT, "src", "__experience_audit_virtual__.css");
    const stylesPath = path.join(ROOT, "src", "styles.css");
    const relativeVirtual = relativeToRoot(tempRoot);

    assert.strictEqual(auditRemotePresentationAssets(tempRoot, "@import url('https://cdn.example.com/ui.css');")[0].severity, "error");
    assert.strictEqual(auditRemotePresentationAssets(tempRoot, '<link rel="canonical" href="https://example.com/">').length, 0);
    assert.strictEqual(auditRemotePresentationAssets(tempRoot, '<link rel="stylesheet" href="https://cdn.example.com/ui.css">')[0].severity, "error");
    assert.strictEqual(auditRemotePresentationAssets(stylesPath, "@import url('https://fonts.googleapis.com/css?family=Mukta');")[0].severity, "warning");
    assert.strictEqual(auditFocusVisibility(tempRoot, ".x:focus-visible { outline: none !important; }")[0].severity, "error");
    assert.strictEqual(auditFocusVisibility(tempRoot, ".x:focus:not(:focus-visible) { outline: none; }").length, 0);
    assert.strictEqual(auditFocusVisibility(tempRoot, ".x:focus-visible { outline: 2px solid blue; }").length, 0);
    assert.strictEqual(auditFocusVisibility(tempRoot, ".x:focus-visible { outline: 0 !important; box-shadow: 0 0 0 3px blue !important; }").length, 0);
    assert.strictEqual(auditFocusVisibility(tempRoot, ".x:focus-visible { box-shadow: none !important; }").length, 0);
    assert.strictEqual(auditFocusVisibility(tempRoot, ".x:focus-visible { outline: 0 !important; box-shadow: none !important; }")[0].severity, "error");
    assert.strictEqual(debtAllows("remotePresentation", relativeVirtual, "https://fonts.googleapis.com"), false);
    console.log("Experience quality audit self-test: PASS");
}

function printFindings(findings) {
    for (const item of findings) {
        const prefix = item.severity === "error" ? "ERROR" : "WARN";
        console.log(`${prefix} [${item.kind}] ${item.file}:${item.line} ${item.message}`);
    }
    const errors = findings.filter(item => item.severity === "error").length;
    const warnings = findings.filter(item => item.severity === "warning").length;
    console.log(`Experience quality audit: ${errors} error(s), ${warnings} warning(s).`);
    return errors;
}

if (process.argv.includes("--self-test")) {
    selfTest();
    process.exit(0);
}

const errors = printFindings(runAudit());
process.exit(errors ? 1 : 0);
