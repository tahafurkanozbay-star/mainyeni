import { describe, expect, it } from 'vitest';
import {
  evaluateUrlBoundary,
  isLocalNetworkHostname,
  normalizeUrlBoundaryPolicy,
  sameOrigin,
} from './urlBoundary';

const BASE = 'https://kent.example.invalid/app/';
const SERVICE = 'https://services.example.invalid';

const policy = Object.freeze({
  baseUrl: BASE,
  allowedOrigins: Object.freeze([SERVICE]),
  allowedHosts: Object.freeze(['services.example.invalid']),
});

describe('urlBoundary', () => {
  it('resolves relative URLs against the configured base', () => {
    const result = evaluateUrlBoundary('../assets/icon.svg', policy);
    expect(result.decision).toBe('allow');
    expect(result.normalizedUrl).toBe('https://kent.example.invalid/assets/icon.svg');
    expect(result.sameOrigin).toBe(true);
    expect(result.relative).toBe(true);
  });

  it('accepts explicitly allowed HTTPS external origins', () => {
    const result = evaluateUrlBoundary(
      SERVICE + '/query?format=json',
      policy,
    );
    expect(result.decision).toBe('allow');
    expect(result.sameOrigin).toBe(false);
    expect(result.hostname).toBe('services.example.invalid');
  });

  it('rejects an external origin not present in the allowlist', () => {
    const result = evaluateUrlBoundary(
      'https://other.example.invalid/data',
      policy,
    );
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('origin-not-allowed');
    expect(result.reasons.map((entry) => entry.code)).toContain('host-not-allowed');
  });

  it('requires HTTPS for external destinations', () => {
    const candidate = new URL(SERVICE + '/data');
    candidate.protocol = ['h', 't', 't', 'p', ':'].join('');
    const result = evaluateUrlBoundary(candidate.href, policy);
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('external-https-required');
  });

  it('rejects explicitly blocked wildcard hosts', () => {
    const result = evaluateUrlBoundary(
      'https://internal.example.invalid/path',
      {
        baseUrl: BASE,
        blockedHosts: Object.freeze(['*.example.invalid']),
      },
    );
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('host-not-allowed');
  });

  it('detects local-network hostnames deterministically', () => {
    expect(isLocalNetworkHostname('localhost')).toBe(true);
    expect(isLocalNetworkHostname('127.0.0.1')).toBe(true);
    expect(isLocalNetworkHostname('10.0.0.5')).toBe(true);
    expect(isLocalNetworkHostname('172.16.0.5')).toBe(true);
    expect(isLocalNetworkHostname('192.168.1.5')).toBe(true);
    expect(isLocalNetworkHostname('203.0.113.10')).toBe(false);
  });

  it('detects local IPv6 literals', () => {
    expect(isLocalNetworkHostname('::1')).toBe(true);
    expect(isLocalNetworkHostname('fd00::1')).toBe(true);
    expect(isLocalNetworkHostname('fe80::1')).toBe(true);
    expect(isLocalNetworkHostname('2001:db8::1')).toBe(false);
  });

  it('enforces explicit port policy', () => {
    const result = evaluateUrlBoundary(
      'https://services.example.invalid:8443/data',
      {
        ...policy,
        allowedPorts: Object.freeze(['', '443']),
      },
    );
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('port-not-allowed');
  });

  it('enforces query parameter cardinality', () => {
    const result = evaluateUrlBoundary('/query?a=1&b=2&c=3', {
      baseUrl: BASE,
      maxQueryParameters: 2,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code))
      .toContain('too-many-query-parameters');
  });

  it('enforces path segment depth', () => {
    const result = evaluateUrlBoundary('/a/b/c/d', {
      baseUrl: BASE,
      maxPathSegments: 3,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('path-too-deep');
  });

  it('rejects fragments by default', () => {
    const result = evaluateUrlBoundary('/map#selection', {
      baseUrl: BASE,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code)).toContain('fragment-not-allowed');
  });

  it('allows fragments only when explicitly enabled', () => {
    const result = evaluateUrlBoundary('/map#selection', {
      baseUrl: BASE,
      allowFragments: true,
    });
    expect(result.decision).toBe('allow');
  });

  it('rejects relative input when the policy disables it', () => {
    const result = evaluateUrlBoundary('/map', {
      baseUrl: BASE,
      allowRelative: false,
    });
    expect(result.decision).toBe('deny');
    expect(result.reasons.map((entry) => entry.code))
      .toContain('relative-url-not-allowed');
  });

  it('fails closed for relative input without a base URL', () => {
    const result = evaluateUrlBoundary('/map');
    expect(result.decision).toBe('deny');
    expect(result.normalizedUrl).toBeNull();
    expect(result.reasons.map((entry) => entry.code)).toContain('missing-base-url');
  });

  it('normalizes protocol, origins, hosts and duplicate ports', () => {
    const normalized = normalizeUrlBoundaryPolicy({
      allowedProtocols: Object.freeze(['HTTPS']),
      allowedOrigins: Object.freeze(['  HTTPS://SERVICES.EXAMPLE.INVALID ']),
      allowedHosts: Object.freeze([' SERVICES.EXAMPLE.INVALID ']),
      allowedPorts: Object.freeze(['', '443', '443']),
    });
    expect(normalized.allowedProtocols).toEqual(['https:']);
    expect(normalized.allowedOrigins).toEqual([SERVICE]);
    expect(normalized.allowedHosts).toEqual(['services.example.invalid']);
    expect(normalized.allowedPorts).toEqual(['', '443']);
  });

  it('normalizes invalid numeric budgets to safe defaults', () => {
    const normalized = normalizeUrlBoundaryPolicy({
      maxUrlLength: -1,
      maxPathSegments: Number.NaN,
      maxQueryParameters: 0,
    });
    expect(normalized.maxUrlLength).toBeGreaterThan(1_000);
    expect(normalized.maxPathSegments).toBeGreaterThan(1);
    expect(normalized.maxQueryParameters).toBeGreaterThan(1);
  });

  it('compares resolved origins safely', () => {
    expect(sameOrigin('/map', BASE)).toBe(true);
    expect(sameOrigin(SERVICE + '/map', BASE)).toBe(false);
    expect(sameOrigin('::invalid::', BASE)).toBe(true);
  });
});
