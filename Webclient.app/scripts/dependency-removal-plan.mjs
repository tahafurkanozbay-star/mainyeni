#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLockGraph, resolveDependencyPath } from './dependency-lock-graph.mjs';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), '..');
const freeze = Object.freeze;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const entries = (o) => Object.entries(o && typeof o === 'object' ? o : {}).sort(([a], [b]) => a.localeCompare(b));
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const SAFE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/i;
const MAX_DIRECT = 256;
const MAX_IMPACT = 4096;

export const normalizeRemovalCandidates = (value) => {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const raw of source) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!SAFE_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return freeze(result.sort());
};

export const directDependencyKind = (manifest, name) => {
  if (own(manifest?.dependencies, name)) return 'runtime';
  if (own(manifest?.devDependencies, name)) return 'development';
  if (own(manifest?.optionalDependencies, name)) return 'optional';
  if (own(manifest?.peerDependencies, name)) return 'peer';
  return null;
};

export const directDependencyNames = (manifest) => freeze([
  ...entries(manifest?.dependencies).map(([name]) => name),
  ...entries(manifest?.devDependencies).map(([name]) => name),
  ...entries(manifest?.optionalDependencies).map(([name]) => name),
  ...entries(manifest?.peerDependencies).map(([name]) => name),
].filter((name, index, all) => all.indexOf(name) === index).sort());

const childrenOf = (graph, path) => graph?.children?.[path] ?? [];
const parentsOf = (graph, path) => graph?.parents?.[path] ?? [];

export const collectExclusiveClosure = (graph, rootPath) => {
  if (!rootPath) return freeze([]);
  const owned = new Set([rootPath]);
  let changed = true;
  while (changed && owned.size <= MAX_IMPACT) {
    changed = false;
    for (const parent of [...owned]) {
      for (const child of childrenOf(graph, parent)) {
        if (owned.has(child)) continue;
        const parents = parentsOf(graph, child);
        if (parents.length > 0 && parents.every((candidate) => owned.has(candidate))) {
          owned.add(child);
          changed = true;
        }
      }
    }
  }
  return freeze([...owned].sort());
};

export const collectSharedDependents = (graph, closure) => {
  const owned = new Set(closure);
  const shared = new Set();
  for (const path of closure) {
    // The lockfile root ('') is manifest ownership, not an installed-package dependent.
    // Real package parents remain fail-closed blockers.
    for (const parent of parentsOf(graph, path)) {
      if (parent !== '' && !owned.has(parent)) shared.add(parent);
    }
  }
  return freeze([...shared].sort());
};


const uniqueSorted = (values) => freeze([...new Set(values)].sort());

export const collectExclusiveBatchClosure = (graph, rootPaths) => {
  const roots = uniqueSorted((Array.isArray(rootPaths) ? rootPaths : []).filter(Boolean));
  if (roots.length === 0) return freeze([]);
  const owned = new Set(roots);
  let changed = true;
  while (changed && owned.size <= MAX_IMPACT) {
    changed = false;
    for (const parent of [...owned]) {
      for (const child of childrenOf(graph, parent)) {
        if (owned.has(child)) continue;
        const packageParents = parentsOf(graph, child).filter((candidate) => candidate !== '');
        if (packageParents.length > 0 && packageParents.every((candidate) => owned.has(candidate))) {
          owned.add(child);
          changed = true;
        }
      }
    }
  }
  return freeze([...owned].sort());
};

export const collectBatchExternalDependents = (graph, closure) => {
  const owned = new Set(closure ?? []);
  const external = new Set();
  for (const path of owned) {
    for (const parent of parentsOf(graph, path)) {
      if (parent !== '' && !owned.has(parent)) external.add(parent);
    }
  }
  return freeze([...external].sort());
};

const manifestSectionForKind = (kind) => ({
  runtime: 'dependencies',
  development: 'devDependencies',
  optional: 'optionalDependencies',
  peer: 'peerDependencies',
})[kind] ?? null;

const cloneJson = (value) => JSON.parse(JSON.stringify(value));

export const buildBatchRemovalPlan = (manifest, lockfile, candidates, options = {}) => {
  const maxCandidates = options.maxCandidates ?? MAX_DIRECT;
  const normalized = normalizeRemovalCandidates(candidates);
  const issues = [];
  if (normalized.length > maxCandidates) {
    issues.push(`candidate count ${normalized.length} exceeds safety budget ${maxCandidates}`);
  }

  const graph = options.graph ?? buildLockGraph(lockfile, { includeDev: true });
  if (!graph.ok) issues.push(...graph.errors.map((error) => `lock graph: ${error}`));

  const inspected = normalized.slice(0, maxCandidates).map((name) => {
    const kind = directDependencyKind(manifest, name);
    if (!kind) {
      return freeze({
        name,
        kind: null,
        rootPath: null,
        status: 'not-direct',
        blockers: freeze(['candidate is not a direct dependency']),
      });
    }
    const rootPath = resolveDependencyPath(lockfile?.packages ?? {}, '', name);
    if (!rootPath) {
      return freeze({
        name,
        kind,
        rootPath: null,
        status: 'lock-missing',
        blockers: freeze(['direct dependency has no lockfile resolution']),
      });
    }
    return freeze({ name, kind, rootPath, status: 'candidate', blockers: freeze([]) });
  });

  const validRoots = inspected.filter((item) => item.rootPath).map((item) => item.rootPath);
  const closure = collectExclusiveBatchClosure(graph, validRoots);
  const sharedDependents = collectBatchExternalDependents(graph, closure);
  if (closure.length >= MAX_IMPACT) issues.push(`batch closure reached safety limit ${MAX_IMPACT}`);
  if (sharedDependents.length > 0) {
    issues.push(`${sharedDependents.length} external dependent path(s) intersect batch closure`);
  }

  const missing = inspected.filter((item) => item.status !== 'candidate');
  const plannable = issues.length === 0 && missing.length === 0;
  const finalized = inspected.map((item) => {
    if (item.status !== 'candidate') return item;
    return freeze({
      ...item,
      status: plannable ? 'plannable' : 'review',
      blockers: freeze(plannable ? [] : [...issues]),
    });
  });
  const summary = freeze({
    candidates: finalized.length,
    runtime: finalized.filter((item) => item.kind === 'runtime').length,
    development: finalized.filter((item) => item.kind === 'development').length,
    optional: finalized.filter((item) => item.kind === 'optional').length,
    peer: finalized.filter((item) => item.kind === 'peer').length,
    plannable: finalized.filter((item) => item.status === 'plannable').length,
    review: finalized.filter((item) => item.status === 'review').length,
    missing: missing.length,
    exclusivePackages: closure.length,
    externalDependents: sharedDependents.length,
  });
  const payload = [
    finalized.map((item) => [item.name, item.kind, item.status, item.rootPath]),
    closure,
    sharedDependents,
    [...issues].sort(),
  ];

  return freeze({
    ok: plannable,
    issues: freeze([...issues].sort()),
    candidates: freeze(finalized),
    closure,
    sharedDependents,
    summary,
    fingerprint: hash(payload),
  });
};

export const applyBatchRemovalPlan = (manifest, lockfile, plan) => {
  if (!plan?.ok) {
    throw new Error('batch removal plan is not plannable');
  }

  const nextManifest = cloneJson(manifest ?? {});
  const nextLockfile = cloneJson(lockfile ?? {});
  const root = nextLockfile.packages?.[''];
  if (!root) throw new Error('lockfile root package metadata is missing');

  for (const candidate of plan.candidates) {
    const sectionName = manifestSectionForKind(candidate.kind);
    if (!sectionName) throw new Error(`unsupported dependency kind for ${candidate.name}`);
    delete nextManifest[sectionName]?.[candidate.name];
    delete root[sectionName]?.[candidate.name];
  }

  for (const path of plan.closure) {
    delete nextLockfile.packages[path];
  }

  return freeze({ manifest: nextManifest, lockfile: nextLockfile });
};

export const validateBatchRemovalResult = (beforeManifest, beforeLockfile, after, plan) => {
  const errors = [];
  if (!plan?.ok) return freeze(['batch removal plan is not plannable']);
  const manifest = after?.manifest ?? {};
  const lockfile = after?.lockfile ?? {};
  const root = lockfile.packages?.[''];
  if (!root) return freeze(['lockfile root package metadata is missing']);

  for (const candidate of plan.candidates) {
    const sectionName = manifestSectionForKind(candidate.kind);
    if (!sectionName) {
      errors.push(`unsupported dependency kind for ${candidate.name}`);
      continue;
    }
    if (own(manifest?.[sectionName], candidate.name)) {
      errors.push(`manifest still declares retired dependency ${candidate.name}`);
    }
    if (own(root?.[sectionName], candidate.name)) {
      errors.push(`lockfile root still declares retired dependency ${candidate.name}`);
    }
    if (candidate.rootPath && own(lockfile.packages, candidate.rootPath)) {
      errors.push(`lockfile still contains retired root ${candidate.rootPath}`);
    }
  }

  for (const path of plan.closure) {
    if (own(lockfile.packages, path)) errors.push(`lockfile still contains retired closure node ${path}`);
  }

  const beforeCount = Object.keys(beforeLockfile?.packages ?? {}).length;
  const afterCount = Object.keys(lockfile.packages ?? {}).length;
  const expectedCount = beforeCount - plan.closure.length;
  if (afterCount !== expectedCount) {
    errors.push(`lockfile package count ${afterCount} does not match expected ${expectedCount}`);
  }

  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const manifestNames = Object.keys(manifest?.[sectionName] ?? {}).sort();
    const rootNames = Object.keys(root?.[sectionName] ?? {}).sort();
    if (JSON.stringify(manifestNames) !== JSON.stringify(rootNames)) {
      errors.push(`${sectionName} manifest/lock root names differ after retirement`);
    }
  }

  const postGraph = buildLockGraph(lockfile, { includeDev: true });
  if (!postGraph.ok) errors.push(...postGraph.errors.map((error) => `post-removal lock graph: ${error}`));

  return freeze(errors.sort());
};

export const renderBatchRemovalPlan = (plan) => {
  const lines = [
    `Dependency batch removal plan ${plan.fingerprint}`,
    `candidates=${plan.summary.candidates} plannable=${plan.summary.plannable} review=${plan.summary.review} missing=${plan.summary.missing}`,
    `exclusivePackages=${plan.summary.exclusivePackages} externalDependents=${plan.summary.externalDependents}`,
  ];
  for (const item of plan.candidates) {
    lines.push(`${item.name}: ${item.status} (${item.kind ?? 'unknown'}) root=${item.rootPath ?? 'none'}`);
    for (const blocker of item.blockers) lines.push(`  blocker: ${blocker}`);
  }
  for (const dependent of plan.sharedDependents) lines.push(`  external: ${dependent}`);
  for (const issue of plan.issues) lines.push(`policy: ${issue}`);
  return `${lines.join('\n')}\n`;
};

export const inspectCandidate = (manifest, lockfile, graph, name) => {
  const kind = directDependencyKind(manifest, name);
  if (!kind) return freeze({ name, status: 'not-direct', kind: null, rootPath: null, closure: freeze([]), sharedDependents: freeze([]), blockers: freeze(['candidate is not a direct dependency']) });
  const rootPath = resolveDependencyPath(lockfile?.packages ?? {}, '', name);
  if (!rootPath) return freeze({ name, status: 'lock-missing', kind, rootPath: null, closure: freeze([]), sharedDependents: freeze([]), blockers: freeze(['direct dependency has no lockfile resolution']) });
  const closure = collectExclusiveClosure(graph, rootPath);
  const sharedDependents = collectSharedDependents(graph, closure);
  const blockers = [];
  if (closure.length >= MAX_IMPACT) blockers.push(`exclusive closure reached safety limit ${MAX_IMPACT}`);
  if (sharedDependents.length) blockers.push(`${sharedDependents.length} external dependent path(s) intersect candidate closure`);
  return freeze({ name, status: blockers.length ? 'review' : 'plannable', kind, rootPath, closure, sharedDependents, blockers: freeze(blockers) });
};

export const buildRemovalPlan = (manifest, lockfile, candidates, options = {}) => {
  const normalized = normalizeRemovalCandidates(candidates);
  const issues = [];
  if (normalized.length > (options.maxCandidates ?? MAX_DIRECT)) issues.push(`candidate count ${normalized.length} exceeds safety budget ${options.maxCandidates ?? MAX_DIRECT}`);
  const graph = options.graph ?? buildLockGraph(lockfile, { includeDev: true });
  if (!graph.ok) issues.push(...graph.errors.map((error) => `lock graph: ${error}`));
  const inspected = normalized.slice(0, options.maxCandidates ?? MAX_DIRECT).map((name) => inspectCandidate(manifest, lockfile, graph, name));
  const summary = freeze({
    candidates: inspected.length,
    runtime: inspected.filter((item) => item.kind === 'runtime').length,
    development: inspected.filter((item) => item.kind === 'development').length,
    plannable: inspected.filter((item) => item.status === 'plannable').length,
    review: inspected.filter((item) => item.status === 'review').length,
    missing: inspected.filter((item) => item.status === 'not-direct' || item.status === 'lock-missing').length,
    exclusivePackages: inspected.reduce((sum, item) => sum + item.closure.length, 0),
  });
  const payload = inspected.map((item) => [item.name, item.kind, item.status, item.rootPath, item.closure, item.sharedDependents]);
  return freeze({ ok: issues.length === 0, issues: freeze(issues.sort()), candidates: freeze(inspected), summary, fingerprint: hash(payload) });
};

export const diffRemovalPlans = (baseline, candidate) => {
  const map = (plan) => new Map((plan?.candidates ?? []).map((item) => [item.name, item]));
  const left = map(baseline);
  const right = map(candidate);
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  for (const name of names) {
    const before = left.get(name);
    const after = right.get(name);
    if (!before) changes.push(freeze({ name, change: 'added', before: null, after: after.status }));
    else if (!after) changes.push(freeze({ name, change: 'removed', before: before.status, after: null }));
    else if (before.status !== after.status || before.closure.length !== after.closure.length) changes.push(freeze({ name, change: 'changed', before: before.status, after: after.status }));
  }
  return freeze(changes);
};

export const renderRemovalPlan = (plan) => {
  const lines = [`Dependency removal plan ${plan.fingerprint}`, `candidates=${plan.summary.candidates} plannable=${plan.summary.plannable} review=${plan.summary.review} missing=${plan.summary.missing}`];
  for (const item of plan.candidates) {
    lines.push(`${item.name}: ${item.status} (${item.kind ?? 'unknown'}) closure=${item.closure.length} shared=${item.sharedDependents.length}`);
    for (const blocker of item.blockers) lines.push(`  blocker: ${blocker}`);
  }
  for (const issue of plan.issues) lines.push(`policy: ${issue}`);
  return `${lines.join('\n')}\n`;
};

export const runRemovalPlan = async (root = PROJECT_ROOT, candidates = []) => {
  const [manifestText, lockText] = await Promise.all([readFile(resolve(root, 'package.json'), 'utf8'), readFile(resolve(root, 'package-lock.json'), 'utf8')]);
  return buildRemovalPlan(JSON.parse(manifestText), JSON.parse(lockText), candidates);
};

const main = async () => {
  const candidates = process.argv.slice(2);
  if (!candidates.length) {
    console.log('[dependency:removal-plan] supply one or more exact direct dependency names; no mutation is performed.');
    return;
  }
  const plan = await runRemovalPlan(PROJECT_ROOT, candidates);
  process.stdout.write(renderRemovalPlan(plan));
  if (!plan.ok) process.exitCode = 1;
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) await main();
