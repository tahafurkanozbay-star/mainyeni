import{describe,expect,it}from'vitest'
import{ArcGisLodPolicy}from'./ArcGisLodPolicy'
const budget={maxBands:8,maxFeatures:10000,maxVertices:100000,maxGpuBytes:1000000,maxClusterRadius:128}
const bands=[{id:'overview',minScale:100000,maxScale:10000,mode:'cluster' as const,maxFeatures:1000,maxVertices:10000,maxGpuBytes:100000,clusterRadius:48},{id:'detail',minScale:9999,maxScale:0,mode:'detail' as const,maxFeatures:5000,maxVertices:50000,maxGpuBytes:500000}]
describe('ArcGisLodPolicy',()=>{
 it('selects deterministic bands using ArcGIS scale semantics',()=>{const policy=new ArcGisLodPolicy(bands,budget);expect(policy.decide(50000,'2d')).toMatchObject({bandId:'overview',mode:'cluster',clusterRadius:48});expect(policy.decide(5000,'3d')).toMatchObject({bandId:'detail',mode:'detail',viewMode:'3d'})})
 it('fails closed outside configured ranges',()=>{const policy=new ArcGisLodPolicy([{...bands[0],minScale:100000,maxScale:50000}],budget);expect(policy.decide(200000,'2d').mode).toBe('hidden')})
 it('rejects duplicate identifiers',()=>{expect(()=>new ArcGisLodPolicy([bands[0],bands[0]],budget)).toThrow('duplicate LOD band id')})
 it('rejects inverted ArcGIS scale ranges',()=>{expect(()=>new ArcGisLodPolicy([{...bands[0],minScale:100,maxScale:1000}],budget)).toThrow('invalid ArcGIS scale range')})
 it('requires cluster radius for clustered rendering',()=>{expect(()=>new ArcGisLodPolicy([{...bands[0],clusterRadius:0}],budget)).toThrow('cluster radius required')})
 it('requires hidden bands to consume no resources',()=>{expect(()=>new ArcGisLodPolicy([{...bands[0],mode:'hidden',clusterRadius:0}],budget)).toThrow('hidden band must have zero resource budgets')})
 it('rejects overlapping scale bands',()=>{expect(()=>new ArcGisLodPolicy([{...bands[0]},{...bands[1],id:'overlap',minScale:20000,maxScale:0}],budget)).toThrow('overlapping LOD bands')})
 it('returns immutable policy snapshots',()=>{const policy=new ArcGisLodPolicy(bands,budget);expect(Object.isFrozen(policy.snapshot())).toBe(true);expect(Object.isFrozen(policy.snapshot()[0])).toBe(true)})
 it('bounds policy cardinality',()=>{expect(()=>new ArcGisLodPolicy(bands,{...budget,maxBands:1})).toThrow('LOD band budget exceeded')})
 it('bounds feature budgets',()=>{expect(()=>new ArcGisLodPolicy([{...bands[0],maxFeatures:10001}],budget)).toThrow('maxFeatures')})
 it('rejects invalid view modes at runtime',()=>{const policy=new ArcGisLodPolicy(bands,budget);expect(()=>policy.decide(5000,'4d' as never)).toThrow('invalid view mode')})
 it('rejects non-finite scale',()=>{const policy=new ArcGisLodPolicy(bands,budget);expect(()=>policy.decide(Number.NaN,'2d')).toThrow('scale must be finite')})
})
