export type ArcGisQueryExecutionMode='object-id-chunks'|'offset-pages'|'single-page'
export interface ArcGisQueryExecutionCapabilities{readonly supportsQuery:boolean;readonly supportsPagination:boolean;readonly supportsOrderBy:boolean;readonly supportsObjectIds:boolean;readonly maxRecordCount:number;readonly objectIdField?:string}
export interface ArcGisQueryExecutionBudget{readonly maxPages:number;readonly maxFeatures:number;readonly maxObjectIdsPerChunk:number;readonly maxConcurrentRequests:number;readonly maxRetriesPerRequest:number;readonly maxEstimatedResponseBytes:number;readonly estimatedBytesPerFeature:number}
export interface ArcGisQueryExecutionIntent{readonly requestedFeatures:number;readonly preferredPageSize?:number;readonly knownObjectIds?:readonly number[];readonly requireStableOrdering?:boolean}
export interface ArcGisQueryPage{readonly index:number;readonly offset:number;readonly limit:number;readonly objectIds?:readonly number[];readonly orderByObjectId:boolean;readonly retryBudget:number;readonly estimatedResponseBytes:number;readonly stableKey:string}
export interface ArcGisQueryExecutionPlan{readonly mode:ArcGisQueryExecutionMode;readonly requestedFeatures:number;readonly plannedFeatures:number;readonly concurrency:number;readonly pages:readonly ArcGisQueryPage[];readonly estimatedResponseBytes:number;readonly truncated:boolean;readonly stableKey:string}
export type ArcGisQueryExecutionAdmission={readonly accepted:true;readonly plan:ArcGisQueryExecutionPlan}|{readonly accepted:false;readonly reason:string}

const MAX_RECORDS=100_000
const MAX_PAGES=10_000
const MAX_CONCURRENCY=32
const MAX_RETRIES=10
const MAX_BYTES=512*1024*1024
const FIELD=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/
function integer(value:number,name:string,min:number,max:number){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name} must be an integer in [${min}, ${max}]`);return value}
function stable(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;const object=value as Record<string,unknown>;return `{${Object.keys(object).sort().map(key=>`${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`}
function checkedProduct(a:number,b:number,name:string){const value=a*b;if(!Number.isSafeInteger(value)||value>MAX_BYTES)throw new Error(`${name}-budget-exceeded`);return value}
function normalizeObjectIds(values:readonly number[]|undefined){if(values===undefined)return undefined;const result:number[]=[];let previous=-1;for(const value of [...values].sort((a,b)=>a-b)){integer(value,'objectId',0,Number.MAX_SAFE_INTEGER);if(value===previous)continue;result.push(value);previous=value}return Object.freeze(result)}

/**
 * Transport-independent execution planner for ArcGIS REST query windows.
 * It deliberately does not perform network I/O. Callers execute the immutable
 * plan through the existing same-origin service adapter, preserving one
 * authoritative transport while gaining bounded pagination/chunking semantics.
 */
export class ArcGisQueryExecutionPlanner{
 private readonly capabilities:Readonly<ArcGisQueryExecutionCapabilities>
 private readonly budget:Readonly<ArcGisQueryExecutionBudget>
 constructor(capabilities:ArcGisQueryExecutionCapabilities,budget:ArcGisQueryExecutionBudget){
  const maxRecordCount=integer(capabilities.maxRecordCount,'maxRecordCount',1,MAX_RECORDS)
  const objectIdField=capabilities.objectIdField?.trim()
  if(objectIdField!==undefined&&!FIELD.test(objectIdField))throw new Error('invalid-object-id-field')
  this.capabilities=Object.freeze({...capabilities,maxRecordCount,objectIdField})
  this.budget=Object.freeze({
   maxPages:integer(budget.maxPages,'maxPages',1,MAX_PAGES),
   maxFeatures:integer(budget.maxFeatures,'maxFeatures',1,MAX_RECORDS),
   maxObjectIdsPerChunk:integer(budget.maxObjectIdsPerChunk,'maxObjectIdsPerChunk',1,MAX_RECORDS),
   maxConcurrentRequests:integer(budget.maxConcurrentRequests,'maxConcurrentRequests',1,MAX_CONCURRENCY),
   maxRetriesPerRequest:integer(budget.maxRetriesPerRequest,'maxRetriesPerRequest',0,MAX_RETRIES),
   maxEstimatedResponseBytes:integer(budget.maxEstimatedResponseBytes,'maxEstimatedResponseBytes',1,MAX_BYTES),
   estimatedBytesPerFeature:integer(budget.estimatedBytesPerFeature,'estimatedBytesPerFeature',1,1024*1024),
  })
 }
 admit(intent:ArcGisQueryExecutionIntent):ArcGisQueryExecutionAdmission{
  if(!this.capabilities.supportsQuery)return Object.freeze({accepted:false,reason:'service-does-not-support-query'})
  try{return Object.freeze({accepted:true,plan:this.plan(intent)})}catch(error){return Object.freeze({accepted:false,reason:error instanceof Error?error.message:'invalid-query-execution-intent'})}
 }
 private plan(intent:ArcGisQueryExecutionIntent):ArcGisQueryExecutionPlan{
  const requestedFeatures=integer(intent.requestedFeatures,'requestedFeatures',1,MAX_RECORDS)
  const targetFeatures=Math.min(requestedFeatures,this.budget.maxFeatures)
  const knownObjectIds=normalizeObjectIds(intent.knownObjectIds)
  if(knownObjectIds!==undefined&&knownObjectIds.length===0)throw new Error('known-object-ids-empty')
  if(knownObjectIds!==undefined)return this.planObjectIds(requestedFeatures,targetFeatures,knownObjectIds)
  return this.planWindowed(requestedFeatures,targetFeatures,intent.preferredPageSize,intent.requireStableOrdering===true)
 }
 private planObjectIds(requestedFeatures:number,targetFeatures:number,ids:readonly number[]):ArcGisQueryExecutionPlan{
  if(!this.capabilities.supportsObjectIds)throw new Error('object-id-query-unsupported')
  if(!this.capabilities.objectIdField)throw new Error('object-id-field-required')
  const admitted=ids.slice(0,targetFeatures)
  const chunkSize=Math.min(this.capabilities.maxRecordCount,this.budget.maxObjectIdsPerChunk)
  const pageCount=Math.ceil(admitted.length/chunkSize)
  if(pageCount>this.budget.maxPages)throw new Error('page-budget-exceeded')
  const pages:ArcGisQueryPage[]=[]
  let totalBytes=0
  for(let index=0;index<pageCount;index++){
   const objectIds=Object.freeze(admitted.slice(index*chunkSize,(index+1)*chunkSize))
   const estimatedResponseBytes=checkedProduct(objectIds.length,this.budget.estimatedBytesPerFeature,'response-bytes')
   totalBytes+=estimatedResponseBytes
   if(totalBytes>this.budget.maxEstimatedResponseBytes)throw new Error('response-bytes-budget-exceeded')
   const core={index,offset:0,limit:objectIds.length,objectIds,orderByObjectId:false,retryBudget:this.budget.maxRetriesPerRequest,estimatedResponseBytes}
   pages.push(Object.freeze({...core,stableKey:stable(core)}))
  }
  return this.finish('object-id-chunks',requestedFeatures,admitted.length,pages,requestedFeatures>admitted.length||ids.length>admitted.length)
 }
 private planWindowed(requestedFeatures:number,targetFeatures:number,preferredPageSize:number|undefined,requireStableOrdering:boolean):ArcGisQueryExecutionPlan{
  const pageSize=preferredPageSize===undefined?this.capabilities.maxRecordCount:integer(preferredPageSize,'preferredPageSize',1,this.capabilities.maxRecordCount)
  const pageCount=Math.ceil(targetFeatures/pageSize)
  if(pageCount>1&&!this.capabilities.supportsPagination)throw new Error('pagination-required')
  if(pageCount>this.budget.maxPages)throw new Error('page-budget-exceeded')
  const orderByObjectId=pageCount>1||requireStableOrdering
  if(orderByObjectId&&!this.capabilities.objectIdField)throw new Error('stable-object-id-field-required')
  if(orderByObjectId&&!this.capabilities.supportsOrderBy)throw new Error('stable-ordering-unsupported')
  const pages:ArcGisQueryPage[]=[]
  let remaining=targetFeatures,totalBytes=0
  for(let index=0;index<pageCount;index++){
   const limit=Math.min(pageSize,remaining)
   const offset=index*pageSize
   const estimatedResponseBytes=checkedProduct(limit,this.budget.estimatedBytesPerFeature,'response-bytes')
   totalBytes+=estimatedResponseBytes
   if(totalBytes>this.budget.maxEstimatedResponseBytes)throw new Error('response-bytes-budget-exceeded')
   const core={index,offset,limit,orderByObjectId,retryBudget:this.budget.maxRetriesPerRequest,estimatedResponseBytes}
   pages.push(Object.freeze({...core,stableKey:stable(core)}));remaining-=limit
  }
  return this.finish(pageCount===1?'single-page':'offset-pages',requestedFeatures,targetFeatures,pages,requestedFeatures>targetFeatures)
 }
 private finish(mode:ArcGisQueryExecutionMode,requestedFeatures:number,plannedFeatures:number,pages:readonly ArcGisQueryPage[],truncated:boolean):ArcGisQueryExecutionPlan{
  const estimatedResponseBytes=pages.reduce((sum,page)=>sum+page.estimatedResponseBytes,0)
  const concurrency=Math.min(this.budget.maxConcurrentRequests,pages.length)
  const frozenPages=Object.freeze([...pages])
  const core={mode,requestedFeatures,plannedFeatures,concurrency,pages:frozenPages,estimatedResponseBytes,truncated}
  return Object.freeze({...core,stableKey:stable(core)})
 }
}