import { describe, expect, it } from 'vitest';
import {
  collectResourceTimings,
  normalizeResourceTiming,
  summarizeResourceTimings,
} from './resources';
import {
  collectLongTasks,
  normalizeLongTask,
  summarizeLongTasks,
} from './longTasks';

const resourceEntry = (
  name: string,
  initiatorType: string,
  overrides: Partial<PerformanceResourceTiming> = {},
): PerformanceResourceTiming => ({
  name,
  entryType: 'resource',
  startTime: 0,
  duration: 10,
  initiatorType,
  nextHopProtocol: 'h2',
  workerStart: 0,
  redirectStart: 0,
  redirectEnd: 0,
  fetchStart: 0,
  domainLookupStart: 0,
  domainLookupEnd: 0,
  connectStart: 0,
  connectEnd: 0,
  secureConnectionStart: 0,
  requestStart: 0,
  responseStart: 0,
  responseEnd: 10,
  transferSize: 100,
  encodedBodySize: 80,
  decodedBodySize: 120,
  serverTiming: [],
  renderBlockingStatus: 'non-blocking',
  responseStatus: 200,
  toJSON: () => ({}),
  ...overrides,
} as PerformanceResourceTiming);

describe('resource timing governance', () => {
  it('normalizes same-origin and cross-origin resource timings', () => {
    const same = normalizeResourceTiming(
      resourceEntry('https://app.example.com/app.js', 'script'),
      'https://app.example.com',
    );
    const cross = normalizeResourceTiming(
      resourceEntry('https://cdn.example.net/app.css', 'link'),
      'https://app.example.com',
    );

    expect(same).toMatchObject({
      category: 'script',
      originKind: 'same-origin',
      origin: 'https://app.example.com',
      transferBytes: 100,
      decodedBytes: 120,
      renderBlocking: true,
    });
    expect(cross).toMatchObject({
      category: 'style',
      originKind: 'cross-origin',
      origin: 'https://cdn.example.net',
      renderBlocking: true,
    });
  });

  it('recognizes cache-like zero-transfer resources', () => {
    const sample = normalizeResourceTiming(
      resourceEntry('https://app.example.com/cached.js', 'script', {
        transferSize: 0,
        decodedBodySize: 400,
      }),
      'https://app.example.com',
    );
    expect(sample?.cacheLike).toBe(true);
  });

  it('summarizes counts, bytes and sanitized external origins', () => {
    const samples = [
      normalizeResourceTiming(resourceEntry('https://app.example.com/a.js', 'script'), 'https://app.example.com'),
      normalizeResourceTiming(resourceEntry('https://cdn.example.net/a.css', 'link'), 'https://app.example.com'),
      normalizeResourceTiming(resourceEntry('https://cdn.example.net/b.woff2', 'font'), 'https://app.example.com'),
    ].filter((value): value is NonNullable<typeof value> => value !== null);

    const summary = summarizeResourceTimings(samples);
    expect(summary.count).toBe(3);
    expect(summary.sameOriginCount).toBe(1);
    expect(summary.crossOriginCount).toBe(2);
    expect(summary.transferBytes).toBe(300);
    expect(summary.categoryCounts.script).toBe(1);
    expect(summary.categoryCounts.style).toBe(1);
    expect(summary.categoryCounts.font).toBe(1);
    expect(summary.crossOriginOrigins).toEqual(['https://cdn.example.net']);
  });

  it('collects resource timings from injected performance state', () => {
    const entries = [
      resourceEntry('https://app.example.com/a.js', 'script'),
      resourceEntry('https://app.example.com/b.png', 'img'),
    ];
    const summary = collectResourceTimings({
      locationOrigin: 'https://app.example.com',
      performanceRef: {
        getEntriesByType: type => type === 'resource' ? entries : [],
      },
    });
    expect(summary.count).toBe(2);
    expect(summary.sameOriginCount).toBe(2);
  });
});

describe('long task governance', () => {
  const task = (duration: number, startTime = 0): PerformanceEntry => ({
    name: 'self',
    entryType: 'longtask',
    startTime,
    duration,
    toJSON: () => ({}),
  });

  it('normalizes and summarizes blocking time above the 50ms responsiveness budget', () => {
    const first = normalizeLongTask(task(80));
    const second = normalizeLongTask(task(120, 100));
    expect(first?.durationMs).toBe(80);
    const summary = summarizeLongTasks(
      [first, second].filter((value): value is NonNullable<typeof value> => value !== null),
    );
    expect(summary.count).toBe(2);
    expect(summary.totalDurationMs).toBe(200);
    expect(summary.blockingTimeMs).toBe(100);
    expect(summary.duration.maximum).toBe(120);
  });

  it('ignores non-longtask entries', () => {
    expect(normalizeLongTask({
      name: 'paint',
      entryType: 'paint',
      startTime: 0,
      duration: 0,
      toJSON: () => ({}),
    })).toBeNull();
  });

  it('collects long tasks from injected performance state', () => {
    const summary = collectLongTasks({
      performanceRef: {
        getEntriesByType: type => type === 'longtask' ? [task(60), task(70)] : [],
      },
    });
    expect(summary.count).toBe(2);
    expect(summary.blockingTimeMs).toBe(30);
  });
});
