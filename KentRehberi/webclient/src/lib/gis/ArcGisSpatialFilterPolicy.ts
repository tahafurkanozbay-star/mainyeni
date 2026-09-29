export type ArcGisSpatialRelationship = 'intersects' | 'contains' | 'within' | 'touches' | 'overlaps' | 'crosses' | 'disjoint'
export type ArcGisSpatialFilterGeometry =
  | Readonly<{ type: 'point'; x: number; y: number; wkid: number }>
  | Readonly<{ type: 'extent'; xmin: number; ymin: number; xmax: number; ymax: number; wkid: number }>
  | Readonly<{ type: 'polygon'; rings: readonly (readonly (readonly [number, number])[])[]; wkid: number }>

export interface ArcGisSpatialFilterRequest {
  readonly layerId: string
  readonly relationship: ArcGisSpatialRelationship
  readonly geometry: ArcGisSpatialFilterGeometry
  readonly revision: number
  readonly maxResults: number
  readonly returnGeometry: boolean
  readonly outFields: readonly string[]
}

export interface ArcGisSpatialFilterBudget {
  readonly maxRings: number
  readonly maxVertices: number
  readonly maxFields: number
  readonly maxFieldLength: number
  readonly maxResults: number
  readonly maxCoordinateAbs: number
  readonly maxEnvelopeArea: number
}

export interface ArcGisSpatialFilterPlan {
  readonly layerId: string
  readonly relationship: ArcGisSpatialRelationship
  readonly geometry: ArcGisSpatialFilterGeometry
  readonly revision: number
  readonly maxResults: number
  readonly returnGeometry: boolean
  readonly outFields: readonly string[]
  readonly vertexCount: number
  readonly envelope: Readonly<{ xmin: number; ymin: number; xmax: number; ymax: number }>
  readonly fingerprint: string
}

const WEB_MERCATOR = new Set([3857, 102100, 102113])
const RELATIONSHIPS = new Set<ArcGisSpatialRelationship>(['intersects','contains','within','touches','overlaps','crosses','disjoint'])
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/
const LAYER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function int(value:number,name:string,min:number,max:number):number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}-out-of-range`)
  return value
}
function finite(value:number,name:string,maxAbs:number):number {
  if (!Number.isFinite(value) || Math.abs(value) > maxAbs) throw new Error(`${name}-out-of-range`)
  return Object.is(value,-0) ? 0 : value
}
function wkid(value:number):number {
  const v=int(value,'wkid',1,999_999)
  return WEB_MERCATOR.has(v) ? 3857 : v
}
function area(e:{xmin:number;ymin:number;xmax:number;ymax:number}):number {
  return (e.xmax-e.xmin)*(e.ymax-e.ymin)
}
function freezeEnvelope(xmin:number,ymin:number,xmax:number,ymax:number) {
  return Object.freeze({xmin,ymin,xmax,ymax})
}
function canonicalFields(values:readonly string[],budget:Readonly<ArcGisSpatialFilterBudget>):readonly string[] {
  if (!Array.isArray(values) || values.length > budget.maxFields) throw new Error('field-cardinality-exceeded')
  const normalized=values.map((raw)=>{
    if (typeof raw !== 'string') throw new Error('invalid-field')
    const value=raw.trim()
    if (!value || value.length>budget.maxFieldLength || !FIELD.test(value)) throw new Error(`invalid-field:${value}`)
    return value
  })
  if (new Set(normalized).size!==normalized.length) throw new Error('duplicate-field')
  return Object.freeze([...normalized].sort((a,b)=>a.localeCompare(b,'en')))
}
function fingerprint(plan:Omit<ArcGisSpatialFilterPlan,'fingerprint'>):string {
  const g=plan.geometry
  let geometryPart:string
  if (g.type==='point') geometryPart=`p:${g.x}:${g.y}:${g.wkid}`
  else if (g.type==='extent') geometryPart=`e:${g.xmin}:${g.ymin}:${g.xmax}:${g.ymax}:${g.wkid}`
  else geometryPart=`g:${g.wkid}:${g.rings.map((ring)=>ring.map((p)=>`${p[0]},${p[1]}`).join(';')).join('/')}`
  return ['spatial-filter-v1',plan.layerId,plan.relationship,plan.revision,plan.maxResults,plan.returnGeometry?1:0,plan.outFields.join(','),plan.vertexCount,geometryPart].join('|')
}

/** Transport-independent admission authority for ArcGIS spatial filtering. */
export class ArcGisSpatialFilterPolicy {
  private readonly budget:Readonly<ArcGisSpatialFilterBudget>
  constructor(budget:ArcGisSpatialFilterBudget) {
    this.budget=Object.freeze({
      maxRings:int(budget.maxRings,'maxRings',1,10_000),
      maxVertices:int(budget.maxVertices,'maxVertices',1,1_000_000),
      maxFields:int(budget.maxFields,'maxFields',0,1_000),
      maxFieldLength:int(budget.maxFieldLength,'maxFieldLength',1,256),
      maxResults:int(budget.maxResults,'maxResults',1,1_000_000),
      maxCoordinateAbs:finite(budget.maxCoordinateAbs,'maxCoordinateAbs',Number.MAX_SAFE_INTEGER),
      maxEnvelopeArea:finite(budget.maxEnvelopeArea,'maxEnvelopeArea',Number.MAX_SAFE_INTEGER),
    })
    if (this.budget.maxCoordinateAbs<=0 || this.budget.maxEnvelopeArea<=0) throw new Error('spatial-budget-must-be-positive')
  }

  plan(request:ArcGisSpatialFilterRequest):ArcGisSpatialFilterPlan {
    if (!LAYER.test(request.layerId)) throw new Error('invalid-layer-id')
    if (!RELATIONSHIPS.has(request.relationship)) throw new Error('invalid-spatial-relationship')
    const revision=int(request.revision,'revision',0,Number.MAX_SAFE_INTEGER)
    const maxResults=int(request.maxResults,'maxResults',1,this.budget.maxResults)
    if (typeof request.returnGeometry!=='boolean') throw new Error('invalid-return-geometry')
    const outFields=canonicalFields(request.outFields,this.budget)
    const canonical=this.canonicalGeometry(request.geometry)
    if (area(canonical.envelope)>this.budget.maxEnvelopeArea) throw new Error('spatial-envelope-area-budget-exceeded')
    const partial=Object.freeze({
      layerId:request.layerId,
      relationship:request.relationship,
      geometry:canonical.geometry,
      revision,
      maxResults,
      returnGeometry:request.returnGeometry,
      outFields,
      vertexCount:canonical.vertexCount,
      envelope:canonical.envelope,
    })
    return Object.freeze({...partial,fingerprint:fingerprint(partial)})
  }

  assertRevision(plan:ArcGisSpatialFilterPlan,currentRevision:number):void {
    const revision=int(currentRevision,'currentRevision',0,Number.MAX_SAFE_INTEGER)
    if (plan.revision!==revision) throw new Error('stale-spatial-filter-revision')
  }

  private canonicalGeometry(input:ArcGisSpatialFilterGeometry):{geometry:ArcGisSpatialFilterGeometry;vertexCount:number;envelope:Readonly<{xmin:number;ymin:number;xmax:number;ymax:number}>} {
    if (!input || typeof input!=='object') throw new Error('invalid-spatial-geometry')
    const sr=wkid(input.wkid)
    const limit=this.budget.maxCoordinateAbs
    if (input.type==='point') {
      const x=finite(input.x,'x',limit),y=finite(input.y,'y',limit)
      return {geometry:Object.freeze({type:'point',x,y,wkid:sr}),vertexCount:1,envelope:freezeEnvelope(x,y,x,y)}
    }
    if (input.type==='extent') {
      const xmin=finite(input.xmin,'xmin',limit),ymin=finite(input.ymin,'ymin',limit)
      const xmax=finite(input.xmax,'xmax',limit),ymax=finite(input.ymax,'ymax',limit)
      if (xmin>xmax || ymin>ymax) throw new Error('invalid-spatial-extent-order')
      return {geometry:Object.freeze({type:'extent',xmin,ymin,xmax,ymax,wkid:sr}),vertexCount:4,envelope:freezeEnvelope(xmin,ymin,xmax,ymax)}
    }
    if (input.type!=='polygon') throw new Error('unsupported-spatial-geometry')
    if (!Array.isArray(input.rings) || input.rings.length===0 || input.rings.length>this.budget.maxRings) throw new Error('ring-cardinality-exceeded')
    let count=0,xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity
    const rings=input.rings.map((rawRing,index)=>{
      if (!Array.isArray(rawRing) || rawRing.length<4) throw new Error(`invalid-ring:${index}`)
      if (count>this.budget.maxVertices-rawRing.length) throw new Error('vertex-cardinality-exceeded')
      count+=rawRing.length
      const ring=rawRing.map((raw,vertexIndex)=>{
        if (!Array.isArray(raw) || raw.length!==2) throw new Error(`invalid-vertex:${index}:${vertexIndex}`)
        const x=finite(raw[0],'vertex-x',limit),y=finite(raw[1],'vertex-y',limit)
        xmin=Math.min(xmin,x);ymin=Math.min(ymin,y);xmax=Math.max(xmax,x);ymax=Math.max(ymax,y)
        return Object.freeze([x,y] as const)
      })
      const first=ring[0],last=ring[ring.length-1]
      if (first[0]!==last[0] || first[1]!==last[1]) throw new Error(`ring-not-closed:${index}`)
      let distinct=false
      for (let i=1;i<ring.length-1;i++) if (ring[i][0]!==first[0] || ring[i][1]!==first[1]) { distinct=true;break }
      if (!distinct) throw new Error(`degenerate-ring:${index}`)
      return Object.freeze(ring)
    })
    const envelope=freezeEnvelope(xmin,ymin,xmax,ymax)
    return {geometry:Object.freeze({type:'polygon',rings:Object.freeze(rings),wkid:sr}),vertexCount:count,envelope}
  }
}