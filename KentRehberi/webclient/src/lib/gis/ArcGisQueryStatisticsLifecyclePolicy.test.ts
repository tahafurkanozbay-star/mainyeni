import { describe, expect, it } from 'vitest'
import { ArcGisQueryStatisticsLifecyclePolicy, type QueryStatisticsBudget } from './ArcGisQueryStatisticsLifecyclePolicy'

const budget: QueryStatisticsBudget = {
  maxLayers: 3, maxPlans: 3, maxPlansPerLayer: 2, maxStatisticsPerPlan: 3,
  maxGroupFieldsPerPlan: 2, maxResidentStatisticRefs: 5, maxResidentGroupFieldRefs: 3,
  maxIdentifierBytes: 96, planTtlMs: 100,
}
const stats = [{ fieldName: 'POPULATION', statisticType: 'sum' as const, outputName: 'population_sum' }]

function policy() { const value = new ArcGisQueryStatisticsLifecyclePolicy(budget); expect(value.setRevision('layer-a', 1)).toBe(0); return value }

describe('ArcGisQueryStatisticsLifecyclePolicy', () => {
  it('invalidates stale plans on monotonic revision advance', () => {
    const value=policy(); expect(value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['DISTRICT'],createdAt:0})).not.toBeNull()
    expect(value.setRevision('layer-a',2)).toBe(1); expect(value.setRevision('layer-a',1)).toBe(-1); expect(value.snapshot().plans).toBe(0)
  })
  it('deduplicates identical logical statistics plans', () => {
    const value=policy(); expect(value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['DISTRICT'],createdAt:0})).not.toBeNull()
    expect(value.admit({planId:'p2',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['DISTRICT'],createdAt:1})).toBeNull()
  })
  it('rejects unsafe identifiers and duplicate output names', () => {
    const value=policy()
    expect(()=>value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:[{fieldName:'POP;DROP',statisticType:'sum',outputName:'x'}],groupByFields:[],createdAt:0})).toThrow()
    expect(()=>value.admit({planId:'p2',layerId:'layer-a',revision:1,intent:'visible',statistics:[{fieldName:'A',statisticType:'sum',outputName:'same'},{fieldName:'B',statisticType:'max',outputName:'SAME'}],groupByFields:[],createdAt:0})).toThrow('duplicate statistic outputName')
  })
  it('rejects duplicate group fields case-insensitively', () => {
    const value=policy(); expect(()=>value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['DISTRICT','district'],createdAt:0})).toThrow('duplicate group field')
  })
  it('enforces per-plan statistic and group budgets', () => {
    const value=policy(); const many=[...stats,{fieldName:'A',statisticType:'max' as const,outputName:'a'},{fieldName:'B',statisticType:'min' as const,outputName:'b'},{fieldName:'C',statisticType:'avg' as const,outputName:'c'}]
    expect(value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:many,groupByFields:[],createdAt:0})).toBeNull()
    expect(value.admit({planId:'p2',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['A','B','C'],createdAt:0})).toBeNull()
  })
  it('evicts lower-intent older work under global plan pressure', () => {
    const value=policy(); value.setRevision('layer-b',1); value.setRevision('layer-c',1)
    expect(value.admit({planId:'bg',layerId:'layer-a',revision:1,intent:'background',statistics:stats,groupByFields:[],createdAt:0})).not.toBeNull()
    expect(value.admit({planId:'vis',layerId:'layer-b',revision:1,intent:'visible',statistics:stats,groupByFields:[],createdAt:1})).not.toBeNull()
    expect(value.admit({planId:'int',layerId:'layer-c',revision:1,intent:'interactive',statistics:stats,groupByFields:[],createdAt:2})).not.toBeNull()
    expect(value.admit({planId:'new',layerId:'layer-a',revision:1,intent:'interactive',statistics:[{fieldName:'AREA',statisticType:'max',outputName:'area_max'}],groupByFields:[],createdAt:3})).not.toBeNull()
    expect(value.snapshot().plans).toBe(3); expect(value.release('bg')).toBe(false)
  })
  it('does not evict higher-intent work for background admission', () => {
    const value=new ArcGisQueryStatisticsLifecyclePolicy({...budget,maxPlans:1,maxPlansPerLayer:1}); value.setRevision('layer-a',1); value.setRevision('layer-b',1)
    expect(value.admit({planId:'int',layerId:'layer-a',revision:1,intent:'interactive',statistics:stats,groupByFields:[],createdAt:0})).not.toBeNull()
    expect(value.admit({planId:'bg',layerId:'layer-b',revision:1,intent:'background',statistics:stats,groupByFields:[],createdAt:1})).toBeNull()
  })
  it('expires at the exact TTL boundary and touch extends lease', () => {
    const value=policy(); value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:[],createdAt:10})
    expect(value.expire(109)).toBe(0); expect(value.touch('p1',1,109)).toBe(true); expect(value.expire(208)).toBe(0); expect(value.expire(209)).toBe(1)
  })
  it('releases a layer atomically with its revision authority', () => {
    const value=policy(); value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:[],createdAt:0})
    expect(value.releaseLayer('layer-a')).toBe(1); expect(value.snapshot()).toEqual({layers:0,plans:0,statisticRefs:0,groupFieldRefs:0,identifierBytes:0})
  })
  it('returns frozen detached scalar views', () => {
    const value=policy(); const view=value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['DISTRICT'],createdAt:0})!
    expect(Object.isFrozen(view)).toBe(true); expect(Object.isFrozen(value.snapshot())).toBe(true); expect(Object.keys(view)).not.toContain('statistics'); expect(Object.keys(view)).not.toContain('groupByFields')
  })
  it('produces deterministic payload-free fingerprints', () => {
    const value=policy(); value.admit({planId:'p1',layerId:'layer-a',revision:1,intent:'visible',statistics:stats,groupByFields:['DISTRICT'],createdAt:0})
    const fingerprint=value.fingerprint(); expect(fingerprint).toContain('POPULATION'); expect(fingerprint).toContain('sum'); expect(fingerprint).not.toContain('[object Object]')
  })
  it('becomes terminal after disposal', () => {
    const value=policy(); value.dispose(); value.dispose(); expect(()=>value.snapshot()).toThrow('disposed'); expect(()=>value.setRevision('layer-b',1)).toThrow('disposed')
  })
})
