import assert from 'node:assert/strict';
import test from 'node:test';
import { auditDotnetProjectCycles } from './dotnet-project-graph.mts';

const project = (name, references = []) => ({
  path: name + '/' + name + '.csproj',
  projectReferences: references.map(target => '../' + target + '/' + target + '.csproj'),
});
const findings = (...projects) => auditDotnetProjectCycles(projects);

test('accepts a directed acyclic project graph', () => {
  assert.deepEqual(findings(project('Api', ['Core', 'Business']), project('Core', ['Business']), project('Business', ['Toolbox']), project('Toolbox')), []);
});
test('detects a two-project circular reference', () => {
  const result = findings(project('A', ['B']), project('B', ['A']));
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'project-reference-cycle');
  assert.match(result[0].message, /A\/A\.csproj -> B\/B\.csproj -> A\/A\.csproj/);
});
test('detects a transitive cycle', () => {
  const result = findings(project('A', ['B']), project('B', ['C']), project('C', ['A']));
  assert.equal(result.length, 1);
  assert.match(result[0].message, /A\/A\.csproj -> B\/B\.csproj -> C\/C\.csproj -> A\/A\.csproj/);
});
test('detects cycles in disconnected components', () => {
  const result = findings(project('A', ['B']), project('B', ['A']), project('C', ['D']), project('D', ['C']));
  assert.equal(result.length, 2);
});
test('is stable when project inventory is permuted', () => {
  const nodes = [project('C', ['A']), project('A', ['B']), project('B', ['C'])];
  assert.deepEqual(auditDotnetProjectCycles(nodes), auditDotnetProjectCycles([...nodes].reverse()));
});
test('ignores duplicate edges without duplicating findings', () => {
  assert.equal(findings(project('A', ['B', 'B']), project('B', ['A'])).length, 1);
});
test('ignores missing edges already reported by package governance', () => {
  assert.deepEqual(findings(project('A', ['Missing']), project('B')), []);
});
test('ignores self-reference already rejected by package governance', () => {
  assert.deepEqual(findings(project('A', ['A'])), []);
});
test('normalizes Windows-style references', () => {
  const result = auditDotnetProjectCycles([
    { path: 'A/A.csproj', projectReferences: ['..\\B\\B.csproj'] },
    { path: 'B/B.csproj', projectReferences: ['..\\A\\A.csproj'] },
  ]);
  assert.equal(result.length, 1);
});
test('does not misinterpret similarly named projects', () => {
  assert.deepEqual(findings(project('Api', ['ApiCore']), project('ApiCore')), []);
});
test('keeps unrelated nodes out of cycle diagnostics', () => {
  const result = findings(project('A', ['B', 'D']), project('B', ['C']), project('C', ['B']), project('D'));
  assert.equal(result.length, 1);
  assert.doesNotMatch(result[0].message, /D\/D\.csproj/);
});
test('returns frozen, value-free diagnostics', () => {
  const result = findings(project('A', ['B']), project('B', ['A']));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
  assert.equal(result[0].package, null);
});
test('handles a deep acyclic chain without call stack exhaustion', () => {
  const count = 7000;
  const projects = Array.from({ length: count }, (_, index) => ({
    path: 'P' + index + '.csproj',
    projectReferences: index + 1 < count ? ['P' + (index + 1) + '.csproj'] : [],
  }));
  assert.deepEqual(auditDotnetProjectCycles(projects), []);
});
test('reports a deep cycle with bounded diagnostics', () => {
  const count = 7000;
  const projects = Array.from({ length: count }, (_, index) => ({
    path: 'P' + index + '.csproj',
    projectReferences: ['P' + ((index + 1) % count) + '.csproj'],
  }));
  const result = auditDotnetProjectCycles(projects);
  assert.equal(result.length, 1);
  assert.equal(result[0].code, 'project-reference-cycle');
  assert.ok(result[0].message.length < 1000);
});
