import { describe, expect, it } from 'vitest';
import { ArcGisServiceRequestBudgetCoordinator } from './ArcGisServiceRequestBudgetCoordinator';

const policy = { maxServices: 3, maxServiceKeyLength: 32, maxConcurrentGlobal: 2, maxConcurrentPerService: 1, maxQueuedGlobal: 3, maxQueuedPerService: 2, maxEstimatedBytes: 1_000, maxEstimatedFeatures: 100, maxQueueAgeMs: 100, maxClockSkewMs: 10 } as const;
const create = () => new ArcGisServiceRequestBudgetCoordinator(policy);
const request = (requestId: string, serviceKey = 'parcels', priority: 'interactive'|'foreground'|'background' = 'foreground') => ({ requestId, serviceKey, priority, estimatedBytes: 100, estimatedFeatures: 10 });

describe('ArcGisServiceRequestBudgetCoordinator', () => {
  it('admits within global and per-service concurrency and queues excess', () => {
    const c=create(); expect(c.submit(request('a'),1).reason).toBe('admitted'); expect(c.submit(request('b'),2).reason).toBe('queued'); expect(c.submit(request('c','roads'),3).reason).toBe('admitted');
  });
  it('promotes queued work after completion with deterministic priority', () => {
    const c=create(); c.submit(request('a'),1); c.submit(request('b','parcels','background'),2); c.submit(request('c','parcels','interactive'),3); c.submit(request('d','roads'),4);
    expect(c.complete('a',5).map(x=>x.requestId)).toEqual(['c']);
  });
  it('rejects oversized estimated workloads before queueing', () => {
    const c=create(); expect(c.submit({...request('a'),estimatedBytes:1001},1).reason).toBe('budget'); expect(c.submit({...request('b'),estimatedFeatures:101},2).reason).toBe('budget'); expect(c.snapshot(2).active).toEqual([]);
  });
  it('bounds queue capacity per service and globally', () => {
    const c=create(); c.submit(request('a'),1); c.submit(request('b'),2); c.submit(request('c'),3); expect(c.submit(request('d'),4).reason).toBe('capacity');
  });
  it('expires queued work without retaining payloads', () => {
    const c=create(); c.submit(request('a'),1); c.submit(request('b'),2); expect(c.snapshot(103).queued).toEqual([]);
  });
  it('rejects duplicate and malformed identities', () => {
    const c=create(); c.submit(request('a'),1); expect(()=>c.submit(request('a','roads'),2)).toThrow('duplicate'); expect(()=>c.submit(request('bad\0id'),2)).toThrow('request id'); expect(()=>c.submit(request('b',' '),2)).toThrow('service key');
  });
  it('rejects stale clocks outside configured skew', () => {
    const c=create(); c.submit(request('a'),100); expect(()=>c.snapshot(89)).toThrow('stale'); expect(()=>c.snapshot(90)).not.toThrow();
  });
  it('cancels active work and promotes the best queued candidate', () => {
    const c=create(); c.submit(request('a'),1); c.submit(request('b','parcels','background'),2); c.submit(request('c','parcels','interactive'),3); expect(c.cancel('a',4).map(x=>x.requestId)).toEqual(['c']);
  });
  it('restores valid primitive state atomically', () => {
    const c=create(); c.restore({active:[{...request('a'),enqueuedAtMs:10}],queued:[{...request('b'),enqueuedAtMs:11}]},12); expect(c.snapshot(12).active.map(x=>x.requestId)).toEqual(['a']); expect(c.snapshot(12).queued.map(x=>x.requestId)).toEqual(['b']);
  });
  it('does not replace live state when restore validation fails', () => {
    const c=create(); c.submit(request('live'),1); expect(()=>c.restore({active:[{...request('a'),enqueuedAtMs:10}],queued:[{...request('a'),enqueuedAtMs:10}]},10)).toThrow('duplicate'); expect(c.snapshot(10).active.map(x=>x.requestId)).toEqual(['live']);
  });
  it('rejects future and over-budget restored state', () => {
    const c=create(); expect(()=>c.restore({active:[],queued:[{...request('a'),enqueuedAtMs:21}]},10)).toThrow('future'); expect(()=>c.restore({active:[{...request('a'),estimatedBytes:1001,enqueuedAtMs:1}],queued:[]},10)).toThrow('budget');
  });
  it('freezes snapshots and becomes unusable after disposal', () => {
    const c=create(); c.submit(request('a'),1); const s=c.snapshot(1); expect(Object.isFrozen(s)).toBe(true); expect(Object.isFrozen(s.active)).toBe(true); c.dispose(); c.dispose(); expect(()=>c.snapshot(2)).toThrow(/disposed/);
  });
});
