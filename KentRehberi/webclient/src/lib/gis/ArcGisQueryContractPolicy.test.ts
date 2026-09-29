import{describe,expect,it}from'vitest'
import{ArcGisQueryContractPolicy,type ArcGisQueryServiceFacts}from'./ArcGisQueryContractPolicy'

const service:ArcGisQueryServiceFacts={supportsQuery:true,supportsPagination:true,supportsOrderBy:true,supportsDistinct:true,supportsStatistics:true,supportsGeometry:true,supportsReturningGeometryCentroid:true,maxRecordCount:2000,objectIdField:'OBJECTID',globalIdField:'GlobalID',fields:['OBJECTID','GlobalID','Name','Category','Population']}
const budget={maxWhereLength:1000,maxOutFields:10,maxOrderByFields:3,maxGroupByFields:3,maxResultRecordCount:500,maxResultOffset:5000,maxGeometryJsonBytes:2000,maxStatistics:3}
const policy=(overrides:Partial<ArcGisQueryServiceFacts>={})=>new ArcGisQueryContractPolicy({...service,...overrides},budget)

describe('ArcGisQueryContractPolicy',()=>{
 it('normalizes a bounded query and clamps the default record count to policy budget',()=>{const result=policy().admit({outFields:['name','OBJECTID'],where:' Category = 1 '});expect(result.accepted).toBe(true);if(result.accepted){expect(result.query.outFields).toEqual(['Name','OBJECTID']);expect(result.query.where).toBe('Category = 1');expect(result.query.resultRecordCount).toBe(500)}})
 it('produces deterministic stable keys for equivalent normalized requests',()=>{const a=policy().admit({outFields:['Name'],where:'1=1'});const b=policy().admit({where:' 1=1 ',outFields:['name']});expect(a.accepted&&b.accepted&&a.query.stableKey===b.query.stableKey).toBe(true)})
 it('fails closed when query is unsupported',()=>{expect(policy({supportsQuery:false}).admit({}).accepted).toBe(false)})
 it('rejects unknown output fields',()=>{expect(policy().admit({outFields:['Password'] })).toMatchObject({accepted:false,reason:'unknown out field:Password'})})
 it('rejects duplicate fields case-insensitively',()=>{expect(policy().admit({outFields:['Name','name']})).toMatchObject({accepted:false,reason:'duplicate out field:name'})})
 it('rejects control characters and oversized where clauses',()=>{expect(policy().admit({where:'x=1\nOR y=2'}).accepted).toBe(false);expect(policy().admit({where:'x'.repeat(1001)})).toMatchObject({accepted:false,reason:'where-length-budget-exceeded'})})
 it('requires pagination capability for offsets',()=>{expect(policy({supportsPagination:false}).admit({resultOffset:1})).toMatchObject({accepted:false,reason:'pagination-unsupported'})})
 it('requires pagination capability for explicit partial result windows',()=>{expect(policy({supportsPagination:false}).admit({resultRecordCount:10})).toMatchObject({accepted:false,reason:'pagination-unsupported'})})
 it('rejects record windows beyond service and local budgets',()=>{expect(policy().admit({resultRecordCount:501})).toMatchObject({accepted:false,reason:'resultRecordCount must be an integer in [1, 500]'})})
 it('requires order-by capability',()=>{expect(policy({supportsOrderBy:false}).admit({orderBy:[{field:'Name',direction:'asc'}]})).toMatchObject({accepted:false,reason:'order-by-unsupported'})})
 it('canonicalizes order-by field identity',()=>{const result=policy().admit({orderBy:[{field:'name',direction:'desc'}]});expect(result.accepted&&result.query.orderBy[0]).toEqual({field:'Name',direction:'desc'})})
 it('rejects duplicate order-by fields',()=>{expect(policy().admit({orderBy:[{field:'Name',direction:'asc'},{field:'name',direction:'desc'}]}).accepted).toBe(false)})
 it('requires distinct capability',()=>{expect(policy({supportsDistinct:false}).admit({returnDistinctValues:true})).toMatchObject({accepted:false,reason:'distinct-unsupported'})})
 it('rejects distinct combined with statistics',()=>{expect(policy().admit({returnDistinctValues:true,statistics:[{field:'Population',statistic:'sum',outFieldName:'total'}]})).toMatchObject({accepted:false,reason:'distinct-cannot-combine-with-statistics'})})
 it('requires statistics capability for statistics',()=>{expect(policy({supportsStatistics:false}).admit({statistics:[{field:'Population',statistic:'avg',outFieldName:'average'}]})).toMatchObject({accepted:false,reason:'statistics-unsupported'})})
 it('requires statistics capability for group-by',()=>{expect(policy({supportsStatistics:false}).admit({groupBy:['Category'],statistics:[{field:'Population',statistic:'sum',outFieldName:'total'}]})).toMatchObject({accepted:false,reason:'statistics-unsupported'})})
 it('requires statistics when grouping',()=>{expect(policy().admit({groupBy:['Category']})).toMatchObject({accepted:false,reason:'group-by-requires-statistics'})})
 it('rejects duplicate statistic aliases',()=>{expect(policy().admit({statistics:[{field:'Population',statistic:'sum',outFieldName:'total'},{field:'OBJECTID',statistic:'count',outFieldName:'TOTAL'}]}).accepted).toBe(false)})
 it('requires geometry-query capability',()=>{expect(policy({supportsGeometry:false}).admit({geometry:{geometryType:'point',spatialRelationship:'intersects',geometryJson:'{"x":1,"y":2}'}})).toMatchObject({accepted:false,reason:'geometry-query-unsupported'})})
 it('parses geometry JSON as an object',()=>{expect(policy().admit({geometry:{geometryType:'point',spatialRelationship:'intersects',geometryJson:'nope'}})).toMatchObject({accepted:false,reason:'geometry-json-malformed'});expect(policy().admit({geometry:{geometryType:'point',spatialRelationship:'intersects',geometryJson:'[]'}})).toMatchObject({accepted:false,reason:'geometry-json-must-be-object'})})
 it('bounds geometry JSON bytes',()=>{expect(policy().admit({geometry:{geometryType:'polygon',spatialRelationship:'intersects',geometryJson:JSON.stringify({rings:['x'.repeat(2100)]})}})).toMatchObject({accepted:false,reason:'geometry-json-budget-exceeded'})})
 it('validates spatial reference wkid',()=>{expect(policy().admit({geometry:{geometryType:'point',spatialRelationship:'intersects',geometryJson:'{"x":1,"y":2}',inWkid:0}}).accepted).toBe(false)})
 it('requires centroid capability',()=>{expect(policy({supportsReturningGeometryCentroid:false}).admit({returnGeometry:true,returnCentroid:true})).toMatchObject({accepted:false,reason:'centroid-unsupported'})})
 it('requires geometry return when centroid is requested',()=>{expect(policy().admit({returnCentroid:true})).toMatchObject({accepted:false,reason:'centroid-requires-return-geometry'})})
 it('defaults output identity to object id when available',()=>{const result=policy().admit({});expect(result.accepted&&result.query.outFields).toEqual(['OBJECTID'])})
 it('rejects invalid service field identities at construction',()=>{expect(()=>policy({fields:['OBJECTID','bad field']})).toThrow('invalid service field')})
 it('rejects identity metadata that is absent from the service schema',()=>{expect(()=>policy({objectIdField:'Missing'})).toThrow('unknown objectIdField:Missing')})
 it('freezes admitted arrays and query objects',()=>{const result=policy().admit({outFields:['Name'],orderBy:[{field:'Name',direction:'asc'}]});expect(result.accepted).toBe(true);if(result.accepted){expect(Object.isFrozen(result.query)).toBe(true);expect(Object.isFrozen(result.query.outFields)).toBe(true);expect(Object.isFrozen(result.query.orderBy)).toBe(true)}})
})
