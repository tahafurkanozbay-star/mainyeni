#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditDotnetProjectCycles } from './dotnet-project-graph.mts';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(CURRENT_FILE), '..');
const CENTRAL_FILE = 'Directory.Packages.props';
const EXCLUDED_DIRECTORIES = new Set(['.git','.idea','.vs','.vscode','artifacts','bin','build','coverage','dist','node_modules','obj']);
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STABLE_VERSION = /^\d+(?:\.\d+){1,3}$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const lower = value => String(value ?? '').trim().toLowerCase();
const normalizePath = value => value.split(path.sep).join('/');
const freeze = Object.freeze;

export const decodeXmlAttribute = value => String(value ?? '')
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&amp;', '&');

export const parseAttributes = source => {
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of String(source ?? '').matchAll(pattern)) {
    const name = match[1];
    if (Object.keys(attributes).some(key => lower(key) === lower(name))) throw new Error('duplicate XML attribute ' + name);
    attributes[name] = decodeXmlAttribute(match[2] ?? match[3] ?? '');
  }
  return freeze(attributes);
};

// Mask ignored XML regions instead of deleting them: offsets remain valid with Unicode.
const stripComments = source => String(source ?? '')
  .replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, match => match.replace(/[^\r\n]/g, ' '));

// MSBuild projects may mix self-closing and paired PackageReference elements.
// A paired-element regex can accidentally treat a preceding <PackageReference />
// as the opening tag for a later </PackageReference>, double-counting packages.
// Scan quote-aware start tags instead; quoted '>' must not terminate attributes.
export const extractElements = (xml, tagName) => {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(String(tagName))) throw new Error('invalid XML element name');
  const source = stripComments(xml);
  const opening = new RegExp('<' + tagName + '(?=[\\s/>])', 'gi');
  const closing = new RegExp('</' + tagName + '\\s*>', 'gi');
  const result = [];
  let cursor = 0;
  while (cursor < source.length) {
    opening.lastIndex = cursor;
    const start = opening.exec(source);
    if (!start) break;
    const index = start.index;
    let quote = null;
    let end = opening.lastIndex;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end >= source.length) throw new Error('unterminated XML start tag ' + tagName);
    const rawAttributes = source.slice(index + needle.length, end).trimEnd();
    const selfClosing = rawAttributes.endsWith('/');
    const attributes = parseAttributes(selfClosing ? rawAttributes.slice(0, -1) : rawAttributes);
    if (selfClosing) {
      result.push(freeze({ attributes, body: '', index }));
      cursor = end + 1;
      continue;
    }
    closing.lastIndex = end + 1;
    const match = closing.exec(source);
    if (!match) throw new Error('missing closing XML tag ' + tagName);
    result.push(freeze({ attributes, body: source.slice(end + 1, match.index), index }));
    cursor = closing.lastIndex;
  }
  return freeze(result);
};
export const extractPropertyValues = (xml, propertyName) => {
  const source = stripComments(xml);
  const escaped = String(propertyName);
  const pattern = new RegExp('<' + escaped + '\\b[^>]*>([\\s\\S]*?)<\\/' + escaped + '\\s*>', 'gi');
  return freeze([...source.matchAll(pattern)].map(match => String(match[1] ?? '').trim()).filter(Boolean));
};

export const normalizePackageId = value => {
  const id = String(value ?? '').trim();
  return PACKAGE_ID.test(id) ? id : null;
};

export const isConcreteStableVersion = value => STABLE_VERSION.test(String(value ?? '').trim());

const hasAttribute = (attributes, name) => Object.keys(attributes).some(key => lower(key) === lower(name));
const attributeValue = (attributes, name) => attributes[Object.keys(attributes).find(key => lower(key) === lower(name))];

const actionFromAttributes = attributes => {
  for (const action of ['Include','Update','Remove']) if (hasAttribute(attributes, action)) return freeze({ action, value: attributeValue(attributes, action) });
  return freeze({ action: null, value: null });
};

const readChildVersion = body => {
  const values = extractPropertyValues(body, 'Version');
  if (values.length === 0) return freeze({ error: null, value: null });
  if (values.length > 1) return freeze({ error: 'multiple', value: null });
  return freeze({ error: null, value: values[0] });
};

const finding = (code, file, message, packageId = null, severity = 'error') => freeze({ code, severity, file, package: packageId, message });

export const parseCentralPackageCatalog = (xml, file = CENTRAL_FILE) => {
  const findings = [];
  // Fail closed on missing, empty, duplicated, conditioned or redefined policy.
  const groups = extractElements(xml, 'PropertyGroup');
  for (const [property, expected, code] of [
    ['ManagePackageVersionsCentrally', 'true', 'central-management-disabled'],
    ['CentralPackageVersionOverrideEnabled', 'false', 'central-version-override-enabled'],
  ]) {
    const declarations = extractElements(xml, property);
    const conditionedParent = groups.some(group =>
      hasAttribute(group.attributes, 'Condition') && extractElements(group.body, property).length > 0);
    if (declarations.length !== 1 || lower(declarations[0].body) !== expected ||
        Object.keys(declarations[0].attributes).length > 0 || conditionedParent) {
      findings.push(finding(code, file, property + ' must be declared exactly once, unconditionally, with value ' + expected + '.'));
    }
  }
  const entries = [];
  const seen = new Map();
  for (const element of extractElements(xml, 'PackageVersion')) {
    const { action, value } = actionFromAttributes(element.attributes);
    if (action !== 'Include' && action !== 'Update') { findings.push(finding('central-package-action-invalid', file, 'PackageVersion must use Include or Update.')); continue; }
    const id = normalizePackageId(value);
    if (!id) { findings.push(finding('central-package-id-invalid', file, 'PackageVersion contains an invalid package id.', String(value ?? ''))); continue; }
    const attributeVersion = attributeValue(element.attributes, 'Version')?.trim() || null;
    const child = readChildVersion(element.body);
    const childVersion = child.value;
    if (child.error) findings.push(finding('central-version-multiple', file, 'PackageVersion declares more than one child Version element.', id));
    if (hasAttribute(element.attributes, 'Version') && extractElements(element.body, 'Version').length > 0) findings.push(finding('central-version-ambiguous', file, 'PackageVersion must not declare both Version attribute and child Version.', id));
    const version = attributeVersion ?? childVersion;
    if (!version) findings.push(finding('central-version-missing', file, 'PackageVersion requires an explicit version.', id));
    else if (!isConcreteStableVersion(version)) findings.push(finding('central-version-nonrelease', file, 'Central version must be a concrete stable release: ' + version, id));
    const key = lower(id);
    if (seen.has(key)) findings.push(finding('central-package-duplicate', file, 'Central package id is declared more than once; first declaration uses ' + seen.get(key) + '.', id));
    else seen.set(key, id);
    entries.push(freeze({ id, normalizedId: key, version: version ?? null, action }));
  }
  return freeze({ entries: freeze(entries), findings: freeze(findings) });
};

export const parseProjectFile = (xml, file) => {
  const findings = [];
  const packageReferences = [];
  const projectReferences = [];
  for (const property of ['ManagePackageVersionsCentrally', 'CentralPackageVersionOverrideEnabled']) {
    if (extractElements(xml, property).length > 0) {
      findings.push(finding('project-central-policy-override', file, property + ' must be owned by Directory.Packages.props.'));
    }
  }
  for (const element of extractElements(xml, 'PackageReference')) {
    const { action, value } = actionFromAttributes(element.attributes);
    // Remove and Update must not smuggle an override into another evaluation phase.
    if (hasAttribute(element.attributes, 'VersionOverride') ||
        extractElements(element.body, 'VersionOverride').length > 0) {
      findings.push(finding('package-reference-version-override', file, 'VersionOverride bypasses central package governance and is not allowed.', String(value ?? '')));
    }
    if (action === 'Remove') continue;
    if (action !== 'Include' && action !== 'Update') { findings.push(finding('package-reference-action-invalid', file, 'PackageReference must use Include, Update, or Remove.')); continue; }
    const id = normalizePackageId(value);
    if (!id) { findings.push(finding('package-reference-id-invalid', file, 'PackageReference contains an invalid package id.', String(value ?? ''))); continue; }
    const child = readChildVersion(element.body);
    if (child.error) findings.push(finding('package-reference-version-multiple', file, 'PackageReference declares more than one child Version element.', id));
    if (hasAttribute(element.attributes, 'Version') || extractElements(element.body, 'Version').length > 0) {
      findings.push(finding('package-reference-inline-version', file, 'PackageReference versions must be owned by Directory.Packages.props.', id));
    }
    packageReferences.push(freeze({ id, normalizedId: lower(id), action, condition: element.attributes.Condition?.trim() || null }));
  }
  for (const element of extractElements(xml, 'ProjectReference')) {
    const { action, value } = actionFromAttributes(element.attributes);
    if (action === 'Remove') continue;
    if (action !== 'Include' || !String(value ?? '').trim()) { findings.push(finding('project-reference-invalid', file, 'ProjectReference requires a non-empty Include path.')); continue; }
    projectReferences.push(freeze({ path: String(value).trim().replace(/\\/g,'/'), condition: element.attributes.Condition?.trim() || null }));
  }
  return freeze({ packageReferences: freeze(packageReferences), projectReferences: freeze(projectReferences), findings: freeze(findings) });
};

const findingOrder = (a,b) => a.severity.localeCompare(b.severity) || a.code.localeCompare(b.code) || String(a.file).localeCompare(String(b.file)) || String(a.package ?? '').localeCompare(String(b.package ?? '')) || a.message.localeCompare(b.message);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const evaluateDotnetPackageGovernance = ({ centralXml, projects, centralFile = CENTRAL_FILE }) => {
  const central = parseCentralPackageCatalog(centralXml, centralFile);
  const findings = [...central.findings];
  const centralById = new Map();
  for (const entry of central.entries) if (!centralById.has(entry.normalizedId)) centralById.set(entry.normalizedId, entry);
  const usage = new Map();
  const projectInventory = [];
  for (const project of [...projects].sort((a,b)=>a.path.localeCompare(b.path))) {
    const parsed = parseProjectFile(project.xml, project.path);
    findings.push(...parsed.findings);
    const seen = new Set();
    for (const reference of parsed.packageReferences) {
      if (reference.action === 'Update') continue;
      if (!centralById.has(reference.normalizedId)) findings.push(finding('package-reference-central-version-missing', project.path, 'PackageReference has no matching PackageVersion in Directory.Packages.props.', reference.id));
      if (seen.has(reference.normalizedId)) findings.push(finding('package-reference-duplicate', project.path, 'Project declares the same package more than once.', reference.id));
      else seen.add(reference.normalizedId);
      const files = usage.get(reference.normalizedId) ?? new Set(); files.add(project.path); usage.set(reference.normalizedId, files);
    }
    projectInventory.push(freeze({ path: project.path, packages: freeze(parsed.packageReferences.filter(x=>x.action==='Include').map(x=>x.id).sort()), projectReferences: freeze(parsed.projectReferences.map(x=>x.path).sort()) }));
  }
  for (const entry of central.entries) if (!usage.has(entry.normalizedId)) findings.push(finding('central-package-unused', centralFile, 'Central PackageVersion is stale because no project references the package.', entry.id));
  const projectPaths = new Set(projects.map(project=>normalizePath(project.path)));
  for (const project of projectInventory) {
    const directory = path.posix.dirname(normalizePath(project.path));
    for (const reference of project.projectReferences) {
      const target = path.posix.normalize(path.posix.join(directory, reference));
      if (target.startsWith('../') || target === '..') { findings.push(finding('project-reference-outside-repository', project.path, 'ProjectReference escapes repository root: ' + reference)); continue; }
      if (!projectPaths.has(target)) findings.push(finding('project-reference-target-missing', project.path, 'ProjectReference target does not exist in inventory: ' + reference));
      if (target === normalizePath(project.path)) findings.push(finding('project-reference-self', project.path, 'Project must not reference itself.'));
    }
  }
  // Detect transitive project reference cycles beyond individual edge validation.
  findings.push(...auditDotnetProjectCycles(projectInventory));
  const stableFindings = freeze(findings.sort(findingOrder));
  const catalog = freeze(central.entries.map(entry=>freeze({id:entry.id,version:entry.version})).sort((a,b)=>a.id.localeCompare(b.id)));
  const usedPackages = freeze([...usage.entries()].map(([id,files])=>freeze({id:centralById.get(id)?.id ?? id,projects:freeze([...files].sort())})).sort((a,b)=>a.id.localeCompare(b.id)));
  const inventory = freeze(projectInventory.sort((a,b)=>a.path.localeCompare(b.path)));
  const summary = freeze({ projects:inventory.length, centralPackages:catalog.length, referencedPackages:usedPackages.length, errors:stableFindings.filter(x=>x.severity==='error').length, warnings:stableFindings.filter(x=>x.severity==='warning').length });
  return freeze({ ok:summary.errors===0, summary, catalog, usage:usedPackages, projects:inventory, findings:stableFindings, fingerprint:hash([catalog,usedPackages,inventory]) });
};

const walkProjects = async (root, directory = root, result = []) => {
  for (const entry of await readdir(directory, { withFileTypes:true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkProjects(root, absolute, result);
    else if (entry.isFile() && entry.name.endsWith('.csproj')) result.push(absolute);
  }
  return result;
};

export const loadDotnetPackageInventory = async (root = REPOSITORY_ROOT) => {
  const resolved = path.resolve(root);
  const centralXml = await readFile(path.join(resolved, CENTRAL_FILE), 'utf8');
  const paths = await walkProjects(resolved);
  const projects = [];
  for (const projectPath of paths.sort()) projects.push(freeze({ path: normalizePath(path.relative(resolved, projectPath)), xml: await readFile(projectPath, 'utf8') }));
  return freeze({ centralXml, projects });
};

const escapeMd = value => String(value ?? '').replaceAll('|','\\|').replaceAll('\n',' ');
export const renderDotnetPackageGovernanceMarkdown = report => {
  const findingRows = report.findings.length ? report.findings.map(item=>'| '+item.severity+' | '+item.code+' | '+escapeMd(item.file)+' | '+escapeMd(item.package)+' | '+escapeMd(item.message)+' |').join('\n') : '| _none_ | | | | |';
  const catalogRows = report.catalog.length ? report.catalog.map(item=>'| '+escapeMd(item.id)+' | '+escapeMd(item.version)+' | '+(report.usage.find(use=>lower(use.id)===lower(item.id))?.projects.length ?? 0)+' |').join('\n') : '| _none_ | | |';
  return [
    '# .NET Package Governance',
    '',
    '- Gate: **'+(report.ok?'PASS':'FAIL')+'**',
    '- Fingerprint: `'+report.fingerprint+'`',
    '- Projects: **'+report.summary.projects+'**',
    '- Central packages: **'+report.summary.centralPackages+'**',
    '- Referenced packages: **'+report.summary.referencedPackages+'**',
    '- Errors: **'+report.summary.errors+'**',
    '- Warnings: **'+report.summary.warnings+'**',
    '',
    '## Findings',
    '',
    '| Severity | Code | File | Package | Message |',
    '| --- | --- | --- | --- | --- |',
    findingRows,
    '',
    '## Central catalog',
    '',
    '| Package | Version | Referencing projects |',
    '| --- | --- | ---: |',
    catalogRows,
    '',
  ].join('\n');
};

export const runDotnetPackageGovernance = async (root = REPOSITORY_ROOT) => evaluateDotnetPackageGovernance(await loadDotnetPackageInventory(root));

const main = async () => {
  const report = await runDotnetPackageGovernance();
  const out = path.join(REPOSITORY_ROOT,'artifacts','platform-audit');
  await mkdir(out,{recursive:true});
  await Promise.all([
    writeFile(path.join(out,'dotnet-package-governance.json'),JSON.stringify(report,null,2)+'\n','utf8'),
    writeFile(path.join(out,'dotnet-package-governance.md'),renderDotnetPackageGovernanceMarkdown(report),'utf8'),
  ]);
  console.log(JSON.stringify(report.summary,null,2));
  if (!report.ok) process.exitCode=2;
};

if (import.meta.url === 'file://' + process.argv[1]) main().catch(error=>{ console.error(error); process.exitCode=1; });
