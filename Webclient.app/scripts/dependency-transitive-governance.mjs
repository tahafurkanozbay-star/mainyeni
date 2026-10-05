#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageNameFromLockPath } from './dependency-lock-graph.mjs';
import { runTransitivePolicy } from './dependency-transitive-policy.mjs';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(CURRENT_FILE), '..');
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_REASON = 240;
const MAX_PEER_EXCEPTIONS = 16;

const text = (value) => typeof value === 'string' ? value.trim() : '';
const freeze = (value) => Object.freeze(value);
const keyOf = ({ package: packageName, peer, range }) => `${packageName}\0${peer}\0${range}`;
const edgeKey = (edge) => `${packageNameFromLockPath(edge.from)}\0${edge.name}\0${edge.range}`;

export const validatePeerExceptions = (policy, today = new Date().toISOString().slice(0, 10)) => {
  const issues = [];
  const entries = Array.isArray(policy?.peerExceptions) ? policy.peerExceptions : [];
  if (entries.length > MAX_PEER_EXCEPTIONS) issues.push(`peer exception count ${entries.length} exceeds hard budget ${MAX_PEER_EXCEPTIONS}`);
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const prefix = `peerExceptions[${index}]`;
    const packageName = text(entry?.package);
    const peer = text(entry?.peer);
    const range = text(entry?.range);
    const owner = text(entry?.owner);
    const reason = text(entry?.reason);
    const expiresOn = text(entry?.expiresOn);
    if (!packageName || !peer || !range) issues.push(`${prefix}: package, peer and exact range are required`);
    if (!owner || owner.length > 80) issues.push(`${prefix}: bounded owner is required`);
    if (reason.length < 20 || reason.length > MAX_REASON) issues.push(`${prefix}: reason must contain 20-${MAX_REASON} characters`);
    if (!DATE_ONLY.test(expiresOn)) issues.push(`${prefix}: expiresOn must be YYYY-MM-DD`);
    else if (expiresOn < today) issues.push(`${prefix}: exception expired on ${expiresOn}`);
    const key = keyOf({ package: packageName, peer, range });
    if (seen.has(key)) issues.push(`${prefix}: duplicate peer exception ${packageName} -> ${peer}@${range}`);
    seen.add(key);
  }
  return freeze(issues.sort());
};

export const applyPeerExceptions = (result, policy, today) => {
  // validatePeerExceptions intentionally returns a frozen diagnostic snapshot. Keep
  // that public immutability contract intact and use a private mutable accumulator
  // for graph-dependent stale/unnecessary findings discovered below.
  const policyIssues = [...validatePeerExceptions(policy, today)];
  const exceptions = new Map((policy?.peerExceptions ?? []).map((entry) => [keyOf(entry), entry]));
  const peerEdges = new Map((result?.inventory?.peerEdges ?? []).map((edge) => [edgeKey(edge), edge]));
  const used = new Set();
  const remaining = [];

  for (const finding of result?.issues ?? []) {
    if (finding.code !== 'peer-range' && finding.code !== 'peer-mismatch' && finding.code !== 'peer-unresolved') {
      remaining.push(finding);
      continue;
    }
    const candidateEdges = [...peerEdges.values()].filter((edge) => edge.from === finding.path);
    const matched = candidateEdges.find((edge) => exceptions.has(edgeKey(edge)));
    if (!matched) {
      remaining.push(finding);
      continue;
    }
    used.add(edgeKey(matched));
  }

  for (const [key, entry] of exceptions) {
    if (!peerEdges.has(key)) policyIssues.push(`stale peer exception ${entry.package} -> ${entry.peer}@${entry.range}`);
    else if (!used.has(key)) policyIssues.push(`unnecessary peer exception ${entry.package} -> ${entry.peer}@${entry.range}`);
  }

  const governanceIssues = freeze(policyIssues.sort().map((detail) => freeze({ code: 'peer-exception-policy', path: '<policy>', detail, severity: 'error' })));
  const issues = freeze([...remaining, ...governanceIssues].sort((a, b) => `${a.code}\0${a.path}\0${a.detail}`.localeCompare(`${b.code}\0${b.path}\0${b.detail}`)));
  return freeze({ ...result, ok: issues.length === 0, issues, peerExceptionCount: exceptions.size, usedPeerExceptions: used.size });
};

export const runTransitiveGovernance = async (root = PROJECT_ROOT) => {
  const [result, policy] = await Promise.all([
    runTransitivePolicy(root),
    readFile(resolve(root, 'scripts', 'dependency-policy.json'), 'utf8').then(JSON.parse),
  ]);
  return applyPeerExceptions(result, policy);
};

const main = async () => {
  const result = await runTransitiveGovernance();
  const { summary } = result.inventory;
  console.log(`[dependency:transitive] reachable=${summary.reachable}, peers=${summary.peerEdges}, install-script=${summary.installScripts}, deprecated=${summary.deprecated}, peer-exceptions=${result.usedPeerExceptions}/${result.peerExceptionCount}`);
  console.log(`[dependency:transitive] fingerprint=${result.inventory.fingerprint}`);
  if (!result.ok) {
    console.error('[dependency:transitive] Governance failed:');
    for (const finding of result.issues) console.error(`  - [${finding.code}] ${finding.path}: ${finding.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log('[dependency:transitive] Peer resolution, lifecycle/deprecation budgets and time-bounded legacy exceptions are consistent.');
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) await main();
