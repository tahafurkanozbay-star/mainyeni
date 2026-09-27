import { describe, expect, it } from 'vitest';
import { ArcGisServiceResponseCacheCoordinator, type ArcGisServiceResponseCachePolicy } from './ArcGisServiceResponseCacheCoordinator';

const policy: ArcGisServiceResponseCachePolicy = {
  maxEntries: 3, maxEntriesPerService: 2, maxServiceKeyLength: 32, maxCacheKeyLength: 64,
  maxPayloadBytes: 100, maxTotalBytes: 180, maxTtlMs: 1_000, maxStaleMs: 200, maxClockSkewMs: 5,
};
const cache = () => new ArcGisServiceResponseCacheCoordinator(policy);
const put = (c: ArcGisServiceResponseCacheCoordinator, serviceKey: string, cacheKey: string, now: number, bytes=40, ttlMs=100) =>
  c.put({ serviceKey, cacheKey, scope: 'query', payloadBytes: bytes, ttlMs }, now);

describe('ArcGisServiceResponseCacheCoordinator', () => {
  it('tracks fresh and explicitly stale metadata without retaining response bodies', () => {
    const c=cache(); const entry=put(c,'parcels','where=1',10); expect(entry.payloadBytes).toBe(40);
    expect(c.lookup('parcels','where=1',50).state).toBe('fresh');
    expect(c.lookup('parcels','where=1',120,true).state).toBe('stale');
    expect(c.snapshot(120).entries[0]?.accessCount).toBe(2);
  });
  it('fails closed on expired lookup unless stale use is explicit', () => {
    const c=cache(); put(c,'roads','a',0); expect(c.lookup('roads','a',101).state).toBe('miss'); expect(c.snapshot(101).entries).toHaveLength(0);
  });
  it('evicts deterministic least recently used entries for per-service pressure', () => {
    const c=cache(); put(c,'roads','a',1); put(c,'roads','b',2); c.lookup('roads','a',3); put(c,'roads','c',4);
    expect(c.lookup('roads','b',4).state).toBe('miss'); expect(c.lookup('roads','a',4).state).toBe('fresh'); expect(c.lookup('roads','c',4).state).toBe('fresh');
  });
  it('evicts under total byte pressure', () => {
    const c=cache(); put(c,'a','1',1,90); put(c,'b','1',2,80); put(c,'c','1',3,80);
    expect(c.lookup('a','1',3).state).toBe('miss'); expect(c.snapshot(3).totalBytes).toBe(160);
  });
  it('rejects oversized payload and ttl budgets', () => {
    const c=cache(); expect(()=>put(c,'a','1',0,101)).toThrow(/payload/); expect(()=>put(c,'a','1',0,1,1001)).toThrow(/ttl/);
  });
  it('keeps service and scope invalidation bounded', () => {
    const c=cache(); put(c,'a','1',1); put(c,'a','2',2); c.put({serviceKey:'b',cacheKey:'legend',scope:'legend',payloadBytes:10,ttlMs:100},3);
    expect(c.invalidateService('a')).toBe(2); expect(c.invalidateScope('legend')).toBe(1); expect(c.snapshot(3).entries).toHaveLength(0);
  });
  it('restores valid immutable primitive metadata atomically', () => {
    const source=cache(); put(source,'a','1',10); const snap=source.snapshot(20); const target=cache(); target.restore(snap,20);
    const restored=target.snapshot(20); expect(restored.entries).toHaveLength(1); expect(Object.isFrozen(restored.entries[0])).toBe(true);
  });
  it('rejects duplicate identities without mutating prior state', () => {
    const c=cache(); put(c,'safe','existing',10); const e={serviceKey:'a',cacheKey:'1',scope:'query' as const,payloadBytes:1,etag:null,storedAtMs:10,expiresAtMs:20,lastAccessedAtMs:10,accessCount:0};
    expect(()=>c.restore({entries:[e,e]},10)).toThrow(/duplicate/); expect(c.lookup('safe','existing',10).state).toBe('fresh');
  });
  it('rejects future and inverted restored timelines', () => {
    const c=cache(); const base={serviceKey:'a',cacheKey:'1',scope:'query' as const,payloadBytes:1,etag:null,lastAccessedAtMs:10,accessCount:0};
    expect(()=>c.restore({entries:[{...base,storedAtMs:20,expiresAtMs:30}]},10)).toThrow(/timeline/);
    expect(()=>c.restore({entries:[{...base,storedAtMs:10,expiresAtMs:9}]},10)).toThrow(/timeline/);
  });
  it('drops entries beyond the stale retention horizon during restore', () => {
    const c=cache(); c.restore({entries:[{serviceKey:'a',cacheKey:'1',scope:'query',payloadBytes:1,etag:null,storedAtMs:0,expiresAtMs:100,lastAccessedAtMs:0,accessCount:0}]},301); expect(c.snapshot(301).entries).toHaveLength(0);
  });
  it('rejects malformed identities, etags and scopes', () => {
    const c=cache(); expect(()=>put(c,'\0bad','x',0)).toThrow(); expect(()=>c.put({serviceKey:'a',cacheKey:'x',scope:'bad' as never,payloadBytes:1,ttlMs:1},0)).toThrow(/scope/);
    expect(()=>c.put({serviceKey:'a',cacheKey:'x',scope:'query',payloadBytes:1,etag:'\0bad',ttlMs:1},0)).toThrow(/etag/);
  });
  it('rejects stale clocks and use after disposal', () => {
    const c=cache(); put(c,'a','1',100); expect(()=>c.snapshot(90)).toThrow(/stale/); c.dispose(); expect(()=>c.snapshot(100)).toThrow(/disposed/);
  });
  it('rejects snapshot capacity and byte-budget violations', () => {
    const c=cache(); const make=(key:string,bytes=1)=>({serviceKey:'a',cacheKey:key,scope:'query' as const,payloadBytes:bytes,etag:null,storedAtMs:0,expiresAtMs:100,lastAccessedAtMs:0,accessCount:0});
    expect(()=>c.restore({entries:[make('1'),make('2'),make('3'),make('4')]},0)).toThrow(/snapshot/);
    expect(()=>c.restore({entries:[make('1',100),{...make('2',100),serviceKey:'b'}]},0)).toThrow(/total cache bytes/);
  });
  it('rejects per-service restore overflow and excessive ttl', () => {
    const c=cache(); const make=(key:string)=>({serviceKey:'a',cacheKey:key,scope:'query' as const,payloadBytes:1,etag:null,storedAtMs:0,expiresAtMs:100,lastAccessedAtMs:0,accessCount:0});
    expect(()=>c.restore({entries:[make('1'),make('2'),make('3')]},0)).toThrow(/per-service/);
    expect(()=>c.restore({entries:[{...make('1'),expiresAtMs:1001}]},0)).toThrow(/timeline/);
  });
});
