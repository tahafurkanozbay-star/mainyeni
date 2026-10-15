import assert from 'node:assert/strict';
import test from 'node:test';
import { maskNetworkReferenceComments } from './network-url-lexical.mts';
import { auditNetwork } from './network-audit.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/features/network.ts';
const admin = 'Webclient.admin/src/features/network.ts';
function audit(text: string, path = app, kind: 'typescript' | 'css' = 'typescript') {
  return auditNetwork(fixtureInventory([{ path, text, kind }]));
}
test('comment-only plain HTTP does not represent a real runtime transport', () => {
  const result = audit('// http://obsolete.example.test/service');
  assert.equal(result.summary.references.length, 0);
  assert.equal(result.summary.insecureCount, 0);
});
test('block comments never become remote assets', () => {
  const result = audit('/* https://cdn.example.test/image.svg */');
  assert.equal(result.summary.references.length, 0);
});
test('real quoted insecure URL remains a release finding', () => {
  const result = audit('const service = "http://example.test/route";');
  assert.equal(result.summary.insecureCount, 1);
  assert.ok(result.findings.some(x => x.id === 'network-insecure-http'));
});
test('a secure URL after a line comment remains visible', () => {
  const result = audit('// http://obsolete.example.test\nconst service = "https://api.example.test/route";');
  assert.equal(result.summary.references.length, 1);
  assert.equal(result.summary.insecureCount, 0);
});
test('mixed block comments cannot hide adjacent executable URLs', () => {
  const result = audit('/* http://obsolete.test */ const a = "http://live.test"; /* http://old.test */');
  assert.equal(result.summary.references.length, 1);
  assert.equal(result.summary.insecureCount, 1);
});
test('comments in Admin runtime files are excluded with the same policy', () => {
  const result = audit('// http://obsolete.test\nconst asset = "https://cdn.test/icon.svg";', admin);
  assert.equal(result.summary.references.length, 1);
});
test('URL schemes inside quoted strings never start comments', () => {
  const text = 'const refs = ["http://one.test", "https://two.test"];';
  const mask = maskNetworkReferenceComments(text);
  assert.equal(mask, text);
  assert.equal(audit(text).summary.references.length, 2);
});
test('URLs inside template text remain visible for network policy review', () => {
  const text = 'const url = ' + '\x60https://tiles.test/service\x60;';
  assert.equal(audit(text).summary.references.length, 1);
});
test('a comment in a template interpolation is removed', () => {
  const text = 'const url = ' + '\x60prefix https://live.test\x60;';
  const result = audit(text);
  assert.equal(result.summary.references.length, 1);
  assert.equal(result.summary.insecureCount, 0);
});
test('unquoted CSS URL syntax does not misclassify scheme separators', () => {
  const text = '.icon { background: url(https://cdn.example.test/icon.svg); }';
  const result = audit(text, 'Webclient.app/src/panel.css', 'css');
  assert.equal(result.summary.references.length, 1);
});
test('plain HTTP unquoted CSS URL remains high-risk', () => {
  const text = '.icon { background: url(http://cdn.example.test/icon.svg); }';
  const result = audit(text, 'Webclient.app/src/panel.css', 'css');
  assert.equal(result.summary.insecureCount, 1);
});
test('CSS block comments never create network findings', () => {
  const text = '/* @import url("https://fonts.googleapis.com/css?family=Example"); */';
  const result = audit(text, 'Webclient.app/src/theme.css', 'css');
  assert.equal(result.summary.references.length, 0);
});
test('actual CSS @import remains a remote font dependency', () => {
  const text = '@import url("https://fonts.googleapis.com/css?family=Example");';
  const result = audit(text, 'Webclient.app/src/theme.css', 'css');
  assert.ok(result.findings.some(x => x.id === 'network-remote-font'));
});
test('escaped string delimiters cannot expose fake comment markers', () => {
  const text = 'const line = "quoted \\" // http://live.test";';
  assert.equal(maskNetworkReferenceComments(text), text);
  assert.equal(audit(text).summary.references.length, 1);
});
test('comment masks preserve UTF-16 offsets and newline positions', () => {
  const source = 'const emoji = "😀";\n// http://fake.test\nconst path = "https://live.test";';
  const mask = maskNetworkReferenceComments(source);
  assert.equal(mask.length, source.length);
  assert.equal(mask.split('\n').length, 3);
  assert.equal(mask.indexOf('https://live.test'), source.indexOf('https://live.test'));
});
test('unterminated comments do not cause unbounded scanning', () => {
  const text = 'const url = "https://good.test"; /* http://fake.test ' + 'f'.repeat(10000);
  const result = audit(text);
  assert.equal(result.summary.references.length, 1);
});
test('unknown URLs inside comments do not inflate host counts', () => {
  const result = audit('// http://unknown.example.test\nconst url = "https://service.example.test";');
  assert.ok(!result.summary.hosts.includes('unknown.example.test'));
  assert.ok(result.summary.hosts.includes('service.example.test'));
});
test('a comment after a real URL leaves its finding unchanged', () => {
  const result = audit('const url="http://live.test"; // http://old.test');
  assert.equal(result.summary.insecureCount, 1);
});
test('network call counts remain tied to the separate executable lexer', () => {
  const result = audit('// fetch("http://old.test")\nconst load = () => fetch("/api/path");');
  assert.equal(result.summary.directFetchCalls, 1);
  assert.equal(result.summary.insecureCount, 0);
});
