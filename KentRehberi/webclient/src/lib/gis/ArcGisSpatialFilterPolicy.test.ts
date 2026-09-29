import { describe,expect,it } from 'vitest'
import { ArcGisSpatialFilterPolicy,type ArcGisSpatialFilterBudget } from './ArcGisSpatialFilterPolicy'

const budget:ArcGisSpatialFilterBudget={maxRings:4,maxVertices:32,maxFields:5,maxFieldLength:32,maxResults:500,maxCoordinateAbs:30_000_000,maxEnvelopeArea:1_000_000}
const policy=()=>new ArcGisSpatialFilterPolicy(budget)
const point=()=>({type:'point' as const,x:10,y:20,wkid:102100})

describe('ArcGisSpatialFilterPolicy',()=>{
  it('canonicalizes Web Mercator and fields deterministically',()=>{
    const plan=policy().plan({layerId:'poi.1',relationship:'intersects',geometry:point(),revision:3,maxResults:50,returnGeometry:false,outFields:['NAME','ID']})
    expect(plan.geometry).toEqual({type:'point',x:10,y:20,wkid:3857})
    expect(plan.outFields).toEqual(['ID','NAME'])
    expect(plan.vertexCount).toBe(1)
    expect(Object.isFrozen(plan)).toBe(true)
  })
  it('plans extents with immutable envelopes',()=>{
    const plan=policy().plan({layerId:'roads',relationship:'contains',geometry:{type:'extent',xmin:0,ymin:1,xmax:10,ymax:11,wkid:4326},revision:0,maxResults:1,returnGeometry:true,outFields:[]})
    expect(plan.envelope).toEqual({xmin:0,ymin:1,xmax:10,ymax:11})
    expect(Object.isFrozen(plan.envelope)).toBe(true)
  })
  it('plans closed polygon rings and counts vertices',()=>{
    const geometry={type:'polygon' as const,wkid:3857,rings:[[[0,0],[10,0],[10,10],[0,0]] as const]}
    const plan=policy().plan({layerId:'zones',relationship:'within',geometry,revision:1,maxResults:10,returnGeometry:true,outFields:['OBJECTID']})
    expect(plan.vertexCount).toBe(4)
    expect(plan.envelope).toEqual({xmin:0,ymin:0,xmax:10,ymax:10})
    expect(Object.isFrozen(plan.geometry)).toBe(true)
  })
  it('is fingerprint deterministic',()=>{
    const request={layerId:'a',relationship:'intersects' as const,geometry:point(),revision:1,maxResults:10,returnGeometry:false,outFields:['B','A']}
    expect(policy().plan(request).fingerprint).toBe(policy().plan(request).fingerprint)
  })
  it('makes revision fingerprint-sensitive',()=>{
    const base={layerId:'a',relationship:'intersects' as const,geometry:point(),maxResults:10,returnGeometry:false,outFields:[]}
    expect(policy().plan({...base,revision:1}).fingerprint).not.toBe(policy().plan({...base,revision:2}).fingerprint)
  })
  it('makes relationship fingerprint-sensitive',()=>{
    const base={layerId:'a',geometry:point(),revision:1,maxResults:10,returnGeometry:false,outFields:[]}
    expect(policy().plan({...base,relationship:'within'}).fingerprint).not.toBe(policy().plan({...base,relationship:'intersects'}).fingerprint)
  })
  it.each(['intersects','contains','within','touches','overlaps','crosses','disjoint'] as const)('admits relationship %s',(relationship)=>{
    expect(policy().plan({layerId:'a',relationship,geometry:point(),revision:0,maxResults:1,returnGeometry:false,outFields:[]}).relationship).toBe(relationship)
  })
  it('rejects invalid layer ids',()=>expect(()=>policy().plan({layerId:' bad',relationship:'intersects',geometry:point(),revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('invalid-layer-id'))
  it('rejects invalid relationships',()=>expect(()=>policy().plan({layerId:'a',relationship:'equals' as never,geometry:point(),revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('invalid-spatial-relationship'))
  it('rejects result budget overflow',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:point(),revision:0,maxResults:501,returnGeometry:false,outFields:[]})).toThrow('maxResults-out-of-range'))
  it('rejects coordinate overflow',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{...point(),x:30_000_001},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('x-out-of-range'))
  it('rejects non-finite coordinates',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{...point(),y:Infinity},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('y-out-of-range'))
  it('rejects reversed extents',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'extent',xmin:10,ymin:0,xmax:0,ymax:1,wkid:4326},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('invalid-spatial-extent-order'))
  it('rejects envelope area overflow',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'extent',xmin:0,ymin:0,xmax:2000,ymax:2000,wkid:4326},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('spatial-envelope-area-budget-exceeded'))
  it('rejects unclosed polygon rings',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'polygon',wkid:4326,rings:[[[0,0],[1,0],[1,1],[0,1]]]},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('ring-not-closed'))
  it('rejects degenerate polygon rings',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'polygon',wkid:4326,rings:[[[0,0],[0,0],[0,0],[0,0]]]},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('degenerate-ring'))
  it('rejects too-short rings',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'polygon',wkid:4326,rings:[[[0,0],[1,1],[0,0]]]},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('invalid-ring'))
  it('rejects ring cardinality overflow',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'polygon',wkid:4326,rings:Array.from({length:5},()=>[[0,0],[1,0],[1,1],[0,0]])},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('ring-cardinality-exceeded'))
  it('rejects vertex cardinality overflow',()=>{
    const ring=[...Array.from({length:32},(_,i)=>[i,0] as [number,number]),[0,0] as [number,number]]
    expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:{type:'polygon',wkid:4326,rings:[ring]},revision:0,maxResults:1,returnGeometry:false,outFields:[]})).toThrow('vertex-cardinality-exceeded')
  })
  it('rejects duplicate fields',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:point(),revision:0,maxResults:1,returnGeometry:false,outFields:['ID','ID']})).toThrow('duplicate-field'))
  it('rejects malformed fields',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:point(),revision:0,maxResults:1,returnGeometry:false,outFields:['a b']})).toThrow('invalid-field'))
  it('rejects field cardinality overflow',()=>expect(()=>policy().plan({layerId:'a',relationship:'intersects',geometry:point(),revision:0,maxResults:1,returnGeometry:false,outFields:['A','B','C','D','E','F']})).toThrow('field-cardinality-exceeded'))
  it('rejects stale revisions',()=>{
    const plan=policy().plan({layerId:'a',relationship:'intersects',geometry:point(),revision:2,maxResults:1,returnGeometry:false,outFields:[]})
    expect(()=>policy().assertRevision(plan,3)).toThrow('stale-spatial-filter-revision')
  })
  it('accepts matching revisions',()=>{
    const p=policy();const plan=p.plan({layerId:'a',relationship:'intersects',geometry:point(),revision:2,maxResults:1,returnGeometry:false,outFields:[]})
    expect(()=>p.assertRevision(plan,2)).not.toThrow()
  })
  it('validates constructor cardinality budgets',()=>expect(()=>new ArcGisSpatialFilterPolicy({...budget,maxVertices:0})).toThrow('maxVertices-out-of-range'))
  it('validates constructor spatial budgets',()=>expect(()=>new ArcGisSpatialFilterPolicy({...budget,maxEnvelopeArea:0})).toThrow('spatial-budget-must-be-positive'))
})