export type ArcGisGeometryType='point'|'multipoint'|'polyline'|'polygon'|'envelope'
export type ArcGisSpatialRelationship='intersects'|'contains'|'within'|'touches'|'crosses'|'overlaps'|'envelope-intersects'|'index-intersects'
export type ArcGisOrderDirection='asc'|'desc'

export interface ArcGisQueryServiceFacts {
  readonly supportsQuery:boolean
  readonly supportsPagination:boolean
  readonly supportsOrderBy:boolean
  readonly supportsDistinct:boolean
  readonly supportsStatistics:boolean
  readonly supportsGeometry:boolean
  readonly supportsReturningGeometryCentroid:boolean
  readonly maxRecordCount:number
  readonly objectIdField?:string
  readonly globalIdField?:string
  readonly fields:readonly string[]
}

export interface ArcGisQueryContractBudget {
  readonly maxWhereLength:number
  readonly maxOutFields:number
  readonly maxOrderByFields:number
  readonly maxGroupByFields:number
  readonly maxResultRecordCount:number
  readonly maxResultOffset:number
  readonly maxGeometryJsonBytes:number
  readonly maxStatistics:number
}

export interface ArcGisOrderByClause { readonly field:string; readonly direction:ArcGisOrderDirection }
export interface ArcGisStatisticClause { readonly field:string; readonly statistic:'count'|'sum'|'min'|'max'|'avg'|'stddev'|'var'; readonly outFieldName:string }
export interface ArcGisGeometryFilter { readonly geometryType:ArcGisGeometryType; readonly spatialRelationship:ArcGisSpatialRelationship; readonly geometryJson:string; readonly inWkid?:number }
export interface ArcGisQueryRequest {
  readonly where?:string
  readonly outFields?:readonly string[]
  readonly orderBy?:readonly ArcGisOrderByClause[]
  readonly groupBy?:readonly string[]
  readonly statistics?:readonly ArcGisStatisticClause[]
  readonly geometry?:ArcGisGeometryFilter
  readonly returnGeometry?:boolean
  readonly returnCentroid?:boolean
  readonly returnDistinctValues?:boolean
  readonly resultOffset?:number
  readonly resultRecordCount?:number
}
export interface ArcGisNormalizedQuery {
  readonly where:string
  readonly outFields:readonly string[]
  readonly orderBy:readonly ArcGisOrderByClause[]
  readonly groupBy:readonly string[]
  readonly statistics:readonly ArcGisStatisticClause[]
  readonly geometry?:ArcGisGeometryFilter
  readonly returnGeometry:boolean
  readonly returnCentroid:boolean
  readonly returnDistinctValues:boolean
  readonly resultOffset:number
  readonly resultRecordCount:number
  readonly stableKey:string
}
export type ArcGisQueryAdmission={readonly accepted:true;readonly query:ArcGisNormalizedQuery}|{readonly accepted:false;readonly reason:string}

const FIELD=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const OUT_ALIAS=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const CONTROL=/[\u0000-\u001f\u007f]/
const MAX_RECORDS=100_000
const MAX_OFFSET=10_000_000
const MAX_GEOMETRY_BYTES=8*1024*1024

function integer(value:number,name:string,min:number,max:number){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer in [${min}, ${max}]`);return value}
function identifier(value:string,name:string,pattern=FIELD){const normalized=value.trim();if(!pattern.test(normalized))throw new Error(`invalid ${name}:${normalized}`);return normalized}
function unique<T>(items:readonly T[],key:(value:T)=>string,name:string){const seen=new Set<string>();for(const item of items){const k=key(item).toLocaleLowerCase('en-US');if(seen.has(k))throw new Error(`duplicate ${name}:${k}`);seen.add(k)}}
function stableString(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(stableString).join(',')}]`;const object=value as Record<string,unknown>;return `{${Object.keys(object).sort().map(k=>`${JSON.stringify(k)}:${stableString(object[k])}`).join(',')}}`}

export class ArcGisQueryContractPolicy {
  private readonly service:ArcGisQueryServiceFacts
  private readonly budget:ArcGisQueryContractBudget
  private readonly fields:Map<string,string>
  constructor(service:ArcGisQueryServiceFacts,budget:ArcGisQueryContractBudget){
    const maxRecordCount=integer(service.maxRecordCount,'maxRecordCount',1,MAX_RECORDS)
    const normalizedFields=service.fields.map(field=>identifier(field,'service field'))
    unique(normalizedFields,v=>v,'service field')
    this.fields=new Map(normalizedFields.map(field=>[field.toLocaleLowerCase('en-US'),field]))
    const objectIdField=service.objectIdField===undefined?undefined:this.resolveKnownField(service.objectIdField,'objectIdField')
    const globalIdField=service.globalIdField===undefined?undefined:this.resolveKnownField(service.globalIdField,'globalIdField')
    this.service=Object.freeze({...service,maxRecordCount,fields:Object.freeze(normalizedFields),objectIdField,globalIdField})
    this.budget=Object.freeze({
      maxWhereLength:integer(budget.maxWhereLength,'maxWhereLength',1,100_000),
      maxOutFields:integer(budget.maxOutFields,'maxOutFields',1,10_000),
      maxOrderByFields:integer(budget.maxOrderByFields,'maxOrderByFields',0,100),
      maxGroupByFields:integer(budget.maxGroupByFields,'maxGroupByFields',0,100),
      maxResultRecordCount:integer(budget.maxResultRecordCount,'maxResultRecordCount',1,MAX_RECORDS),
      maxResultOffset:integer(budget.maxResultOffset,'maxResultOffset',0,MAX_OFFSET),
      maxGeometryJsonBytes:integer(budget.maxGeometryJsonBytes,'maxGeometryJsonBytes',1,MAX_GEOMETRY_BYTES),
      maxStatistics:integer(budget.maxStatistics,'maxStatistics',0,100),
    })
  }
  admit(request:ArcGisQueryRequest):ArcGisQueryAdmission{
    if(!this.service.supportsQuery)return Object.freeze({accepted:false,reason:'service-does-not-support-query'})
    try{return Object.freeze({accepted:true,query:this.normalize(request)})}catch(error){return Object.freeze({accepted:false,reason:error instanceof Error?error.message:'invalid-query'})}
  }
  private normalize(request:ArcGisQueryRequest):ArcGisNormalizedQuery{
    const where=this.normalizeWhere(request.where)
    const outFields=this.normalizeOutFields(request.outFields)
    const orderBy=this.normalizeOrderBy(request.orderBy)
    const groupBy=this.normalizeGroupBy(request.groupBy)
    const statistics=this.normalizeStatistics(request.statistics)
    const geometry=this.normalizeGeometry(request.geometry)
    const returnGeometry=request.returnGeometry===true
    const returnCentroid=request.returnCentroid===true
    const returnDistinctValues=request.returnDistinctValues===true
    const resultOffset=integer(request.resultOffset??0,'resultOffset',0,this.budget.maxResultOffset)
    const recordLimit=Math.min(this.service.maxRecordCount,this.budget.maxResultRecordCount)
    const resultRecordCount=integer(request.resultRecordCount??recordLimit,'resultRecordCount',1,recordLimit)
    if(resultOffset>0&&!this.service.supportsPagination)throw new Error('pagination-unsupported')
    if(resultRecordCount!==recordLimit&&!this.service.supportsPagination)throw new Error('pagination-unsupported')
    if(orderBy.length&&!this.service.supportsOrderBy)throw new Error('order-by-unsupported')
    if(returnDistinctValues&&!this.service.supportsDistinct)throw new Error('distinct-unsupported')
    if((statistics.length||groupBy.length)&&!this.service.supportsStatistics)throw new Error('statistics-unsupported')
    if(geometry&&!this.service.supportsGeometry)throw new Error('geometry-query-unsupported')
    if(returnCentroid&&!this.service.supportsReturningGeometryCentroid)throw new Error('centroid-unsupported')
    if(returnCentroid&&!returnGeometry)throw new Error('centroid-requires-return-geometry')
    if(returnDistinctValues&&(statistics.length||groupBy.length))throw new Error('distinct-cannot-combine-with-statistics')
    if(groupBy.length&&!statistics.length)throw new Error('group-by-requires-statistics')
    const core={where,outFields,orderBy,groupBy,statistics,geometry,returnGeometry,returnCentroid,returnDistinctValues,resultOffset,resultRecordCount}
    return Object.freeze({...core,outFields:Object.freeze(outFields),orderBy:Object.freeze(orderBy),groupBy:Object.freeze(groupBy),statistics:Object.freeze(statistics),stableKey:stableString(core)})
  }
  private normalizeWhere(value:string|undefined){const where=(value??'1=1').trim();if(!where)throw new Error('where-empty');if(where.length>this.budget.maxWhereLength)throw new Error('where-length-budget-exceeded');if(CONTROL.test(where))throw new Error('where-contains-control-character');return where}
  private normalizeOutFields(values:readonly string[]|undefined){const source=values??(this.service.objectIdField?[this.service.objectIdField]:[]);if(source.length>this.budget.maxOutFields)throw new Error('out-field-budget-exceeded');const fields=source.map(field=>this.resolveKnownField(field,'out field'));unique(fields,v=>v,'out field');return fields}
  private normalizeOrderBy(values:readonly ArcGisOrderByClause[]|undefined){const source=values??[];if(source.length>this.budget.maxOrderByFields)throw new Error('order-by-budget-exceeded');const result=source.map(item=>Object.freeze({field:this.resolveKnownField(item.field,'order field'),direction:item.direction}));for(const item of result)if(item.direction!=='asc'&&item.direction!=='desc')throw new Error('invalid-order-direction');unique(result,v=>v.field,'order field');return result}
  private normalizeGroupBy(values:readonly string[]|undefined){const source=values??[];if(source.length>this.budget.maxGroupByFields)throw new Error('group-by-budget-exceeded');const result=source.map(field=>this.resolveKnownField(field,'group field'));unique(result,v=>v,'group field');return result}
  private normalizeStatistics(values:readonly ArcGisStatisticClause[]|undefined){const source=values??[];if(source.length>this.budget.maxStatistics)throw new Error('statistics-budget-exceeded');const allowed=new Set(['count','sum','min','max','avg','stddev','var']);const result=source.map(item=>{if(!allowed.has(item.statistic))throw new Error('invalid-statistic');return Object.freeze({field:this.resolveKnownField(item.field,'statistic field'),statistic:item.statistic,outFieldName:identifier(item.outFieldName,'statistic output',OUT_ALIAS)})});unique(result,v=>v.outFieldName,'statistic output');return result}
  private normalizeGeometry(value:ArcGisGeometryFilter|undefined){if(value===undefined)return undefined;const geometryType=value.geometryType;if(!['point','multipoint','polyline','polygon','envelope'].includes(geometryType))throw new Error('invalid-geometry-type');if(!['intersects','contains','within','touches','crosses','overlaps','envelope-intersects','index-intersects'].includes(value.spatialRelationship))throw new Error('invalid-spatial-relationship');const geometryJson=value.geometryJson.trim();if(!geometryJson||CONTROL.test(geometryJson))throw new Error('invalid-geometry-json');if(new TextEncoder().encode(geometryJson).byteLength>this.budget.maxGeometryJsonBytes)throw new Error('geometry-json-budget-exceeded');let parsed:unknown;try{parsed=JSON.parse(geometryJson)}catch{throw new Error('geometry-json-malformed')}if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('geometry-json-must-be-object');const inWkid=value.inWkid===undefined?undefined:integer(value.inWkid,'inWkid',1,999999);return Object.freeze({...value,geometryType,geometryJson,inWkid})}
  private resolveKnownField(value:string,name:string){const normalized=identifier(value,name);const canonical=this.fields.get(normalized.toLocaleLowerCase('en-US'));if(!canonical)throw new Error(`unknown ${name}:${normalized}`);return canonical}
}
