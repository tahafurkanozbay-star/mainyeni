export type SceneSectionMode = 'include' | 'exclude';
export type SceneSectionPressure = 'normal' | 'elevated' | 'critical';

export interface SceneSectionPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SceneSectionVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SceneSectionPlaneInput {
  readonly id: string;
  readonly origin: SceneSectionPoint;
  readonly normal: SceneSectionVector;
  readonly enabled?: boolean;
  readonly invert?: boolean;
}

export interface SceneSectionDefinition {
  readonly id: string;
  readonly enabled?: boolean;
  readonly mode?: SceneSectionMode;
  readonly priority?: number;
  readonly essential?: boolean;
  readonly layerIds?: readonly string[];
  readonly planes: readonly SceneSectionPlaneInput[];
}

export interface SceneSectionPlanContext {
  readonly layerIds?: readonly string[];
  readonly pressure?: SceneSectionPressure;
}

export interface SceneSectionPlane {
  readonly sectionId: string;
  readonly planeId: string;
  readonly mode: SceneSectionMode;
  readonly origin: Readonly<SceneSectionPoint>;
  readonly normal: Readonly<SceneSectionVector>;
  readonly invert: boolean;
  readonly layerIds: readonly string[];
}

export interface SceneSectionDecision {
  readonly sectionId: string;
  readonly admitted: boolean;
  readonly planeCount: number;
  readonly reason: 'admitted' | 'disabled' | 'layer-filter' | 'pressure' | 'capacity';
}

export interface SceneSectionPlan {
  readonly pressure: SceneSectionPressure;
  readonly activePlanes: readonly SceneSectionPlane[];
  readonly decisions: readonly SceneSectionDecision[];
  readonly admittedSections: number;
  readonly admittedPlanes: number;
  readonly revision: number;
}

export interface SceneSectionRuntimeSnapshot {
  readonly sections: number;
  readonly enabledSections: number;
  readonly totalPlanes: number;
  readonly revision: number;
  readonly disposed: boolean;
}

export interface SceneSectionRuntimeOptions {
  readonly maxSections?: number;
  readonly maxPlanesPerSection?: number;
  readonly maxActivePlanes?: number;
  readonly maxTargetLayers?: number;
  readonly coordinateMagnitude?: number;
}

type NormalizedPlane = Readonly<{
  id: string;
  origin: Readonly<SceneSectionPoint>;
  normal: Readonly<SceneSectionVector>;
  enabled: boolean;
  invert: boolean;
}>;

type NormalizedSection = Readonly<{
  id: string;
  enabled: boolean;
  mode: SceneSectionMode;
  priority: number;
  essential: boolean;
  layerIds: readonly string[];
  planes: readonly NormalizedPlane[];
  sequence: number;
}>;

const DEFAULT_MAX_SECTIONS = 32;
const DEFAULT_MAX_PLANES_PER_SECTION = 8;
const DEFAULT_MAX_ACTIVE_PLANES = 24;
const DEFAULT_MAX_TARGET_LAYERS = 64;
const DEFAULT_COORDINATE_MAGNITUDE = 100_000_000;

const positiveInteger = (value: number | undefined, fallback: number, field: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return resolved;
};

const positiveFinite = (value: number | undefined, fallback: number, field: string): number => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new RangeError(`${field} must be finite and positive`);
  }
  return resolved;
};

const finite = (value: number, field: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
  return value;
};

const normalizeId = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must not be empty`);
  if (normalized.length > 256) throw new RangeError(`${field} exceeds 256 characters`);
  if (/\p{Cc}/u.test(normalized)) throw new TypeError(`${field} contains a control character`);
  return normalized;
};

const normalizePriority = (value: number | undefined): number => {
  const resolved = value ?? 0;
  if (!Number.isFinite(resolved)) throw new TypeError('section priority must be finite');
  return Math.max(-1_000_000, Math.min(1_000_000, resolved));
};

const normalizePoint = (
  point: SceneSectionPoint,
  coordinateMagnitude: number,
  field: string,
): Readonly<SceneSectionPoint> => {
  const x = finite(point.x, `${field}.x`);
  const y = finite(point.y, `${field}.y`);
  const z = finite(point.z, `${field}.z`);
  if (
    Math.abs(x) > coordinateMagnitude
    || Math.abs(y) > coordinateMagnitude
    || Math.abs(z) > coordinateMagnitude
  ) {
    throw new RangeError(`${field} exceeds the configured coordinate magnitude`);
  }
  return Object.freeze({ x, y, z });
};

const normalizeVector = (vector: SceneSectionVector, field: string): Readonly<SceneSectionVector> => {
  const x = finite(vector.x, `${field}.x`);
  const y = finite(vector.y, `${field}.y`);
  const z = finite(vector.z, `${field}.z`);
  const magnitude = Math.hypot(x, y, z);
  if (!Number.isFinite(magnitude) || magnitude <= Number.EPSILON) {
    throw new RangeError(`${field} must have non-zero magnitude`);
  }
  return Object.freeze({ x: x / magnitude, y: y / magnitude, z: z / magnitude });
};

const uniqueLayerIds = (values: readonly string[] | undefined, maxTargetLayers: number): readonly string[] => {
  if (!values?.length) return Object.freeze([]);
  if (values.length > maxTargetLayers) {
    throw new RangeError(`section layerIds exceed configured maximum of ${maxTargetLayers}`);
  }
  const unique = [...new Set(values.map((value) => normalizeId(value, 'layerId')))];
  if (unique.length > maxTargetLayers) {
    throw new RangeError(`section layerIds exceed configured maximum of ${maxTargetLayers}`);
  }
  return Object.freeze(unique.sort((left, right) => left.localeCompare(right)));
};

const intersectsLayerFilter = (sectionLayerIds: readonly string[], requested: ReadonlySet<string> | null): boolean => {
  if (requested === null || requested.size === 0) return true;
  if (sectionLayerIds.length === 0) return true;
  return sectionLayerIds.some((layerId) => requested.has(layerId));
};

const pressurePlaneLimit = (maximum: number, pressure: SceneSectionPressure): number => {
  if (pressure === 'critical') return Math.max(1, Math.floor(maximum * 0.5));
  if (pressure === 'elevated') return Math.max(1, Math.floor(maximum * 0.75));
  return maximum;
};

/**
 * Pure 3D section/clipping admission runtime.
 *
 * The runtime owns only validated section state and deterministic resource-pressure
 * policy. It never mutates ArcGIS objects and never performs I/O. Scene adapters
 * consume the immutable plan and remain responsible for applying the planes to
 * SDK-specific layer/view properties.
 */
export class SceneSectionRuntime {
  private readonly maxSections: number;
  private readonly maxPlanesPerSection: number;
  private readonly maxActivePlanes: number;
  private readonly maxTargetLayers: number;
  private readonly coordinateMagnitude: number;
  private readonly sections = new Map<string, NormalizedSection>();
  private sequence = 0;
  private revision = 0;
  private disposed = false;

  constructor(options: SceneSectionRuntimeOptions = {}) {
    this.maxSections = positiveInteger(options.maxSections, DEFAULT_MAX_SECTIONS, 'maxSections');
    this.maxPlanesPerSection = positiveInteger(
      options.maxPlanesPerSection,
      DEFAULT_MAX_PLANES_PER_SECTION,
      'maxPlanesPerSection',
    );
    this.maxActivePlanes = positiveInteger(options.maxActivePlanes, DEFAULT_MAX_ACTIVE_PLANES, 'maxActivePlanes');
    this.maxTargetLayers = positiveInteger(options.maxTargetLayers, DEFAULT_MAX_TARGET_LAYERS, 'maxTargetLayers');
    this.coordinateMagnitude = positiveFinite(
      options.coordinateMagnitude,
      DEFAULT_COORDINATE_MAGNITUDE,
      'coordinateMagnitude',
    );
  }

  upsert(input: SceneSectionDefinition): SceneSectionRuntimeSnapshot {
    this.assertActive();
    const id = normalizeId(input.id, 'section id');
    const existing = this.sections.get(id);
    if (!existing && this.sections.size >= this.maxSections) {
      throw new Error('scene section capacity exhausted');
    }
    if (!Array.isArray(input.planes) || input.planes.length === 0) {
      throw new TypeError('scene section must contain at least one clipping plane');
    }
    if (input.planes.length > this.maxPlanesPerSection) {
      throw new RangeError(`scene section exceeds ${this.maxPlanesPerSection} planes`);
    }

    const seenPlaneIds = new Set<string>();
    const planes = input.planes.map((plane, index): NormalizedPlane => {
      const planeId = normalizeId(plane.id, `planes[${index}].id`);
      if (seenPlaneIds.has(planeId)) throw new Error(`duplicate scene section plane id: ${planeId}`);
      seenPlaneIds.add(planeId);
      return Object.freeze({
        id: planeId,
        origin: normalizePoint(plane.origin, this.coordinateMagnitude, `planes[${index}].origin`),
        normal: normalizeVector(plane.normal, `planes[${index}].normal`),
        enabled: plane.enabled !== false,
        invert: plane.invert === true,
      });
    });

    const section: NormalizedSection = Object.freeze({
      id,
      enabled: input.enabled !== false,
      mode: input.mode ?? 'exclude',
      priority: normalizePriority(input.priority),
      essential: input.essential === true,
      layerIds: uniqueLayerIds(input.layerIds, this.maxTargetLayers),
      planes: Object.freeze(planes),
      sequence: existing?.sequence ?? ++this.sequence,
    });
    this.sections.set(id, section);
    this.revision += 1;
    return this.snapshot();
  }

  remove(sectionIdInput: string): boolean {
    this.assertActive();
    const sectionId = normalizeId(sectionIdInput, 'section id');
    const removed = this.sections.delete(sectionId);
    if (removed) this.revision += 1;
    return removed;
  }

  setEnabled(sectionIdInput: string, enabled: boolean): SceneSectionRuntimeSnapshot {
    this.assertActive();
    const sectionId = normalizeId(sectionIdInput, 'section id');
    const existing = this.sections.get(sectionId);
    if (!existing) throw new Error(`scene section is not registered: ${sectionId}`);
    if (existing.enabled === (enabled === true)) return this.snapshot();
    this.sections.set(sectionId, Object.freeze({ ...existing, enabled: enabled === true }));
    this.revision += 1;
    return this.snapshot();
  }

  clear(): number {
    this.assertActive();
    const count = this.sections.size;
    if (count === 0) return 0;
    this.sections.clear();
    this.revision += 1;
    return count;
  }

  plan(context: SceneSectionPlanContext = {}): SceneSectionPlan {
    this.assertActive();
    const pressure = context.pressure ?? 'normal';
    const requested = context.layerIds === undefined
      ? null
      : new Set(context.layerIds.map((value) => normalizeId(value, 'context layerId')));
    const planeLimit = pressurePlaneLimit(this.maxActivePlanes, pressure);
    const candidates = [...this.sections.values()].sort((left, right) => {
      if (left.essential !== right.essential) return left.essential ? -1 : 1;
      if (left.priority !== right.priority) return right.priority - left.priority;
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      return left.id.localeCompare(right.id);
    });

    const decisions: SceneSectionDecision[] = [];
    const activePlanes: SceneSectionPlane[] = [];
    let admittedSections = 0;
    for (const section of candidates) {
      const enabledPlanes = section.planes.filter((plane) => plane.enabled);
      if (!section.enabled || enabledPlanes.length === 0) {
        decisions.push(Object.freeze({
          sectionId: section.id,
          admitted: false,
          planeCount: 0,
          reason: 'disabled',
        }));
        continue;
      }
      if (!intersectsLayerFilter(section.layerIds, requested)) {
        decisions.push(Object.freeze({
          sectionId: section.id,
          admitted: false,
          planeCount: 0,
          reason: 'layer-filter',
        }));
        continue;
      }
      if (pressure === 'critical' && !section.essential && activePlanes.length > 0) {
        decisions.push(Object.freeze({
          sectionId: section.id,
          admitted: false,
          planeCount: 0,
          reason: 'pressure',
        }));
        continue;
      }
      if (activePlanes.length + enabledPlanes.length > planeLimit) {
        decisions.push(Object.freeze({
          sectionId: section.id,
          admitted: false,
          planeCount: 0,
          reason: 'capacity',
        }));
        continue;
      }

      admittedSections += 1;
      for (const plane of enabledPlanes) {
        activePlanes.push(Object.freeze({
          sectionId: section.id,
          planeId: plane.id,
          mode: section.mode,
          origin: plane.origin,
          normal: plane.normal,
          invert: plane.invert,
          layerIds: section.layerIds,
        }));
      }
      decisions.push(Object.freeze({
        sectionId: section.id,
        admitted: true,
        planeCount: enabledPlanes.length,
        reason: 'admitted',
      }));
    }

    decisions.sort((left, right) => left.sectionId.localeCompare(right.sectionId));
    return Object.freeze({
      pressure,
      activePlanes: Object.freeze(activePlanes),
      decisions: Object.freeze(decisions),
      admittedSections,
      admittedPlanes: activePlanes.length,
      revision: this.revision,
    });
  }

  snapshot(): SceneSectionRuntimeSnapshot {
    let enabledSections = 0;
    let totalPlanes = 0;
    for (const section of this.sections.values()) {
      if (section.enabled) enabledSections += 1;
      totalPlanes += section.planes.length;
    }
    return Object.freeze({
      sections: this.sections.size,
      enabledSections,
      totalPlanes,
      revision: this.revision,
      disposed: this.disposed,
    });
  }

  definitions(): readonly SceneSectionDefinition[] {
    this.assertActive();
    return Object.freeze([...this.sections.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((section) => Object.freeze({
        id: section.id,
        enabled: section.enabled,
        mode: section.mode,
        priority: section.priority,
        essential: section.essential,
        layerIds: Object.freeze([...section.layerIds]),
        planes: Object.freeze(section.planes.map((plane) => Object.freeze({
          id: plane.id,
          origin: Object.freeze({ ...plane.origin }),
          normal: Object.freeze({ ...plane.normal }),
          enabled: plane.enabled,
          invert: plane.invert,
        }))),
      })));
  }

  dispose(): void {
    if (this.disposed) return;
    this.sections.clear();
    this.disposed = true;
    this.revision += 1;
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('SceneSectionRuntime is disposed');
  }
}
