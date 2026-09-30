export type ArcGisGeometryOperation = 'buffer' | 'intersect' | 'union' | 'difference' | 'simplify' | 'densify' | 'project';
export type ArcGisGeometryKind = 'point' | 'multipoint' | 'polyline' | 'polygon' | 'extent';

export interface ArcGisGeometryWorkloadLimits {
  readonly maxJobs: number;
  readonly maxInputGeometries: number;
  readonly maxVerticesPerGeometry: number;
  readonly maxTotalVertices: number;
  readonly maxEstimatedBytes: number;
  readonly maxOutputVertices: number;
  readonly maxDensifySegments: number;
  readonly maxBufferDistance: number;
}

export interface ArcGisGeometryInput {
  readonly id: string;
  readonly kind: ArcGisGeometryKind;
  readonly vertexCount: number;
  readonly estimatedBytes: number;
  readonly wkid: number;
  readonly revision: number;
}

export interface ArcGisGeometryJob {
  readonly id: string;
  readonly operation: ArcGisGeometryOperation;
  readonly inputs: readonly ArcGisGeometryInput[];
  readonly targetWkid?: number;
  readonly bufferDistance?: number;
  readonly densifySegments?: number;
  readonly priority: number;
  readonly revision: number;
}

export interface ArcGisGeometryAdmission {
  readonly jobId: string;
  readonly operation: ArcGisGeometryOperation;
  readonly accepted: boolean;
  readonly reason: string;
  readonly inputCount: number;
  readonly totalVertices: number;
  readonly estimatedBytes: number;
  readonly estimatedOutputVertices: number;
  readonly sourceWkids: readonly number[];
  readonly targetWkid?: number;
}

export interface ArcGisGeometryWorkloadPlan {
  readonly revision: number;
  readonly admitted: readonly ArcGisGeometryAdmission[];
  readonly rejected: readonly ArcGisGeometryAdmission[];
  readonly totalVertices: number;
  readonly totalEstimatedBytes: number;
  readonly fingerprint: string;
}

const DEFAULT_LIMITS: ArcGisGeometryWorkloadLimits = Object.freeze({
  maxJobs: 64,
  maxInputGeometries: 128,
  maxVerticesPerGeometry: 250_000,
  maxTotalVertices: 1_000_000,
  maxEstimatedBytes: 64 * 1024 * 1024,
  maxOutputVertices: 1_500_000,
  maxDensifySegments: 200_000,
  maxBufferDistance: 1_000_000,
});

const VALID_OPERATIONS = new Set<ArcGisGeometryOperation>([
  'buffer', 'intersect', 'union', 'difference', 'simplify', 'densify', 'project',
]);
const VALID_KINDS = new Set<ArcGisGeometryKind>(['point', 'multipoint', 'polyline', 'polygon', 'extent']);

function finiteInteger(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function finiteNumber(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

function normalizeId(value: string): string {
  return value.trim();
}

function estimateOutputVertices(job: ArcGisGeometryJob, totalVertices: number): number {
  switch (job.operation) {
    case 'buffer':
      return Math.ceil(totalVertices * 1.5 + job.inputs.length * 64);
    case 'union':
      return Math.ceil(totalVertices * 1.1);
    case 'intersect':
    case 'difference':
      return Math.ceil(totalVertices * 1.25);
    case 'densify':
      return Math.max(totalVertices, job.densifySegments ?? 0);
    case 'simplify':
      return totalVertices;
    case 'project':
      return totalVertices;
  }
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function freezeAdmission(value: ArcGisGeometryAdmission): ArcGisGeometryAdmission {
  return Object.freeze({ ...value, sourceWkids: Object.freeze([...value.sourceWkids]) });
}

function reject(job: ArcGisGeometryJob, reason: string, inputCount = 0, totalVertices = 0, estimatedBytes = 0, estimatedOutputVertices = 0, sourceWkids: readonly number[] = []): ArcGisGeometryAdmission {
  return freezeAdmission({
    jobId: normalizeId(job.id), operation: job.operation, accepted: false, reason,
    inputCount, totalVertices, estimatedBytes, estimatedOutputVertices, sourceWkids,
    ...(job.targetWkid === undefined ? {} : { targetWkid: job.targetWkid }),
  });
}

function validateLimits(limits: ArcGisGeometryWorkloadLimits): void {
  const values = Object.values(limits);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('ArcGIS geometry workload limits must be positive safe integers.');
  }
}

export function planArcGisGeometryWorkload(
  jobs: readonly ArcGisGeometryJob[],
  expectedRevision: number,
  limits: ArcGisGeometryWorkloadLimits = DEFAULT_LIMITS,
): ArcGisGeometryWorkloadPlan {
  validateLimits(limits);
  if (!finiteInteger(expectedRevision, 0, Number.MAX_SAFE_INTEGER)) {
    throw new Error('Expected geometry revision must be a non-negative safe integer.');
  }
  if (jobs.length > limits.maxJobs) {
    throw new Error(`Geometry workload contains ${jobs.length} jobs; limit is ${limits.maxJobs}.`);
  }

  const seenJobs = new Set<string>();
  const ordered = [...jobs].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const admitted: ArcGisGeometryAdmission[] = [];
  const rejected: ArcGisGeometryAdmission[] = [];
  let consumedVertices = 0;
  let consumedBytes = 0;

  for (const job of ordered) {
    const jobId = normalizeId(job.id);
    if (!jobId || jobId.length > 128) { rejected.push(reject(job, 'invalid-job-id')); continue; }
    if (seenJobs.has(jobId)) { rejected.push(reject(job, 'duplicate-job-id')); continue; }
    seenJobs.add(jobId);
    if (!VALID_OPERATIONS.has(job.operation)) { rejected.push(reject(job, 'invalid-operation')); continue; }
    if (!finiteInteger(job.priority, -1_000_000, 1_000_000)) { rejected.push(reject(job, 'invalid-priority')); continue; }
    if (job.revision !== expectedRevision) { rejected.push(reject(job, 'stale-revision')); continue; }
    if (job.inputs.length === 0 || job.inputs.length > limits.maxInputGeometries) { rejected.push(reject(job, 'input-count-budget')); continue; }

    const seenInputs = new Set<string>();
    let totalVertices = 0;
    let estimatedBytes = 0;
    let invalidInputReason = '';
    const sourceWkids = new Set<number>();

    for (const input of job.inputs) {
      const inputId = normalizeId(input.id);
      if (!inputId || inputId.length > 128) { invalidInputReason = 'invalid-input-id'; break; }
      if (seenInputs.has(inputId)) { invalidInputReason = 'duplicate-input-id'; break; }
      seenInputs.add(inputId);
      if (!VALID_KINDS.has(input.kind)) { invalidInputReason = 'invalid-geometry-kind'; break; }
      if (!finiteInteger(input.vertexCount, 1, limits.maxVerticesPerGeometry)) { invalidInputReason = 'geometry-vertex-budget'; break; }
      if (!finiteInteger(input.estimatedBytes, 1, limits.maxEstimatedBytes)) { invalidInputReason = 'geometry-byte-budget'; break; }
      if (!finiteInteger(input.wkid, 1, 999_999)) { invalidInputReason = 'invalid-wkid'; break; }
      if (input.revision !== expectedRevision) { invalidInputReason = 'stale-input-revision'; break; }
      totalVertices += input.vertexCount;
      estimatedBytes += input.estimatedBytes;
      sourceWkids.add(input.wkid);
    }

    const wkids = [...sourceWkids].sort((a, b) => a - b);
    if (invalidInputReason) { rejected.push(reject(job, invalidInputReason, job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }
    if (job.operation !== 'project' && sourceWkids.size !== 1) { rejected.push(reject(job, 'mixed-spatial-reference', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }
    if (job.operation === 'project') {
      if (!finiteInteger(job.targetWkid ?? 0, 1, 999_999)) { rejected.push(reject(job, 'invalid-target-wkid', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }
    } else if (job.targetWkid !== undefined) {
      rejected.push(reject(job, 'unexpected-target-wkid', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue;
    }
    if (job.operation === 'buffer' && !finiteNumber(job.bufferDistance ?? Number.NaN, 0, limits.maxBufferDistance)) { rejected.push(reject(job, 'invalid-buffer-distance', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }
    if (job.operation !== 'buffer' && job.bufferDistance !== undefined) { rejected.push(reject(job, 'unexpected-buffer-distance', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }
    if (job.operation === 'densify' && !finiteInteger(job.densifySegments ?? 0, 1, limits.maxDensifySegments)) { rejected.push(reject(job, 'invalid-densify-segments', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }
    if (job.operation !== 'densify' && job.densifySegments !== undefined) { rejected.push(reject(job, 'unexpected-densify-segments', job.inputs.length, totalVertices, estimatedBytes, 0, wkids)); continue; }

    const estimatedOutputVertices = estimateOutputVertices(job, totalVertices);
    if (estimatedOutputVertices > limits.maxOutputVertices) { rejected.push(reject(job, 'output-vertex-budget', job.inputs.length, totalVertices, estimatedBytes, estimatedOutputVertices, wkids)); continue; }
    if (consumedVertices + totalVertices > limits.maxTotalVertices) { rejected.push(reject(job, 'aggregate-vertex-budget', job.inputs.length, totalVertices, estimatedBytes, estimatedOutputVertices, wkids)); continue; }
    if (consumedBytes + estimatedBytes > limits.maxEstimatedBytes) { rejected.push(reject(job, 'aggregate-byte-budget', job.inputs.length, totalVertices, estimatedBytes, estimatedOutputVertices, wkids)); continue; }

    consumedVertices += totalVertices;
    consumedBytes += estimatedBytes;
    admitted.push(freezeAdmission({
      jobId, operation: job.operation, accepted: true, reason: 'accepted', inputCount: job.inputs.length,
      totalVertices, estimatedBytes, estimatedOutputVertices, sourceWkids: wkids,
      ...(job.targetWkid === undefined ? {} : { targetWkid: job.targetWkid }),
    }));
  }

  const signature = admitted.concat(rejected).map((item) => `${item.jobId}:${item.operation}:${item.accepted ? 1 : 0}:${item.reason}:${item.totalVertices}:${item.estimatedBytes}:${item.estimatedOutputVertices}:${item.sourceWkids.join(',')}:${item.targetWkid ?? ''}`).join('|');
  return Object.freeze({
    revision: expectedRevision,
    admitted: Object.freeze(admitted),
    rejected: Object.freeze(rejected),
    totalVertices: consumedVertices,
    totalEstimatedBytes: consumedBytes,
    fingerprint: hashString(`${expectedRevision}|${signature}`),
  });
}

export const ARC_GIS_GEOMETRY_WORKLOAD_DEFAULT_LIMITS = DEFAULT_LIMITS;
