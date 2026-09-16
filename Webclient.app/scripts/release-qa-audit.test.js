'use strict';

const audit = require('./release-qa-audit');

describe('release QA audit', () => {
  test('detects privileged client keys', () => {
    const findings = audit.scanFile('/tmp/example.js', 'const key = process.env.REACT_APP_CLIENT_KEY;');
    expect(findings.some(item => item.id === 'secret-client-key' && item.severity === 'critical')).toBe(true);
  });

  test('detects dynamic code execution', () => {
    const findings = audit.scanFile('/tmp/example.js', 'const result = eval(userInput);');
    expect(findings.some(item => item.id === 'unsafe-eval')).toBe(true);
  });

  test('detects unsafe html sinks', () => {
    const findings = audit.scanFile('/tmp/example.js', 'node.innerHTML = response;');
    expect(findings.some(item => item.id === 'unsafe-html')).toBe(true);
  });

  test('detects forbidden WMS/WFS references', () => {
    const findings = audit.scanFile('/tmp/example.js', 'const service = "WFS";');
    expect(findings.some(item => item.id === 'wms-wfs')).toBe(true);
  });

  test('detects plain HTTP endpoints', () => {
    const findings = audit.scanFile('/tmp/example.js', 'fetch("http://example.test/service")');
    expect(findings.some(item => item.id === 'insecure-protocol')).toBe(true);
  });

  test('reports line numbers deterministically', () => {
    const findings = audit.scanFile('/tmp/example.js', 'const safe = true;\n\nwindow.open(url);');
    const finding = findings.find(item => item.id === 'window-open');
    expect(finding.line).toBe(3);
  });

  test('deduplicates exact findings', () => {
    const finding = { id: 'x', severity: 'high', file: 'x.js', line: 1, evidence: 'x' };
    expect(audit.dedupe([finding, { ...finding }])).toHaveLength(1);
  });

  test('keeps distinct lines during dedupe', () => {
    const first = { id: 'x', severity: 'high', file: 'x.js', line: 1, evidence: 'x' };
    const second = { ...first, line: 2 };
    expect(audit.dedupe([first, second])).toHaveLength(2);
  });

  test('blocks release when critical findings exist', () => {
    const summary = audit.summarize([{ severity: 'critical' }], ['a.js']);
    expect(summary.releaseGate).toBe('block');
    expect(summary.riskScore).toBe(100);
  });

  test('requires review for high findings without critical findings', () => {
    const summary = audit.summarize([{ severity: 'high' }], ['a.js']);
    expect(summary.releaseGate).toBe('review');
  });

  test('passes static gate when high and critical findings are absent', () => {
    const summary = audit.summarize([{ severity: 'medium' }], ['a.js']);
    expect(summary.releaseGate).toBe('pass');
  });

  test('counts all severities', () => {
    const summary = audit.summarize(['critical', 'high', 'medium', 'low', 'info'].map(severity => ({ severity })), ['a.js']);
    expect(summary.counts).toEqual({ critical: 1, high: 1, medium: 1, low: 1, info: 1 });
  });

  test('renders markdown release status', () => {
    const text = audit.markdown({ summary: { filesScanned: 1, findings: 0, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, riskScore: 0, releaseGate: 'pass' }, findings: [] });
    expect(text).toContain('Release gate: **PASS**');
    expect(text).toContain('No static release findings.');
  });

  test('renders finding locations and evidence', () => {
    const text = audit.markdown({ summary: { filesScanned: 1, findings: 1, counts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 }, riskScore: 40, releaseGate: 'review' }, findings: [{ severity: 'high', id: 'unsafe-html', file: 'src/a.js', line: 7, message: 'unsafe', evidence: '<html>' }] });
    expect(text).toContain('src/a.js:7');
    expect(text).toContain('unsafe-html');
  });

  test('audit rule identifiers are unique', () => {
    const ids = audit.rules.map(rule => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every audit rule has a recognized severity', () => {
    const valid = new Set(['critical', 'high', 'medium', 'low', 'info']);
    expect(audit.rules.every(rule => valid.has(rule.severity))).toBe(true);
  });
});
