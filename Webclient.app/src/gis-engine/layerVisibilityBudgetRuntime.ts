export type LayerVisibilityKind = 'feature' | 'scene' | 'graphics' | 'imagery' | 'elevation';
export type LayerVisibilityPriority = 'critical' | 'high' | 'normal' | 'low';

export interface LayerVisibilityCandidate {
  readonly id: string;
  readonly kind: LayerVisibilityKind;
  readonly priority: LayerVisibilityPriority;
  readonly visible: boolean;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly estimatedFeatures: number;
  readonly estimatedDrawCalls: number;
  readonly estimatedGpuBytes: number;
  readonly estimatedCpuBytes: number;
  readonly lastVisibleAt?: number;
}
export interface LayerVisibilityBudget { readonly maxLayers:number; readonly maxFeatures:number; readonly maxDrawCalls:number; readonly maxGpuBytes:number; readonly maxCpuBytes:number; }
export interface LayerVisibilityContext { readonly scale:number; readonly now:number; readonly mode:'2d'|'3d'; }
export type LayerVisibilityRejectionReason='hidden'|'outside-scale'|'layer-budget'|'feature-budget'|'draw-call-budget'|'gpu-budget'|'cpu-budget';
export interface LayerVisibilityDecision { readonly id:string; readonly admitted:boolean; readonly reason?:LayerVisibilityRejectionReason; }
export interface LayerVisibilityUsage { readonly layers:number; readonly features:number; readonly drawCalls:number; readonly gpuBytes:number; readonly cpuBytes:number; }
export interface LayerVisibilityPlan { readonly decisions:readonly LayerVisibilityDecision[]; readonly admittedIds:readonly string[]; readonly rejectedIds:readonly string[]; readonly usage:LayerVisibilityUsage; readonly pressure:number; }
const PRIORITY_SCORE:Readonly<Record<LayerVisibilityPriority,number>>=Object.freeze({critical:4,high:3,normal:2,low:1});
function assertFiniteNonNegative(value:number,name:string):void { if(!Number.isFinite(value)||value<0) throw new RangeError(`${name} must be finite and >= 0`); }
function assertPositiveInteger(value:number,name:string):void { if(!Number.isSafeInteger(value)||value<=0) throw new RangeError(`${name} must be a positive integer`); }
function validateBudget(b:LayerVisibilityBudget):void { assertPositiveInteger(b.maxLayers,'maxLayers'); assertPositiveInteger(b.maxFeatures,'maxFeatures'); assertPositiveInteger(b.maxDrawCalls,'maxDrawCalls'); assertPositiveInteger(b.maxGpuBytes,'maxGpuBytes'); assertPositiveInteger(b.maxCpuBytes,'maxCpuBytes'); }
function validateCandidate(c:LayerVisibilityCandidate):void { if(!c.id.trim()) throw new TypeError('layer id must not be empty'); assertFiniteNonNegative(c.estimatedFeatures,'estimatedFeatures'); assertFiniteNonNegative(c.estimatedDrawCalls,'estimatedDrawCalls'); assertFiniteNonNegative(c.estimatedGpuBytes,'estimatedGpuBytes'); assertFiniteNonNegative(c.estimatedCpuBytes,'estimatedCpuBytes'); if(c.minScale!==undefined) assertFiniteNonNegative(c.minScale,'minScale'); if(c.maxScale!==undefined) assertFiniteNonNegative(c.maxScale,'maxScale'); if(c.lastVisibleAt!==undefined) assertFiniteNonNegative(c.lastVisibleAt,'lastVisibleAt'); }
function isInsideScale(c:LayerVisibilityCandidate,s:number):boolean { return !(c.minScale!==undefined&&c.minScale>0&&s>c.minScale) && !(c.maxScale!==undefined&&c.maxScale>0&&s<c.maxScale); }
function compareCandidates(a:LayerVisibilityCandidate,b:LayerVisibilityCandidate):number { const p=PRIORITY_SCORE[b.priority]-PRIORITY_SCORE[a.priority]; if(p) return p; const r=(b.lastVisibleAt??0)-(a.lastVisibleAt??0); if(r) return r; const ca=a.estimatedDrawCalls+a.estimatedFeatures/1000, cb=b.estimatedDrawCalls+b.estimatedFeatures/1000; return ca!==cb?ca-cb:a.id.localeCompare(b.id); }
function pressureOf(u:LayerVisibilityUsage,b:LayerVisibilityBudget):number { return Math.max(u.layers/b.maxLayers,u.features/b.maxFeatures,u.drawCalls/b.maxDrawCalls,u.gpuBytes/b.maxGpuBytes,u.cpuBytes/b.maxCpuBytes); }
function firstBudgetFailure(u:LayerVisibilityUsage,c:LayerVisibilityCandidate,b:LayerVisibilityBudget):LayerVisibilityRejectionReason|undefined { if(u.layers+1>b.maxLayers)return'layer-budget'; if(u.features+c.estimatedFeatures>b.maxFeatures)return'feature-budget'; if(u.drawCalls+c.estimatedDrawCalls>b.maxDrawCalls)return'draw-call-budget'; if(u.gpuBytes+c.estimatedGpuBytes>b.maxGpuBytes)return'gpu-budget'; if(u.cpuBytes+c.estimatedCpuBytes>b.maxCpuBytes)return'cpu-budget'; }
export function planLayerVisibility(candidates:readonly LayerVisibilityCandidate[],budget:LayerVisibilityBudget,context:LayerVisibilityContext):LayerVisibilityPlan { validateBudget(budget); assertFiniteNonNegative(context.scale,'scale'); assertFiniteNonNegative(context.now,'now'); const seen=new Set<string>(); for(const c of candidates){validateCandidate(c);if(seen.has(c.id))throw new TypeError(`duplicate layer id: ${c.id}`);seen.add(c.id);} const decisions=new Map<string,LayerVisibilityDecision>(), eligible:LayerVisibilityCandidate[]=[]; for(const c of candidates){if(!c.visible)decisions.set(c.id,Object.freeze({id:c.id,admitted:false,reason:'hidden'}));else if(!isInsideScale(c,context.scale))decisions.set(c.id,Object.freeze({id:c.id,admitted:false,reason:'outside-scale'}));else eligible.push(c);} eligible.sort(compareCandidates); const u={layers:0,features:0,drawCalls:0,gpuBytes:0,cpuBytes:0}, admittedIds:string[]=[]; for(const c of eligible){const reason=firstBudgetFailure(u,c,budget);if(reason){decisions.set(c.id,Object.freeze({id:c.id,admitted:false,reason}));continue;}u.layers++;u.features+=c.estimatedFeatures;u.drawCalls+=c.estimatedDrawCalls;u.gpuBytes+=c.estimatedGpuBytes;u.cpuBytes+=c.estimatedCpuBytes;admittedIds.push(c.id);decisions.set(c.id,Object.freeze({id:c.id,admitted:true}));} const ordered=candidates.map(c=>decisions.get(c.id)!); const rejected=ordered.filter(d=>!d.admitted).map(d=>d.id); const usage:LayerVisibilityUsage=Object.freeze({...u}); return Object.freeze({decisions:Object.freeze(ordered),admittedIds:Object.freeze(admittedIds),rejectedIds:Object.freeze(rejected),usage,pressure:pressureOf(usage,budget)}); }
export interface LayerVisibilityBudgetProfile { readonly mode2d:LayerVisibilityBudget; readonly mode3d:LayerVisibilityBudget; }
export function selectLayerVisibilityBudget(p:LayerVisibilityBudgetProfile,mode:'2d'|'3d'):LayerVisibilityBudget { const b=mode==='3d'?p.mode3d:p.mode2d;validateBudget(b);return b; }
export function scaleLayerVisibilityBudget(b:LayerVisibilityBudget,factor:number):LayerVisibilityBudget { validateBudget(b);if(!Number.isFinite(factor)||factor<=0||factor>1)throw new RangeError('factor must be > 0 and <= 1');return Object.freeze({maxLayers:Math.max(1,Math.floor(b.maxLayers*factor)),maxFeatures:Math.max(1,Math.floor(b.maxFeatures*factor)),maxDrawCalls:Math.max(1,Math.floor(b.maxDrawCalls*factor)),maxGpuBytes:Math.max(1,Math.floor(b.maxGpuBytes*factor)),maxCpuBytes:Math.max(1,Math.floor(b.maxCpuBytes*factor))}); }
