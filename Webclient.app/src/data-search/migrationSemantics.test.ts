import { describe, expect, it } from 'vitest';
import { normalizeSearchDocument } from './search-index/indexing';
import {
  aggregateMetric,
  createSearchTelemetryCollector,
} from './search-observability/collector';

describe('Data/Search strict TypeScript migration semantic fidelity', () => {
  it('preserves the legacy sourceIndex contract without numeric-string coercion', () => {
    expect(normalizeSearchDocument({ sourceIndex: 7 }, 3).sourceIndex).toBe(7);
    expect(normalizeSearchDocument({ sourceIndex: '7' }, 3).sourceIndex).toBe(3);
    expect(normalizeSearchDocument({ sourceIndex: 2.5 }, 3).sourceIndex).toBe(3);
    expect(normalizeSearchDocument({}, 3).sourceIndex).toBe(3);
  });

  it('aggregates p90 from p90 rather than accidentally substituting p95', () => {
    const collector = createSearchTelemetryCollector();
    const metric = 'search.duration.ms';

    [1, 2, 3, 4, 5, 6, 7, 8, 9, 100].forEach(value => {
      collector.recordMetric(metric, value, { dataset: 'a' });
    });
    [2, 4, 6, 8, 10, 12, 14, 16, 18, 20].forEach(value => {
      collector.recordMetric(metric, value, { dataset: 'b' });
    });

    const first = collector.get(metric, { dataset: 'a' });
    const second = collector.get(metric, { dataset: 'b' });
    const aggregate = aggregateMetric(collector.snapshot(), metric);

    expect(first.p90).not.toBeNull();
    expect(second.p90).not.toBeNull();
    expect(aggregate.p90).toBe(Math.max(first.p90 ?? 0, second.p90 ?? 0));
    expect(aggregate.p90).not.toBe(aggregate.p95);
  });
});
