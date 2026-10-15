import assert from 'node:assert/strict';
import test from 'node:test';
import { auditNetwork } from './network-audit.mts';
import { maskNonExecutableNetworkText } from './network-lexical.mts';
import { fixtureInventory } from './test-helpers.mts';

const app = 'Webclient.app/src/features/network/request.ts';
const admin = 'Webclient.admin/src/features/search/request.ts';

function inspect(source: string, path = app) {
  return auditNetwork(fixtureInventory([{ path, text: source }]));
}

test('executable mask keeps offsets, newlines, and valid fetch calls', () => {
  const source = [
    'const documentation = "fetch(' + "'/string'" + ')";',
    '// fetch("/comment")',
    '/* fetch("/block") */',
    "const result = fetch('/live');",
  ].join('\n');
  const masked = maskNonExecutableNetworkText(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.ok(masked.includes("fetch("));
  assert.ok(!masked.includes('/string'));
  assert.ok(!masked.includes('/comment'));
  assert.ok(!masked.includes('/block'));
  assert.equal(inspect(source).summary.directFetchCalls, 1);
});

test('comments and quoted examples never count as runtime network calls', () => {
  const source = [
    '// fetch("/comment")',
    "/* fetch('/block') and axios.get('/not-real') */",
    'const tutorial = "fetch(' + "'/quoted'" + ')";',
    "const hint = 'XMLHttpRequest axios.get fetch( QueryTask';",
    'const plain = `fetch("/template-literal")`;',
  ].join('\n');
  const section = inspect(source, admin);
  assert.equal(section.summary.calls.length, 0);
  assert.equal(section.summary.directFetchCalls, 0);
  assert.equal(section.summary.absoluteFetchCalls, 0);
  assert.ok(!section.findings.some(item => item.id === 'network-direct-fetch-outside-transport'));
});

test('ordinary live code and template interpolations remain audited', () => {
  const source = [
    "const first = fetch('/direct');",
    'const second = `text ${fetch("/interpolated")}`;',
    'const third = `nested ${`inner ${fetch("/nested")}`}`;',
    "const fourth = axios.post('/api', { count: 3 });",
  ].join('\n');
  const section = inspect(source);
  assert.equal(section.summary.directFetchCalls, 3);
  assert.equal(section.summary.calls.filter(call => call.kind === 'fetch').length, 3);
  assert.equal(section.summary.calls.filter(call => call.kind === 'axios.post').length, 1);
  assert.equal(section.findings.filter(item => item.id === 'network-direct-fetch-outside-transport').length, 3);
});

test('absolute browser fetch counts only executable network requests', () => {
  const source = [
    "const example = \"fetch('https://example.test/test')\";",
    "// fetch('https://example.test/ignore')",
    "const one = fetch('https://example.test/live');",
    "const two = fetch('/relative');",
    "const three = `template ${fetch('https://example.test/in-template')}`;",
  ].join('\n');
  const section = inspect(source);
  assert.equal(section.summary.directFetchCalls, 3);
  assert.equal(section.summary.absoluteFetchCalls, 2);
  assert.ok(section.findings.some(item => item.id === 'network-absolute-fetch-summary'));
});

test('line number evidence remains aligned after comments and multiline strings', () => {
  const source = [
    '// fake fetch("/a")',
    '/*',
    '  fetch("/b")',
    '*/',
    "const live = fetch('/c');",
  ].join('\n');
  const section = inspect(source);
  const direct = section.findings.filter(item => item.id === 'network-direct-fetch-outside-transport');
  assert.equal(direct.length, 1);
  assert.equal(direct[0]?.location?.line, 5);
  assert.equal(section.summary.calls.find(call => call.kind === 'fetch')?.line, 5);
});

test('shared platform transport remains excluded from direct-fetch findings', () => {
  const section = inspect(
    "const response = fetch('/api'); // fetch('/fake')",
    'Webclient.admin/src/platform/http/client.ts',
  );
  assert.equal(section.summary.directFetchCalls, 1);
  assert.equal(section.findings.filter(item => item.id === 'network-direct-fetch-outside-transport').length, 0);
});

test('unclosed comments and unterminated strings never manufacture calls', () => {
  for (const source of [
    "const message = 'fetch(/fake)",
    '/* fetch("/comment")',
    "// fetch('/comment')",
    'const example = `fetch("/text")',
  ]) {
    const section = inspect(source);
    assert.equal(section.summary.directFetchCalls, 0, source);
    assert.equal(section.summary.calls.length, 0, source);
  }
});

test('literals with escaped quotes and nested object braces preserve real interpolation', () => {
  const source = [
    'const quoted = "not \\"fetch(/example)\\"";',
    'const message = `prefix ${JSON.stringify({ nested: { data: fetch("/real") } })}`;',
  ].join('\n');
  const section = inspect(source, admin);
  assert.equal(section.summary.directFetchCalls, 1);
  assert.equal(section.findings.filter(item => item.id === 'network-direct-fetch-outside-transport').length, 1);
});

test('repeated examples cannot exhaust the real per-file finding allowance', () => {
  const source = [
    ...Array.from({ length: 20 }, (_, index) => "// fetch('/comment-" + index + "')"),
    "const actual = fetch('/real');",
  ].join('\n');
  const section = inspect(source);
  assert.equal(section.summary.directFetchCalls, 1);
  assert.equal(section.findings.filter(item => item.id === 'network-direct-fetch-outside-transport').length, 1);
});
