import { describe, expect, it } from 'vitest';
import { ArcGisRenderFrameGovernor, type ArcGisRenderFramePolicy } from './ArcGisRenderFrameGovernor';

const policy: ArcGisRenderFramePolicy = {
  targetFrameMs: 16,
  maxFrameMs: 24,
  maxLayers: 4,
  maxFeaturesPerFrame: 1000,
  maxDrawCallsPerFrame: 100,
  maxGpuBytesPerFrame: 10_000,
  maxCpuMsPerFrame: 12,
  recoveryFrames: 2,
  historySize: 3,
};

const demand = (layerId: string, lane: 'interaction'|'visible'|'background' = 'visible') => ({
  layerId,
  viewMode: '2d' as const,
  lane,
  requestedFeatures: 200,
  requestedDrawCalls: 20,
  requestedGpuBytes: 2000,
  estimatedCpuMs: 2,
  minimumFraction: 0.25,
});

describe('ArcGisRenderFrameGovernor', () => {
  it('admits deterministic priority ordered render grants', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('z-background', 'background'));
    runtime.upsert(demand('b-visible'));
    runtime.upsert(demand('a-interaction', 'interaction'));
    expect(runtime.plan().grants.map(x => x.layerId)).toEqual(['a-interaction', 'b-visible', 'z-background']);
  });

  it('filters grants by 2d/3d view mode without mutating identity', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('roads'));
    runtime.upsert({ ...demand('buildings'), viewMode: '3d' });
    expect(runtime.plan('2d').grants.map(x => x.layerId)).toEqual(['roads']);
    expect(runtime.plan('3d').grants.map(x => x.layerId)).toEqual(['buildings']);
    expect(runtime.plan().grants).toHaveLength(2);
  });

  it('never exceeds aggregate feature/draw/GPU/CPU budgets', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    for (const id of ['a','b','c','d']) runtime.upsert({ ...demand(id), requestedFeatures: 600, requestedDrawCalls: 60, requestedGpuBytes: 6000, estimatedCpuMs: 7 });
    const grants = runtime.plan().grants;
    expect(grants.reduce((n,x)=>n+x.grantedFeatures,0)).toBeLessThanOrEqual(policy.maxFeaturesPerFrame);
    expect(grants.reduce((n,x)=>n+x.grantedDrawCalls,0)).toBeLessThanOrEqual(policy.maxDrawCallsPerFrame);
    expect(grants.reduce((n,x)=>n+x.grantedGpuBytes,0)).toBeLessThanOrEqual(policy.maxGpuBytesPerFrame);
    expect(grants.reduce((n,x)=>n+x.grantedCpuMs,0)).toBeLessThanOrEqual(policy.maxCpuMsPerFrame);
  });

  it('skips a layer when remaining capacity cannot satisfy its minimum fraction', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert({ ...demand('critical','interaction'), requestedFeatures: 900, requestedDrawCalls: 90, requestedGpuBytes: 9000, estimatedCpuMs: 10, minimumFraction: 1 });
    runtime.upsert({ ...demand('background','background'), requestedFeatures: 500, requestedDrawCalls: 50, requestedGpuBytes: 5000, estimatedCpuMs: 6, minimumFraction: 0.5 });
    expect(runtime.plan().grants.map(x=>x.layerId)).toEqual(['critical']);
  });

  it('degrades quality after an overloaded or dropped frame', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('roads'));
    runtime.observe({ frameMs: 30, cpuMs: 13, gpuMs: 10, dropped: false });
    const first = runtime.plan();
    expect(first.qualityScale).toBe(0.75);
    expect(first.grants[0]?.fraction).toBeCloseTo(0.8125);
    runtime.observe({ frameMs: 10, cpuMs: 5, gpuMs: 5, dropped: true });
    expect(runtime.plan().qualityScale).toBeCloseTo(0.5625);
  });

  it('recovers quality only after the configured healthy frame streak', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.observe({ frameMs: 30, cpuMs: 13, gpuMs: 10, dropped: false });
    runtime.observe({ frameMs: 12, cpuMs: 5, gpuMs: 5, dropped: false });
    expect(runtime.plan().qualityScale).toBe(0.75);
    runtime.observe({ frameMs: 12, cpuMs: 5, gpuMs: 5, dropped: false });
    expect(runtime.plan().qualityScale).toBeCloseTo(0.85);
  });

  it('bounds observation history and returns immutable copies', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    for (let i=0;i<5;i++) runtime.observe({ frameMs: 10+i, cpuMs: 5, gpuMs: 4, dropped: false });
    const history = runtime.observations();
    expect(history).toHaveLength(3);
    expect(history.map(x=>x.frameMs)).toEqual([12,13,14]);
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history[0])).toBe(true);
  });

  it('preserves generation across same-view updates and renews after removal', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('roads'));
    const first = runtime.plan().grants[0]!.generation;
    runtime.upsert({ ...demand('roads'), requestedFeatures: 300 });
    expect(runtime.plan().grants[0]!.generation).toBe(first);
    runtime.remove('roads');
    runtime.upsert(demand('roads'));
    expect(runtime.plan().grants[0]!.generation).toBeGreaterThan(first);
  });

  it('rejects cross-view identity mutation until explicit removal', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('shared'));
    expect(()=>runtime.upsert({ ...demand('shared'), viewMode:'3d' })).toThrow(/viewMode/);
    runtime.remove('shared');
    expect(()=>runtime.upsert({ ...demand('shared'), viewMode:'3d' })).not.toThrow();
  });

  it('enforces bounded retained layer capacity', () => {
    const runtime = new ArcGisRenderFrameGovernor({ ...policy, maxLayers:2 });
    runtime.upsert(demand('a')); runtime.upsert(demand('b'));
    expect(()=>runtime.upsert(demand('c'))).toThrow(/capacity/);
    expect(runtime.remove('a')).toBe(true);
    expect(()=>runtime.upsert(demand('c'))).not.toThrow();
  });

  it('fails closed for malformed policy values', () => {
    expect(()=>new ArcGisRenderFrameGovernor({ ...policy, maxLayers:0 })).toThrow();
    expect(()=>new ArcGisRenderFrameGovernor({ ...policy, targetFrameMs:Number.NaN })).toThrow();
    expect(()=>new ArcGisRenderFrameGovernor({ ...policy, maxFrameMs:10 })).toThrow(/maxFrameMs/);
    expect(()=>new ArcGisRenderFrameGovernor({ ...policy, historySize:0 })).toThrow();
  });

  it('fails closed for malformed and oversized demands', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    expect(()=>runtime.upsert({ ...demand(' ')})).toThrow(/layerId/);
    expect(()=>runtime.upsert({ ...demand('x'), requestedFeatures:-1 })).toThrow();
    expect(()=>runtime.upsert({ ...demand('x'), requestedFeatures:Number.MAX_SAFE_INTEGER })).toThrow(/safety envelope/);
    expect(()=>runtime.upsert({ ...demand('x'), minimumFraction:1.1 })).toThrow();
    expect(()=>runtime.upsert({ ...demand('x'), estimatedCpuMs:Number.NaN })).toThrow();
  });

  it('fails closed for malformed frame observations', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    expect(()=>runtime.observe({ frameMs:0, cpuMs:1, gpuMs:1, dropped:false })).toThrow();
    expect(()=>runtime.observe({ frameMs:10, cpuMs:Number.NaN, gpuMs:1, dropped:false })).toThrow();
    expect(()=>runtime.observe({ frameMs:10, cpuMs:1, gpuMs:Number.POSITIVE_INFINITY, dropped:false })).toThrow();
  });

  it('produces immutable snapshots with monotonic frame sequence', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('roads'));
    const first=runtime.plan(); const second=runtime.plan();
    expect(second.sequence).toBe(first.sequence+1);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.grants)).toBe(true);
    expect(Object.isFrozen(second.grants[0])).toBe(true);
  });

  it('disposes idempotently and rejects subsequent operations', () => {
    const runtime = new ArcGisRenderFrameGovernor(policy);
    runtime.upsert(demand('roads'));
    runtime.dispose(); runtime.dispose();
    expect(()=>runtime.plan()).toThrow(/disposed/);
    expect(()=>runtime.upsert(demand('buildings'))).toThrow(/disposed/);
    expect(()=>runtime.observe({ frameMs:10,cpuMs:5,gpuMs:4,dropped:false })).toThrow(/disposed/);
  });
});
