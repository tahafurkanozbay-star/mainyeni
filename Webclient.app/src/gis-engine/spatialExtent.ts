export interface SpatialReferenceLike { readonly wkid?: number; readonly latestWkid?: number; }
export interface SpatialPoint { readonly x:number; readonly y:number; readonly z?:number; readonly spatialReference?:SpatialReferenceLike; }
export interface SpatialExtent { readonly xmin:number; readonly ymin:number; readonly xmax:number; readonly ymax:number; readonly spatialReference?:SpatialReferenceLike; }
export interface NormalizedSpatialReference { readonly wkid:number; readonly sourceWkid:number; }
export interface NormalizedExtent { readonly xmin:number; readonly ymin:number; readonly xmax:number; readonly ymax:number; readonly width:number; readonly height:number; readonly center:Readonly<{x:number;y:number}>; readonly spatialReference?:NormalizedSpatialReference; }
export interface ExtentAccumulator { addPoint(point:SpatialPoint):void; addExtent(extent:SpatialExtent):void; snapshot():NormalizedExtent|undefined; clear():void; }

const WEB_MERCATOR_IDS=new Set([102100,102113,3857]);
function finite(value:number,label:string):number{if(!Number.isFinite(value))throw new Error(`${label} must be finite`);return value;}
function positiveInteger(value:number|undefined):number|undefined{return value!==undefined&&Number.isInteger(value)&&value>0?value:undefined;}
export function normalizeSpatialReference(value:SpatialReferenceLike|undefined):NormalizedSpatialReference|undefined{
  if(!value)return undefined;
  const source=positiveInteger(value.wkid)??positiveInteger(value.latestWkid);
  if(source===undefined)throw new Error("Spatial reference requires a positive integer wkid");
  const latest=positiveInteger(value.latestWkid);
  const canonical=latest??source;
  return {wkid:WEB_MERCATOR_IDS.has(canonical)?3857:canonical,sourceWkid:source};
}
function sameReference(a:NormalizedSpatialReference|undefined,b:NormalizedSpatialReference|undefined):boolean{return a?.wkid===b?.wkid;}
export function normalizeExtent(value:SpatialExtent):NormalizedExtent{
  const x1=finite(value.xmin,"xmin"),x2=finite(value.xmax,"xmax"),y1=finite(value.ymin,"ymin"),y2=finite(value.ymax,"ymax");
  const xmin=Math.min(x1,x2),xmax=Math.max(x1,x2),ymin=Math.min(y1,y2),ymax=Math.max(y1,y2);
  const width=xmax-xmin,height=ymax-ymin;
  if(!Number.isFinite(width)||!Number.isFinite(height))throw new Error("Extent dimensions overflow");
  return {xmin,ymin,xmax,ymax,width,height,center:{x:xmin+width/2,y:ymin+height/2},...(value.spatialReference?{spatialReference:normalizeSpatialReference(value.spatialReference)}:{})};
}
export function extentFromPoints(points:readonly SpatialPoint[],expected?:SpatialReferenceLike):NormalizedExtent|undefined{
  if(points.length===0)return undefined;
  const expectedRef=normalizeSpatialReference(expected);
  let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity,reference=expectedRef;
  for(const point of points){
    const x=finite(point.x,"point.x"),y=finite(point.y,"point.y"),pointRef=normalizeSpatialReference(point.spatialReference);
    if(reference&&pointRef&&!sameReference(reference,pointRef))throw new Error(`Spatial reference mismatch: ${reference.wkid} != ${pointRef.wkid}`);
    reference??=pointRef;
    xmin=Math.min(xmin,x);ymin=Math.min(ymin,y);xmax=Math.max(xmax,x);ymax=Math.max(ymax,y);
  }
  return normalizeExtent({xmin,ymin,xmax,ymax,...(reference?{spatialReference:{wkid:reference.wkid}}:{})});
}
export function intersectsExtent(a:SpatialExtent,b:SpatialExtent):boolean{
  const left=normalizeExtent(a),right=normalizeExtent(b);
  if(left.spatialReference&&right.spatialReference&&!sameReference(left.spatialReference,right.spatialReference))return false;
  return left.xmin<=right.xmax&&left.xmax>=right.xmin&&left.ymin<=right.ymax&&left.ymax>=right.ymin;
}
export function containsPoint(extent:SpatialExtent,point:SpatialPoint):boolean{
  const normalized=normalizeExtent(extent),pointRef=normalizeSpatialReference(point.spatialReference);
  if(normalized.spatialReference&&pointRef&&!sameReference(normalized.spatialReference,pointRef))return false;
  const x=finite(point.x,"point.x"),y=finite(point.y,"point.y");
  return x>=normalized.xmin&&x<=normalized.xmax&&y>=normalized.ymin&&y<=normalized.ymax;
}
export function expandExtent(extent:SpatialExtent,padding:number):NormalizedExtent{
  const value=normalizeExtent(extent),amount=finite(padding,"padding");
  if(amount<0)throw new Error("padding must be non-negative");
  return normalizeExtent({xmin:value.xmin-amount,ymin:value.ymin-amount,xmax:value.xmax+amount,ymax:value.ymax+amount,...(value.spatialReference?{spatialReference:{wkid:value.spatialReference.wkid}}:{})});
}
export function createExtentAccumulator(expected?:SpatialReferenceLike):ExtentAccumulator{
  const expectedRef=normalizeSpatialReference(expected);let current:NormalizedExtent|undefined;
  const merge=(next:NormalizedExtent)=>{
    const currentRef=current?.spatialReference??expectedRef,nextRef=next.spatialReference;
    if(currentRef&&nextRef&&!sameReference(currentRef,nextRef))throw new Error(`Spatial reference mismatch: ${currentRef.wkid} != ${nextRef.wkid}`);
    const reference=currentRef??nextRef;
    current=current?normalizeExtent({xmin:Math.min(current.xmin,next.xmin),ymin:Math.min(current.ymin,next.ymin),xmax:Math.max(current.xmax,next.xmax),ymax:Math.max(current.ymax,next.ymax),...(reference?{spatialReference:{wkid:reference.wkid}}:{})}):next;
  };
  return {addPoint(point){const next=extentFromPoints([point],expectedRef?{wkid:expectedRef.wkid}:undefined);if(next)merge(next);},addExtent(extent){merge(normalizeExtent(extent));},snapshot(){return current;},clear(){current=undefined;}};
}
