import { describe, expect, it } from 'vitest';
import {
  evaluateUrlBoundary,
  isLocalNetworkHostname,
  normalizeUrlBoundaryPolicy,
  sameOrigin,
} from './urlBoundary';

const policy = {
  baseUrl: 'https://kent.example.gov.tr/app/',
  allowedOrigins: ['https://services.example.gov.tr'],
  allowedHosts: ['services.example.gov.tr'],
};

describe('urlBoundary', () => {
  it('resolves relative URLs against the configured base', () => {
    const result = evaluateUrlBoundary('../assets/icon.svg', policy);
    expect(result.decision).toBe('allow');
    expect(result.normalizedUrl).toBe('https://kent.example.gov.tr/assets/icon.svg');
    expect(result.sameOrigin).toBe(true);
    expect(result.relative).toBe(true);
  });

  it('accepts explicitly allowed HTTPS external origins', () => {
    const result = evaluateUrlBoundary(
      'https://services.example.gov.tr/query?f=json',
      policy,
    );
    expect(result.decision).toBe('allow');
    expect(result.sameOrigin).toBe(false);
    expect(result.hostname).toBe('services.example.gov.tr');
  });

  it('rejects unlisted external origins when an allowlist exists', () => {
    const result = evaluateUrlBoundary('https://other.example.net/data', policy);
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('origin-not-allowed');
    expect(result.reasons.map((entry) => entry.code)).toContain('host-not-allowed');
  });

  it('requires HTTPS for external destinations by default', () => {
    const result = evaluateUrlBoundary('http://services.example.gov.tr/data', policy);
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('external-https-required');
  });

  it('rejects embedded URL user information', () => {
    const result = evaluateUrlBoundary(
      'https://user:example@services.example.gov.tr/data',
      policy,
    );
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('url-userinfo-not-allowed');
  });

  it('rejects non-web protocols', () => {
    const result = evaluateUrlBoundary('javascript:alert(1)', policy);
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('unsupported-protocol');
  });

  it('rejects literal loopback and RFC1918 targets', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.8', '172.16.0.1', '192.168.1.1']) {
      expect(isLocalNetworkHostname(host)).toBe(true);
    }
    const result = evaluateUrlBoundary('https://127.0.0.1/data', {
      baseUrl: 'https://kent.example.gov.tr/',
    });
    expect(result.decision).toBe('deny');
    expect(result.localNetworkTarget).toBe(true);
  });

  it('detects local IPv6 literal ranges', () => {
    expect(isLocalNetworkHostname('::1')).toBe(true);
    expect(isLocalNetworkHostname('fd00::1')).toBe(true);
    expect(isLocalNetworkHostname('fe80::1')).toBe(true);
    expect(isLocalNetworkHostname('2001:4860:4860::8888')).toBe(false);
  });

  it('rejects blocked wildcard hosts', () => {
    const result = evaluateUrlBoundary('https://internal.example.org/path', {
      baseUrl: 'https://kent.example.gov.tr/',
      blockedHosts: ['*.example.org'],
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('host-not-allowed');
  });

  it('honors explicit port policy', () => {
    const result = evaluateUrlBoundary('https://services.example.gov.tr:8443/data', {
      ...policy,
      allowedPorts: ['', '443'],
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('port-not-allowed');
  });

  it('enforces query parameter cardinality', () => {
    const result = evaluateUrlBoundary('/query?a=1&b=2&c=3', {
      baseUrl: 'https://kent.example.gov.tr/',
      maxQueryParameters: 2,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('too-many-query-parameters');
  });

  it('enforces path segment depth', () => {
    const result = evaluateUrlBoundary('/a/b/c/d', {
      baseUrl: 'https://kent.example.gov.tr/',
      maxPathSegments: 3,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('path-too-deep');
  });

  it('rejects fragments by default and accepts them when enabled', () => {
    const rejected = evaluateUrlBoundary('/map#section', {
      baseUrl: 'https://kent.example.gov.tr/',
    });
    expect(rejected.decision).toBe('deny');

    const accepted = evaluateUrlBoundary('/map#section', {
      baseUrl: 'https://kent.example.gov.tr/',
      allowFragments: true,
    });
    expect(accepted.decision).toBe('allow');
  });

  it('rejects relative input when policy disables it', () => {
    const result = evaluateUrlBoundary('/map', {
      baseUrl: 'https://kent.example.gov.tr/',
      allowRelative: false,
    });
    expect(result.decision).toBe('deny');
  });

  it('fails closed when relative input has no base', () => {
    const result = evaluateUrlBoundary('/map');
    expect(result.decision).toBe('deny');
    expect(result.normalizedUrl).toBeNull();
  });

  it('normalizes inverted or invalid numeric budgets', () => {
    const normalized = normalizeUrlBoundaryPolicy({
      maxUrlLength: -1,
      maxPathSegments: Number.NaN,
    });
    expect(normalized.maxUrlLength).toBeGreaterThan(100);
    expect(normalized.maxPathSegments).toBeGreaterThan(1);
  });

  it('compares origins after resolving relative paths', () => {
    expect(sameOrigin('/map', 'https://kent.example.gov.tr/app/')).toBe(true);
    expect(sameOrigin('https://other.example/map', 'https://kent.example.gov.tr/')).toBe(false);
  });
});
