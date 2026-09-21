import {
  GisServiceRegistry,
  createGisServiceRegistry,
} from './serviceRegistry';

describe('GisServiceRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('bounds retry and timeout configuration to protect the client', () => {
    const registry = createGisServiceRegistry([
      { id: 'places', url: '/arcgis/places', retries: 99, timeoutMs: 999999 },
    ]);

    expect(registry.get('places')).toMatchObject({
      retries: 5,
      timeoutMs: 120000,
    });
  });

  test('provides a request-scoped AbortSignal and attempt number to the factory', async () => {
    const registry = new GisServiceRegistry([{ id: 'places', url: '/arcgis/places', retries: 0 }]);
    const factory = vi.fn((service, context) => Promise.resolve({ service, context }));

    const result = await registry.request('places', factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result.service.id).toBe('places');
    expect(result.context.attempt).toBe(1);
    expect(result.context.signal === undefined || typeof result.context.signal.aborted === 'boolean').toBe(true);
    expect(registry.getHealth('places')).toMatchObject({
      status: 'healthy',
      attempts: 1,
      error: null,
    });
  });

  test('cancels timed out work instead of only rejecting the wrapper promise', async () => {
    vi.useFakeTimers();
    const registry = new GisServiceRegistry([{ id: 'slow', url: '/arcgis/slow', retries: 0 }]);
    let requestSignal;
    const factory = vi.fn((service, context) => {
      requestSignal = context.signal;
      return new Promise(() => {});
    });

    const pending = registry.request('slow', factory, { timeoutMs: 1000 });
    await Promise.resolve();
    vi.advanceTimersByTime(1000);

    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', serviceId: 'slow' });
    if (requestSignal) expect(requestSignal.aborted).toBe(true);
    expect(registry.getHealth('slow')).toMatchObject({
      status: 'unhealthy',
      attempts: 1,
    });
  });

  test('does not retry caller cancellation and keeps health neutral', async () => {
    const registry = new GisServiceRegistry([{ id: 'places', url: '/arcgis/places', retries: 5 }]);
    const controller = new AbortController();
    const factory = vi.fn(() => new Promise(() => {}));

    const pending = registry.request('places', factory, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(registry.getHealth('places')).toMatchObject({
      status: 'unknown',
      attempts: 1,
    });
  });
});
