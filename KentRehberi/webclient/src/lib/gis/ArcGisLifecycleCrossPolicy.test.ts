import { describe, expect, it } from 'vitest'
import { ArcGisProjectionLifecyclePolicy } from './ArcGisProjectionLifecyclePolicy'
import { ArcGisSceneAssetLifecyclePolicy } from './ArcGisSceneAssetLifecyclePolicy'
import { ArcGisSpatialAnalysisLifecyclePolicy } from './ArcGisSpatialAnalysisLifecyclePolicy'

const projectionBudget = {
  maxRequests: 3,
  maxRunning: 1,
  maxReady: 1,
  maxPoints: 10,
  maxPointsPerRequest: 5,
  maxEstimatedBytes: 500,
  maxEstimatedBytesPerRequest: 250,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 100,
}
const sceneBudget = {
  maxViews: 1,
  maxAssets: 3,
  maxAssetsPerView: 3,
  maxResidentAssets: 1,
  maxGpuBytes: 500,
  maxGpuBytesPerAsset: 250,
  maxCpuBytes: 500,
  maxCpuBytesPerAsset: 250,
  maxTriangles: 5000,
  maxTrianglesPerAsset: 2500,
  maxLod: 4,
  queueTtlMs: 100,
  residentTtlMs: 100,
}
const analysisBudget = {
  maxViews: 1,
  maxRequests: 3,
  maxRequestsPerView: 3,
  maxRunning: 1,
  maxReady: 1,
  maxInputVertices: 10,
  maxInputVerticesPerRequest: 5,
  maxCandidateFeatures: 20,
  maxCandidateFeaturesPerRequest: 10,
  maxEstimatedBytes: 500,
  maxEstimatedBytesPerRequest: 250,
  maxDistanceMeters: 1000,
  queueTtlMs: 100,
  runLeaseMs: 50,
  readyTtlMs: 100,
}

describe('ArcGIS lifecycle cross-policy invariants', () => {
  it('keeps projection accounting isolated from scene residency', () => {
    const projection = new ArcGisProjectionLifecyclePolicy(projectionBudget)
    const scene = new ArcGisSceneAssetLifecyclePolicy(sceneBudget)
    projection.admit({ requestId:'p',revision:1,requestedAt:0,sourceWkid:4326,targetWkid:3857,pointCount:2,estimatedBytes:100 })
    scene.admit({ viewId:'s',assetId:'m',revision:1,kind:'mesh',intent:'visible',requestedAt:0,lod:1,estimatedGpuBytes:100,estimatedCpuBytes:100,estimatedTriangles:1000 })
    expect(projection.snapshot().estimatedBytes).toBe(100)
    expect(scene.snapshot().estimatedGpuBytes).toBe(100)
  })
  it('keeps analysis result accounting payload free', () => {
    const policy = new ArcGisSpatialAnalysisLifecyclePolicy(analysisBudget)
    policy.admit({ viewId:'m',requestId:'q',revision:1,intent:'filter',requestedAt:0,inputVertices:2,candidateFeatures:5,estimatedBytes:100,inputWkid:3857,distanceMeters:null })
    policy.begin('m','q',1,10)
    policy.markReady('m','q',1,20,3,120)
    expect(policy.snapshot()).toMatchObject({ resultFeatures:3,resultBytes:120 })
    expect(Object.keys(policy.entriesForView('m')[0])).not.toContain('payload')
  })
  it('uses independent revision domains', () => {
    const projection = new ArcGisProjectionLifecyclePolicy(projectionBudget)
    const analysis = new ArcGisSpatialAnalysisLifecyclePolicy(analysisBudget)
    projection.admit({ requestId:'p',revision:7,requestedAt:0,sourceWkid:4326,targetWkid:3857,pointCount:1,estimatedBytes:10 })
    analysis.admit({ viewId:'m',requestId:'q',revision:2,intent:'filter',requestedAt:0,inputVertices:1,candidateFeatures:1,estimatedBytes:10,inputWkid:3857,distanceMeters:null })
    expect(projection.snapshot().revision).toBe(7)
    expect(analysis.snapshot().revisionWatermark.m).toBe(2)
  })
  it('expires resources without cross-policy coupling', () => {
    const projection = new ArcGisProjectionLifecyclePolicy(projectionBudget)
    const scene = new ArcGisSceneAssetLifecyclePolicy(sceneBudget)
    projection.admit({ requestId:'p',revision:1,requestedAt:0,sourceWkid:4326,targetWkid:3857,pointCount:1,estimatedBytes:10 })
    scene.admit({ viewId:'s',assetId:'m',revision:1,kind:'mesh',intent:'prefetch',requestedAt:0,lod:1,estimatedGpuBytes:10,estimatedCpuBytes:10,estimatedTriangles:10 })
    expect(projection.expire(101)).toBe(1)
    expect(scene.expire(101)).toBe(1)
  })
  it('fails closed independently after disposal', () => {
    const projection = new ArcGisProjectionLifecyclePolicy(projectionBudget)
    const scene = new ArcGisSceneAssetLifecyclePolicy(sceneBudget)
    projection.dispose()
    expect(() => projection.snapshot()).toThrow('disposed')
    expect(scene.snapshot().assets).toBe(0)
  })
})
