import { describe, expect, it, vi } from 'vitest';
import type { RawRequestConfig } from '../../platform/http/contracts';
import {
  createApiRuntime,
  createBusinessDiagnostics,
  normalizeApiRequestControl,
  normalizeBusinessRuntimePolicy,
} from './index';

describe('Business API request policy', () => {
  it('normalizes invalid policy values into bounded safe ranges', () => {
    const policy = normalizeBusinessRuntimePolicy({
      maxTextLength: -10,
      maxIdentifierCount: 999999,
      defaultTimeoutMs: -1,
      maxTimeoutMs: 5000,
      defaultCacheTtlMs: -1,
      maxCacheTtlMs: 1000,
    });

    expect(policy.maxTextLength).toBe(1);
    expect(policy.maxIdentifierCount).toBe(10000);
    expect(policy.defaultTimeoutMs).toBe(1);
    expect(policy.maxTimeoutMs).toBe(5000);
    expect(policy.defaultCacheTtlMs).toBe(0);
    expect(policy.maxCacheTtlMs).toBe(1000);
  });

  it('disables request dedupe when caller cancellation is supplied', () => {
    const controller = new AbortController();
    const control = normalizeApiRequestControl({
      signal: controller.signal,
      cacheTtlMs: 5000,
      timeoutMs: 10000,
    });

    expect(control.signal).toBe(controller.signal);
    expect(control.dedupe).toBe(false);
    expect(control.cache).toBe(true);
    expect(control.cacheTtlMs).toBe(5000);
    expect(control.timeoutMs).toBe(10000);
  });

  it('keeps dedupe enabled for ordinary idempotent reads', () => {
    expect(normalizeApiRequestControl({})).toMatchObject({
      cache: true,
      dedupe: true,
      cacheTtlMs: 30000,
      timeout: 15000,
    });
  });
});

describe('Business API runtime', () => {
  const setup = () => {
    const diagnostics = createBusinessDiagnostics();
    const get = vi.fn<(url: string, options?: RawRequestConfig) => Promise<unknown>>();
    const runtime = createApiRuntime({
      client: { get },
      diagnostics,
    });
    return { diagnostics, get, runtime };
  };

  it('delegates GET requests to the existing platform client', async () => {
    const ctx = setup();
    ctx.get.mockResolvedValue({ ok: true });

    await expect(ctx.runtime.get(
      'business.documents',
      '/Common/FileService.svc/GetBuildingDocuments',
      {
        params: { buildingId: '1' },
      },
    )).resolves.toEqual({ ok: true });

    expect(ctx.get).toHaveBeenCalledWith(
      '/Common/FileService.svc/GetBuildingDocuments',
      expect.objectContaining({
        params: { buildingId: '1' },
        cache: true,
        dedupe: true,
        cacheTtlMs: 30000,
        timeoutMs: 15000,
      }),
    );
    expect(ctx.diagnostics.snapshot().counts.success).toBe(1);
  });

  it('forwards bounded control and caller signal', async () => {
    const ctx = setup();
    const controller = new AbortController();
    ctx.get.mockResolvedValue([]);

    await ctx.runtime.get('business.photos', '/photos', {
      control: {
        signal: controller.signal,
        cacheTtlMs: 5000,
        timeout: 7000,
      },
    });

    expect(ctx.get).toHaveBeenCalledWith('/photos', expect.objectContaining({
      signal: controller.signal,
      cacheTtlMs: 5000,
      timeoutMs: 7000,
      dedupe: false,
    }));
  });

  it('records failures without swallowing platform errors', async () => {
    const ctx = setup();
    const error = Object.assign(new Error('network'), { code: 'NETWORK' });
    ctx.get.mockRejectedValue(error);

    await expect(ctx.runtime.get('business.fail', '/fail')).rejects.toBe(error);
    const event = ctx.diagnostics.snapshot().events.at(-1);
    expect(event?.status).toBe('failure');
    expect(event?.code).toBe('Error');
  });

  it('records caller cancellation separately from ordinary failures', async () => {
    const ctx = setup();
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException('aborted', 'AbortError');
    ctx.get.mockRejectedValue(error);

    await expect(ctx.runtime.get('business.cancel', '/cancel', {
      control: { signal: controller.signal },
    })).rejects.toBe(error);
    expect(ctx.diagnostics.snapshot().counts.cancelled).toBe(1);
  });

  it('attaches service key only when explicitly provided', async () => {
    const ctx = setup();
    ctx.get.mockResolvedValue(null);
    await ctx.runtime.get('business.service', '/x', {
      serviceKey: 'FileService',
    });
    const started = ctx.diagnostics.snapshot().events.find(
      event => event.status === 'started',
    );
    expect(started?.serviceKey).toBe('FileService');
  });
});
