import { stableSortFindings, type AuditSection, type Finding, type RepositoryInventory } from './contracts.mts';
import { createLineIndex, snippetAround } from './inventory.mts';
import { workflowFiles, workflowTriggerProfile } from './workflow-structure.mts';

export interface WorkflowCacheSignal { readonly file: string; readonly cacheActions: number; readonly setupCaches: number; readonly restoreKeys: number; readonly untrustedKeys: number; }
export interface WorkflowCacheSummary { readonly workflows: readonly WorkflowCacheSignal[]; readonly cacheActions: number; readonly setupCaches: number; readonly restoreKeys: number; readonly untrustedKeys: number; readonly findings: readonly Finding[]; }

const CACHE_ACTION = /^\s*-\s+uses\s*:\s*actions\/(cache(?:\/restore|\/save)?)@[0-9a-f]{40}\s*(?:#.*)?$/i;
const SETUP_ACTION = /^\s*-\s+uses\s*:\s*actions\/setup-(?:node|python|java|dotnet)@[0-9a-f]{40}\s*(?:#.*)?$/i;
const CACHE_FIELD = /^\s*cache\s*:\s*(.+)$/i;
const KEY_FIELD = /^\s*key\s*:\s*(.+)$/i;
const RESTORE_KEYS_FIELD = /^\s*restore-keys\s*:\s*(.*)$/i;
const UNTRUSTED = /\$\{\{[\s\S]*?(?:github\.event\.|github\.head_ref\b|inputs\.)/i;
const MUTABLE_REF = /\$\{\{[\s\S]*?github\.(?:ref|ref_name|head_ref)\b/i;

function lines(text: string): Array<{ text: string; offset: number; line: number; indent: number }> { let offset = 0; return text.split('\n').map((text, index) => { const item = { text, offset, line: index + 1, indent: text.match(/^\s*/)?.[0].length ?? 0 }; offset += text.length + 1; return item; }); }
function blockEnd(all: ReturnType<typeof lines>, start: number, indent: number): number { for (let index = start + 1; index < all.length; index += 1) { const line = all[index]!; if (line.text.trim() && line.indent <= indent && /^\s*-\s+/.test(line.text)) return index; } return all.length; }
function finding(file: string, text: string, offset: number, id: string, severity: Finding['severity'], title: string, message: string, remediation: string): Finding { const index = createLineIndex(text); return { id, domain: 'security', severity, blocking: severity === 'critical' || severity === 'high', title, message, location: { file, line: index.lineAt(offset) }, evidence: { excerpt: snippetAround(text, offset, 180) }, remediation, tags: ['ci','workflow','cache','supply-chain'] }; }

export function auditWorkflowCacheBoundaries(inventory: RepositoryInventory): AuditSection<WorkflowCacheSummary> {
  const start = performance.now(); const findings: Finding[] = []; const workflows: WorkflowCacheSignal[] = [];
  for (const file of workflowFiles(inventory)) {
    const profile = workflowTriggerProfile(file); const all = lines(file.text); let cacheActions = 0; let setupCaches = 0; let restoreKeys = 0; let untrustedKeys = 0;
    for (let index = 0; index < all.length; index += 1) {
      const line = all[index]!; const isCache = CACHE_ACTION.test(line.text); const isSetup = SETUP_ACTION.test(line.text); if (!isCache && !isSetup) continue;
      const end = blockEnd(all, index, line.indent); const block = all.slice(index, end); const key = block.find(item => KEY_FIELD.test(item.text)); const restore = block.find(item => RESTORE_KEYS_FIELD.test(item.text)); const cache = block.find(item => CACHE_FIELD.test(item.text));
      if (isCache) cacheActions += 1; if (isSetup && cache) setupCaches += 1; if (restore) restoreKeys += 1;
      if (key && (UNTRUSTED.test(key.text) || MUTABLE_REF.test(key.text))) { untrustedKeys += 1; findings.push(finding(file.repositoryPath, file.text, key.offset, 'ci-cache-untrusted-key', 'high', 'Workflow cache key includes mutable or attacker-controlled context', 'Cache namespaces derived from pull-request/event text or mutable refs can let less-trusted executions influence later cache restoration.', 'Derive cache keys only from reviewed runner facts, lockfile/content hashes and immutable dependency inputs.')); }
      if (profile.externalContribution && restore) findings.push(finding(file.repositoryPath, file.text, restore.offset, 'ci-cache-broad-restore-on-external-trigger', 'high', 'External-contribution workflow uses cache restore prefixes', 'Prefix restore keys widen the set of cache objects accepted by a workflow that executes untrusted contribution code.', 'Remove restore-keys for external-contribution jobs or isolate caches by immutable trust domain and content hash.'));
      if (profile.pullRequestTarget && (isCache || (isSetup && cache))) findings.push(finding(file.repositoryPath, file.text, line.offset, 'ci-cache-privileged-trigger', 'critical', 'Privileged pull_request_target workflow restores dependency cache', 'A privileged trigger must not consume cache state that can be influenced by lower-trust pull-request executions.', 'Disable dependency caching on pull_request_target or prove a dedicated immutable cache namespace that untrusted workflows cannot write.'));
    }
    workflows.push({ file: file.repositoryPath, cacheActions, setupCaches, restoreKeys, untrustedKeys });
  }
  const sorted = stableSortFindings(findings); return { domain: 'security', title: 'Workflow cache trust-boundary audit', summary: { workflows, cacheActions: workflows.reduce((n,x)=>n+x.cacheActions,0), setupCaches: workflows.reduce((n,x)=>n+x.setupCaches,0), restoreKeys: workflows.reduce((n,x)=>n+x.restoreKeys,0), untrustedKeys: workflows.reduce((n,x)=>n+x.untrustedKeys,0), findings: sorted }, findings: sorted, elapsedMs: Math.max(0, performance.now()-start) };
}
