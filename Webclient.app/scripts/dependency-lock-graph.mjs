#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), '..');
const ROOT_PATH = '';
const NODE_MODULES = 'node_modules';
const REGISTRY_HOST = 'registry.npmjs.org';

const normalizePath = (value = '') => String(value).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
const sortedEntries = (value = {}) => Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));

export const packageNameFromLockPath = (path) => {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  const segments = normalized.split('/');
  const index = segments.lastIndexOf(NODE_MODULES);
  if (index < 0 || index + 1 >= segments.length) return null;
  const first = segments[index + 1];
  if (first.startsWith('@')) {
    const second = segments[index + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
};

const packageBoundary = (path) => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  const segments = normalized.split('/');
  const index = segments.lastIndexOf(NODE_MODULES);
  if (index < 0) return '';
  const name = packageNameFromLockPath(normalized);
  if (!name) return '';
  const nameSegments = name.startsWith('@') ? 2 : 1;
  return segments.slice(0, index + 1 + nameSegments).join('/');
};

const dependencyCandidate = (base, dependencyName) => (
  base ? `${base}/${NODE_MODULES}/${dependencyName}` : `${NODE_MODULES}/${dependencyName}`
);

export const dependencySearchBases = (fromPath) => {
  const boundary = packageBoundary(fromPath);
  if (!boundary) return [''];
  const segments = boundary.split('/');
  const bases = [boundary];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] !== NODE_MODULES) continue;
    const base = segments.slice(0, index).join('/');
    if (!bases.includes(base)) bases.push(base);
  }
  if (!bases.includes('')) bases.push('');
  return bases;
};

export const resolveDependencyPath = (packages, fromPath, dependencyName) => {
  if (!packages || typeof packages !== 'object') return null;
  if (!dependencyName || typeof dependencyName !== 'string') return null;
  for (const base of dependencySearchBases(fromPath)) {
    const candidate = dependencyCandidate(base, dependencyName);
    if (Object.hasOwn(packages, candidate)) return candidate;
  }
  return null;
};

const directRoots = (root, includeDev = true) => {
  const roots = [];
  const add = (kind, section = {}) => {
    for (const [name, specifier] of sortedEntries(section)) {
      roots.push(Object.freeze({ name, specifier: String(specifier), kind }));
    }
  };
  add('dependency', root?.dependencies);
  add('optional', root?.optionalDependencies);
  if (includeDev) add('development', root?.devDependencies);
  return roots;
};

const childEdges = (entry = {}) => {
  const edges = [];
  for (const [name, specifier] of sortedEntries(entry.dependencies)) {
    edges.push(Object.freeze({ name, specifier: String(specifier), kind: 'dependency', required: true }));
  }
  for (const [name, specifier] of sortedEntries(entry.optionalDependencies)) {
    edges.push(Object.freeze({ name, specifier: String(specifier), kind: 'optional', required: false }));
  }
  return edges;
};

const freezeMapArrays = (map) => Object.freeze(Object.fromEntries(
  [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, Object.freeze([...values])]),
));

export const buildLockGraph = (lockfile, { includeDev = true } = {}) => {
  const errors = [];
  if (!lockfile || typeof lockfile !== 'object') {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(['lock-graph: lockfile document is required']),
      nodes: Object.freeze({}),
      roots: Object.freeze([]),
      unresolved: Object.freeze([]),
      reachable: Object.freeze([]),
      orphans: Object.freeze([]),
      parents: Object.freeze({}),
    });
  }
  if (lockfile.lockfileVersion !== 3) errors.push(`lock-graph: expected lockfileVersion 3, received ${lockfile.lockfileVersion}`);
  const packages = lockfile.packages;
  if (!packages || typeof packages !== 'object') errors.push('lock-graph: packages map is required');
  const root = packages?.[ROOT_PATH];
  if (!root) errors.push('lock-graph: root package entry is missing');
  if (errors.length > 0 || !packages || !root) {
    return Object.freeze({
      ok: false,
      errors: Object.freeze(errors),
      nodes: Object.freeze({}),
      roots: Object.freeze([]),
      unresolved: Object.freeze([]),
      reachable: Object.freeze([]),
      orphans: Object.freeze([]),
      parents: Object.freeze({}),
    });
  }

  const nodes = {};
  for (const [path, entry] of sortedEntries(packages)) {
    if (path === ROOT_PATH) continue;
    const name = packageNameFromLockPath(path);
    nodes[path] = Object.freeze({
      path,
      name,
      version: entry?.version ?? null,
      link: entry?.link === true,
      dev: entry?.dev === true,
      optional: entry?.optional === true,
      devOptional: entry?.devOptional === true,
      resolved: entry?.resolved ?? null,
      integrity: entry?.integrity ?? null,
      deprecated: typeof entry?.deprecated === 'string' ? entry.deprecated : null,
      hasInstallScript: entry?.hasInstallScript === true,
    });
  }

  const roots = [];
  const unresolved = [];
  const queue = [];
  const reachable = new Set();
  const parents = new Map();
  const rememberParent = (child, parent) => {
    const values = parents.get(child) ?? [];
    values.push(parent);
    parents.set(child, values);
  };

  for (const rootEdge of directRoots(root, includeDev)) {
    const target = resolveDependencyPath(packages, ROOT_PATH, rootEdge.name);
    roots.push(Object.freeze({ ...rootEdge, path: target }));
    if (!target) {
      unresolved.push(Object.freeze({
        from: ROOT_PATH,
        name: rootEdge.name,
        kind: rootEdge.kind,
        required: rootEdge.kind !== 'optional',
        specifier: rootEdge.specifier,
      }));
      continue;
    }
    if (!reachable.has(target)) {
      reachable.add(target);
      queue.push(target);
    }
    rememberParent(target, Object.freeze({ from: ROOT_PATH, name: rootEdge.name, kind: rootEdge.kind }));
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const from = queue[cursor];
    const entry = packages[from] ?? {};
    for (const edge of childEdges(entry)) {
      const target = resolveDependencyPath(packages, from, edge.name);
      if (!target) {
        unresolved.push(Object.freeze({
          from,
          name: edge.name,
          kind: edge.kind,
          required: edge.required,
          specifier: edge.specifier,
        }));
        continue;
      }
      rememberParent(target, Object.freeze({ from, name: edge.name, kind: edge.kind }));
      if (!reachable.has(target)) {
        reachable.add(target);
        queue.push(target);
      }
    }
  }

  const nodePaths = Object.keys(nodes).sort();
  const reachablePaths = [...reachable].sort();
  const orphans = nodePaths.filter((path) => !reachable.has(path));
  const hardUnresolved = unresolved.filter((edge) => edge.required);
  if (hardUnresolved.length > 0) {
    errors.push(...hardUnresolved.map((edge) => `lock-graph: unresolved ${edge.kind} ${edge.name} from ${edge.from || '<root>'}`));
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    nodes: Object.freeze(nodes),
    roots: Object.freeze(roots),
    unresolved: Object.freeze(unresolved),
    reachable: Object.freeze(reachablePaths),
    orphans: Object.freeze(orphans),
    parents: freezeMapArrays(parents),
  });
};

export const traceDependencyPath = (graph, targetPath, { maxDepth = 64 } = {}) => {
  if (!graph?.nodes?.[targetPath]) return Object.freeze([]);
  const chain = [];
  const visited = new Set();
  let current = targetPath;
  for (let depth = 0; depth < maxDepth && current; depth += 1) {
    if (visited.has(current)) {
      chain.push(Object.freeze({ path: current, cycle: true }));
      break;
    }
    visited.add(current);
    const parent = graph.parents?.[current]?.[0] ?? null;
    chain.push(Object.freeze({ path: current, via: parent }));
    current = parent?.from || null;
  }
  return Object.freeze(chain.reverse());
};

const integrityAlgorithm = (integrity) => {
  if (typeof integrity !== 'string') return null;
  const token = integrity.trim().split(/\s+/)[0] ?? '';
  const index = token.indexOf('-');
  return index > 0 ? token.slice(0, index).toLowerCase() : null;
};

const resolvedRegistryHost = (resolved) => {
  if (typeof resolved !== 'string' || resolved.trim().length === 0) return null;
  try {
    return new URL(resolved).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export const validateReachableProvenance = (lockfile, graph, {
  allowedRegistryHosts = [REGISTRY_HOST],
  allowedIntegrityAlgorithms = ['sha512'],
} = {}) => {
  const errors = [];
  const packages = lockfile?.packages ?? {};
  const hosts = new Set(allowedRegistryHosts.map((value) => String(value).toLowerCase()));
  const algorithms = new Set(allowedIntegrityAlgorithms.map((value) => String(value).toLowerCase()));

  for (const path of graph?.reachable ?? []) {
    const entry = packages[path] ?? {};
    if (entry.link === true) continue;
    const name = packageNameFromLockPath(path) ?? path;
    if (typeof entry.version !== 'string' || entry.version.trim().length === 0) {
      errors.push(`lock-provenance: ${name} at ${path} has no concrete version`);
    }
    const host = resolvedRegistryHost(entry.resolved);
    if (!host) {
      errors.push(`lock-provenance: ${name} at ${path} has invalid or missing resolved URL`);
    } else if (!hosts.has(host)) {
      errors.push(`lock-provenance: ${name} at ${path} resolves from unapproved host ${host}`);
    }
    const algorithm = integrityAlgorithm(entry.integrity);
    if (!algorithm) {
      errors.push(`lock-provenance: ${name} at ${path} has invalid or missing integrity`);
    } else if (!algorithms.has(algorithm)) {
      errors.push(`lock-provenance: ${name} at ${path} uses unapproved integrity algorithm ${algorithm}`);
    }
  }
  return Object.freeze(errors);
};

export const summarizeLockGraph = (lockfile, graph) => {
  const packages = lockfile?.packages ?? {};
  let deprecated = 0;
  let installScripts = 0;
  let optional = 0;
  let development = 0;
  for (const path of graph?.reachable ?? []) {
    const entry = packages[path] ?? {};
    if (typeof entry.deprecated === 'string' && entry.deprecated.trim()) deprecated += 1;
    if (entry.hasInstallScript === true) installScripts += 1;
    if (entry.optional === true) optional += 1;
    if (entry.dev === true) development += 1;
  }
  return Object.freeze({
    rootCount: graph?.roots?.length ?? 0,
    nodeCount: Object.keys(graph?.nodes ?? {}).length,
    reachableCount: graph?.reachable?.length ?? 0,
    orphanCount: graph?.orphans?.length ?? 0,
    unresolvedCount: graph?.unresolved?.length ?? 0,
    deprecatedReachableCount: deprecated,
    installScriptReachableCount: installScripts,
    optionalReachableCount: optional,
    developmentReachableCount: development,
  });
};

export const analyzeLockGraph = (lockfile, options = {}) => {
  const graph = buildLockGraph(lockfile, options);
  const provenanceErrors = graph.ok ? validateReachableProvenance(lockfile, graph, options) : [];
  const errors = Object.freeze([...graph.errors, ...provenanceErrors]);
  return Object.freeze({
    ok: errors.length === 0,
    errors,
    graph,
    summary: summarizeLockGraph(lockfile, graph),
  });
};

export const runLockGraphContract = async (root = PROJECT_ROOT) => {
  const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  return analyzeLockGraph(lockfile);
};

const main = async () => {
  const result = await runLockGraphContract();
  if (!result.ok) {
    console.error('[dependency:graph] Lock graph contract failed:');
    result.errors.forEach((error) => console.error(`  - ${error}`));
    process.exitCode = 1;
    return;
  }
  const summary = result.summary;
  console.log(`[dependency:graph] ${summary.reachableCount}/${summary.nodeCount} lock nodes reachable from ${summary.rootCount} direct roots.`);
  console.log(`[dependency:graph] orphan=${summary.orphanCount}, unresolved=${summary.unresolvedCount}, deprecated=${summary.deprecatedReachableCount}, install-script=${summary.installScriptReachableCount}.`);
  if (result.graph.orphans.length > 0) {
    console.log(`[dependency:graph] Orphan candidates (report-only): ${result.graph.orphans.join(', ')}`);
  }
  console.log('[dependency:graph] Required dependency edges and reachable registry/integrity provenance are consistent.');
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  await main();
}
