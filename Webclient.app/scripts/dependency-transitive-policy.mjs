#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLockGraph, packageNameFromLockPath, resolveDependencyPath } from './dependency-lock-graph.mjs';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), '..');
const ROOT = '';
const MAX_TEXT = 240;
const MAX_PEERS_PER_PACKAGE = 64;
const MAX_INSTALL_SCRIPT_PACKAGES = 128;
const MAX_DEPRECATED_PACKAGES = 128;
const SAFE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const EXACT_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE_TOKEN = /^(?:\^|~|>=?|<=?|=)?\s*v?\d+(?:\.\d+)?(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;

const text = (value) => typeof value === 'string' ? value.trim() : '';
const entries = (value) => Object.entries(value && typeof value === 'object' ? value : {}).sort(([a], [b]) => a.localeCompare(b));
const freeze = (value) => Object.freeze(value);
const unique = (values) => [...new Set(values)].sort();
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const issue = (code, path, detail, severity = 'error') => freeze({ code, path, detail, severity });
const packageEntry = (lockfile, path) => lockfile?.packages?.[path] ?? null;

export const normalizePeerRange = (value) => text(value).replaceAll(/\s+/g, ' ');

export const isConcreteVersion = (value) => EXACT_VERSION.test(text(value));

export const isReviewablePeerRange = (value) => {
  const normalized = normalizePeerRange(value);
  if (!normalized || normalized.length > MAX_TEXT) return false;
  if (/\b(?:latest|next|canary|beta|alpha)\b/i.test(normalized)) return false;
  if (/^(?:file:|link:|git(?:\+|:)|https?:|github:|workspace:)/i.test(normalized)) return false;
  if (normalized === '*' || normalized === 'x' || normalized === 'X') return false;
  const alternatives = normalized.split('||').map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0 || alternatives.length > 8) return false;
  return alternatives.every((alternative) => {
    const tokens = alternative.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 8) return false;
    return tokens.every((token) => RANGE_TOKEN.test(token) || /^\d+\.x$/i.test(token) || /^\d+\.\d+\.x$/i.test(token));
  });
};

const parseVersion = (value) => {
  const match = text(value).replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return freeze({ major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) });
};

const compare = (left, right) => {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  return 0;
};

const satisfiesComparator = (version, comparator) => {
  const token = comparator.trim();
  const match = token.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|x))?(?:\.(\d+|x))?/i);
  if (!match) return false;
  const operator = match[1] ?? '';
  const major = Number(match[2]);
  const minorWild = match[3] == null || /^x$/i.test(match[3]);
  const patchWild = match[4] == null || /^x$/i.test(match[4]);
  const target = { major, minor: minorWild ? 0 : Number(match[3]), patch: patchWild ? 0 : Number(match[4]) };
  if (minorWild) return version.major === target.major;
  if (patchWild) return version.major === target.major && version.minor === target.minor;
  const order = compare(version, target);
  if (operator === '^') {
    if (target.major > 0) return version.major === target.major && order >= 0;
    if (target.minor > 0) return version.major === 0 && version.minor === target.minor && order >= 0;
    return version.major === 0 && version.minor === 0 && version.patch === target.patch;
  }
  if (operator === '~') return version.major === target.major && version.minor === target.minor && order >= 0;
  if (operator === '>=') return order >= 0;
  if (operator === '<=') return order <= 0;
  if (operator === '>') return order > 0;
  if (operator === '<') return order < 0;
  return order === 0;
};

export const satisfiesPeerRange = (versionValue, rangeValue) => {
  const version = parseVersion(versionValue);
  const range = normalizePeerRange(rangeValue);
  if (!version || !isReviewablePeerRange(range)) return false;
  return range.split('||').some((alternative) => alternative.trim().split(/\s+/).filter(Boolean).every((token) => satisfiesComparator(version, token)));
};

export const collectPeerEdges = (lockfile, graph) => {
  const edges = [];
  for (const from of graph?.reachable ?? []) {
    const entry = packageEntry(lockfile, from) ?? {};
    const peers = entries(entry.peerDependencies);
    if (peers.length > MAX_PEERS_PER_PACKAGE) {
      edges.push(freeze({ from, name: '<peer-budget>', range: String(peers.length), optional: false, target: null, targetVersion: null }));
      continue;
    }
    const optionalPeers = entry.peerDependenciesMeta ?? {};
    for (const [name, range] of peers) {
      const target = resolveDependencyPath(lockfile.packages, from, name);
      edges.push(freeze({
        from,
        name,
        range: normalizePeerRange(range),
        optional: optionalPeers?.[name]?.optional === true,
        target,
        targetVersion: target ? packageEntry(lockfile, target)?.version ?? null : null,
      }));
    }
  }
  return freeze(edges.sort((a, b) => `${a.from}\0${a.name}`.localeCompare(`${b.from}\0${b.name}`)));
};

export const validatePeerEdges = (edges) => {
  const issues = [];
  for (const edge of edges ?? []) {
    if (edge.name === '<peer-budget>') {
      issues.push(issue('peer-cardinality', edge.from, `package declares ${edge.range} peers; maximum is ${MAX_PEERS_PER_PACKAGE}`));
      continue;
    }
    if (!SAFE_NAME.test(edge.name)) {
      issues.push(issue('peer-name', edge.from, `invalid peer dependency name ${edge.name}`));
      continue;
    }
    if (!isReviewablePeerRange(edge.range)) {
      issues.push(issue('peer-range', edge.from, `${edge.name} uses unreviewable peer range ${edge.range || '<empty>'}`));
      continue;
    }
    if (!edge.target) {
      if (!edge.optional) issues.push(issue('peer-unresolved', edge.from, `required peer ${edge.name}@${edge.range} is not installed`));
      continue;
    }
    if (!isConcreteVersion(edge.targetVersion)) {
      issues.push(issue('peer-version', edge.target, `${edge.name} resolved without a concrete semver version`));
      continue;
    }
    if (!satisfiesPeerRange(edge.targetVersion, edge.range)) {
      issues.push(issue('peer-mismatch', edge.from, `${edge.name}@${edge.targetVersion} does not satisfy ${edge.range}`));
    }
  }
  return freeze(issues);
};

export const collectInstallScriptSurface = (lockfile, graph) => {
  const result = [];
  for (const path of graph?.reachable ?? []) {
    const entry = packageEntry(lockfile, path) ?? {};
    if (entry.hasInstallScript !== true) continue;
    result.push(freeze({
      path,
      name: packageNameFromLockPath(path),
      version: entry.version ?? null,
      dev: entry.dev === true,
      optional: entry.optional === true,
      resolved: entry.resolved ?? null,
      parentCount: graph?.parents?.[path]?.length ?? 0,
    }));
  }
  return freeze(result.sort((a, b) => a.path.localeCompare(b.path)));
};

export const collectDeprecatedSurface = (lockfile, graph) => {
  const result = [];
  for (const path of graph?.reachable ?? []) {
    const entry = packageEntry(lockfile, path) ?? {};
    const message = text(entry.deprecated);
    if (!message) continue;
    result.push(freeze({ path, name: packageNameFromLockPath(path), version: entry.version ?? null, message: message.slice(0, MAX_TEXT), dev: entry.dev === true }));
  }
  return freeze(result.sort((a, b) => a.path.localeCompare(b.path)));
};

const validateSurface = (surface, { maxCount, code, label }) => {
  const issues = [];
  if (surface.length > maxCount) issues.push(issue(code, '<lockfile>', `${label} count ${surface.length} exceeds budget ${maxCount}`));
  for (const item of surface) {
    if (!item.name || !SAFE_NAME.test(item.name)) issues.push(issue(`${code}-name`, item.path, 'package path does not resolve to a valid npm package name'));
    if (!isConcreteVersion(item.version)) issues.push(issue(`${code}-version`, item.path, 'package has no concrete semver version'));
  }
  return issues;
};

export const buildTransitiveInventory = (lockfile, options = {}) => {
  const graph = options.graph ?? buildLockGraph(lockfile, { includeDev: options.includeDev !== false });
  const peerEdges = collectPeerEdges(lockfile, graph);
  const installScripts = collectInstallScriptSurface(lockfile, graph);
  const deprecated = collectDeprecatedSurface(lockfile, graph);
  const summary = freeze({
    reachable: graph.reachable?.length ?? 0,
    peerEdges: peerEdges.length,
    requiredPeers: peerEdges.filter((edge) => !edge.optional).length,
    optionalPeers: peerEdges.filter((edge) => edge.optional).length,
    installScripts: installScripts.length,
    deprecated: deprecated.length,
  });
  const fingerprintPayload = {
    peers: peerEdges.map(({ from, name, range, optional, target, targetVersion }) => [from, name, range, optional, target, targetVersion]),
    installScripts: installScripts.map(({ path, version }) => [path, version]),
    deprecated: deprecated.map(({ path, version, message }) => [path, version, message]),
  };
  return freeze({ graph, peerEdges, installScripts, deprecated, summary, fingerprint: hash(fingerprintPayload) });
};

export const evaluateTransitivePolicy = (lockfile, options = {}) => {
  const inventory = buildTransitiveInventory(lockfile, options);
  const issues = [];
  if (!inventory.graph.ok) issues.push(...inventory.graph.errors.map((detail) => issue('lock-graph', '<lockfile>', detail)));
  issues.push(...validatePeerEdges(inventory.peerEdges));
  issues.push(...validateSurface(inventory.installScripts, { maxCount: options.maxInstallScripts ?? MAX_INSTALL_SCRIPT_PACKAGES, code: 'install-script-budget', label: 'reachable install-script package' }));
  issues.push(...validateSurface(inventory.deprecated, { maxCount: options.maxDeprecated ?? MAX_DEPRECATED_PACKAGES, code: 'deprecated-budget', label: 'reachable deprecated package' }));
  const ordered = freeze(issues.sort((a, b) => `${a.code}\0${a.path}\0${a.detail}`.localeCompare(`${b.code}\0${b.path}\0${b.detail}`)));
  return freeze({ ok: ordered.length === 0, issues: ordered, inventory });
};

export const diffTransitiveInventory = (baseline, candidate) => {
  const key = (item) => `${item.path}@${item.version ?? '<unknown>'}`;
  const delta = (before, after) => {
    const left = new Set(before.map(key));
    const right = new Set(after.map(key));
    return freeze({ added: freeze([...right].filter((value) => !left.has(value)).sort()), removed: freeze([...left].filter((value) => !right.has(value)).sort()) });
  };
  const peerKey = (edge) => `${edge.from} -> ${edge.name}@${edge.range} -> ${edge.target ?? '<missing>'}`;
  const baselinePeers = new Set((baseline.peerEdges ?? []).map(peerKey));
  const candidatePeers = new Set((candidate.peerEdges ?? []).map(peerKey));
  return freeze({
    installScripts: delta(baseline.installScripts ?? [], candidate.installScripts ?? []),
    deprecated: delta(baseline.deprecated ?? [], candidate.deprecated ?? []),
    peers: freeze({ added: freeze([...candidatePeers].filter((value) => !baselinePeers.has(value)).sort()), removed: freeze([...baselinePeers].filter((value) => !candidatePeers.has(value)).sort()) }),
  });
};

export const runTransitivePolicy = async (root = PROJECT_ROOT) => {
  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  return evaluateTransitivePolicy(lockfile);
};

const main = async () => {
  const result = await runTransitivePolicy();
  const { summary } = result.inventory;
  console.log(`[dependency:transitive] reachable=${summary.reachable}, peers=${summary.peerEdges}, install-script=${summary.installScripts}, deprecated=${summary.deprecated}`);
  console.log(`[dependency:transitive] fingerprint=${result.inventory.fingerprint}`);
  if (!result.ok) {
    console.error('[dependency:transitive] Policy failed:');
    for (const finding of result.issues) console.error(`  - [${finding.code}] ${finding.path}: ${finding.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log('[dependency:transitive] Peer resolution and transitive lifecycle/deprecation budgets are consistent.');
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) await main();
