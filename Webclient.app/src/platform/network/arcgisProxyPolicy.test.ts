import { describe, expect, it, vi } from 'vitest';
import {
  ArcgisProxyPolicyError,
  buildArcgisProxyEndpoint,
  createArcgisProxyPolicy,
  resolveConfigurationServiceUrl,
} from './arcgisProxyPolicy';

describe('resolveConfigurationServiceUrl', () => {
  it('supports the bounded legacy service URL field set', () => {
    expect(resolveConfigurationServiceUrl({ eg: ' https://gis.example.test/a ' })).toBe(
      'https://gis.example.test/a',
    );
    expect(resolveConfigurationServiceUrl({ Eg: 'https://gis.example.test/b' })).toBe(
      'https://gis.example.test/b',
    );
    expect(resolveConfigurationServiceUrl({ url: 'https://gis.example.test/c' })).toBe(
      'https://gis.example.test/c',
    );
    expect(resolveConfigurationServiceUrl({ Url: 'https://gis.example.test/d' })).toBe(
      'https://gis.example.test/d',
    );
  });

  it('prefers the canonical lower-case field when multiple aliases exist', () => {
    expect(resolveConfigurationServiceUrl({
      eg: 'https://gis.example.test/canonical',
      Eg: 'https://gis.example.test/legacy',
    })).toBe('https://gis.example.test/canonical');
  });

  it('returns null for missing or non-string service URLs', () => {
    expect(resolveConfigurationServiceUrl({})).toBeNull();
    expect(resolveConfigurationServiceUrl({ eg: 17 })).toBeNull();
    expect(resolveConfigurationServiceUrl({ eg: '   ' })).toBeNull();
  });
});

describe('buildArcgisProxyEndpoint', () => {
  it('builds the proxy endpoint from the canonical API base path', () => {
    expect(buildArcgisProxyEndpoint('/api')).toBe('/api/Gis/Proxy');
    expect(buildArcgisProxyEndpoint('/api/')).toBe('/api/Gis/Proxy');
    expect(buildArcgisProxyEndpoint('/')).toBe('/Gis/Proxy');
  });
});

describe('createArcgisProxyPolicy', () => {
  it('lazily registers an HTTPS cross-origin service through the same-origin proxy', async () => {
    const addProxyRule = vi.fn();
    const loadAdapter = vi.fn(async () => ({ addProxyRule }));
    const policy = createArcgisProxyPolicy({
      apiBaseUrl: '/api',
      origin: 'https://kent.example.test',
      loadAdapter,
    });

    expect(policy.snapshot()).toEqual({
      registeredRuleCount: 0,
      adapterLoaded: false,
    });

    await expect(policy.register('https://gis.example.test/arcgis/rest/services/Parcels/MapServer'))
      .resolves.toEqual({ status: 'registered', proxied: true });

    expect(loadAdapter).toHaveBeenCalledTimes(1);
    expect(addProxyRule).toHaveBeenCalledWith({
      urlPrefix: 'https://gis.example.test/arcgis/rest/services/Parcels/MapServer',
      proxyUrl: '/api/Gis/Proxy',
    });
    expect(policy.snapshot()).toEqual({
      registeredRuleCount: 1,
      adapterLoaded: true,
    });
  });

  it('does not load ArcGIS proxy runtime for same-origin rooted services', async () => {
    const loadAdapter = vi.fn(async () => ({ addProxyRule: vi.fn() }));
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter,
    });

    await expect(policy.register('/arcgis/rest/services/Local/FeatureServer'))
      .resolves.toEqual({ status: 'same-origin', proxied: false });
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it('does not proxy an absolute service already on the application origin', async () => {
    const loadAdapter = vi.fn(async () => ({ addProxyRule: vi.fn() }));
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter,
    });

    await expect(policy.register('https://kent.example.test/arcgis/rest/services/Local/MapServer'))
      .resolves.toEqual({ status: 'same-origin', proxied: false });
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it('deduplicates equivalent cross-origin registrations', async () => {
    const addProxyRule = vi.fn();
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter: async () => ({ addProxyRule }),
    });

    await expect(policy.register('https://gis.example.test/service/')).resolves.toEqual({
      status: 'registered',
      proxied: true,
    });
    await expect(policy.register('https://gis.example.test/service')).resolves.toEqual({
      status: 'duplicate',
      proxied: true,
    });
    expect(addProxyRule).toHaveBeenCalledTimes(1);
    expect(policy.snapshot().registeredRuleCount).toBe(1);
  });

  it('reuses one lazily loaded adapter across different services', async () => {
    const addProxyRule = vi.fn();
    const loadAdapter = vi.fn(async () => ({ addProxyRule }));
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter,
    });

    await policy.register('https://gis-a.example.test/a');
    await policy.register('https://gis-b.example.test/b');

    expect(loadAdapter).toHaveBeenCalledTimes(1);
    expect(addProxyRule).toHaveBeenCalledTimes(2);
  });

  it('clear removes dedupe state without hiding the already loaded adapter', async () => {
    const addProxyRule = vi.fn();
    const loadAdapter = vi.fn(async () => ({ addProxyRule }));
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter,
    });

    await policy.register('https://gis.example.test/a');
    policy.clear();

    expect(policy.snapshot()).toEqual({
      registeredRuleCount: 0,
      adapterLoaded: true,
    });

    await policy.register('https://gis.example.test/a');
    expect(addProxyRule).toHaveBeenCalledTimes(2);
    expect(loadAdapter).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['javascript:alert(1)', 'PLATFORM_PROXY_URL_PROTOCOL'],
    ['data:text/plain,hello', 'PLATFORM_PROXY_URL_PROTOCOL'],
    ['//gis.example.test/path', 'PLATFORM_PROXY_URL_AMBIGUOUS'],
    ['gis.example.test/path', 'PLATFORM_PROXY_URL_RELATIVE'],
    ['https://user:secret@gis.example.test/path', 'PLATFORM_PROXY_URL_UNSAFE_COMPONENT'],
    ['https://gis.example.test/path?token=secret', 'PLATFORM_PROXY_URL_UNSAFE_COMPONENT'],
    ['https://gis.example.test/path#fragment', 'PLATFORM_PROXY_URL_UNSAFE_COMPONENT'],
    ['https://gis.example.test/path\nheader', 'PLATFORM_PROXY_URL_CONTROL_CHARACTERS'],
  ])('fails closed for unsafe proxy target %s', async (url, code) => {
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter: async () => ({ addProxyRule: vi.fn() }),
    });

    const failure = policy.register(url);
    await expect(failure).rejects.toBeInstanceOf(ArcgisProxyPolicyError);
    await expect(failure).rejects.toMatchObject({ code });
  });

  it('collapses repeated path separators and trailing slash for stable dedupe keys', async () => {
    const addProxyRule = vi.fn();
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter: async () => ({ addProxyRule }),
    });

    await policy.register('https://gis.example.test/arcgis//rest/services/a///');
    expect(addProxyRule).toHaveBeenCalledWith({
      urlPrefix: 'https://gis.example.test/arcgis/rest/services/a',
      proxyUrl: '/api/Gis/Proxy',
    });
  });

  it('does not expose registered service URLs in snapshots', async () => {
    const policy = createArcgisProxyPolicy({
      origin: 'https://kent.example.test',
      loadAdapter: async () => ({ addProxyRule: vi.fn() }),
    });

    await policy.register('https://gis.example.test/private-name');
    expect(JSON.stringify(policy.snapshot())).not.toContain('private-name');
  });
});
