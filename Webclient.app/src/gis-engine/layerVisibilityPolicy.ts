export type LayerVisibilityMode = '2d' | '3d';
export type LayerVisibilityReason = 'visible' | 'disabled' | 'mode' | 'scale' | 'opacity' | 'parent-hidden' | 'resource-pressure';

export interface LayerVisibilityDescriptor {
  readonly id: string;
  readonly enabled: boolean;
  readonly modes: readonly LayerVisibilityMode[];
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly opacity?: number;
  readonly parentId?: string;
  readonly essential?: boolean;
}

export interface LayerVisibilityContext {
  readonly mode: LayerVisibilityMode;
  readonly scale: number;
  readonly pressure?: 'normal' | 'elevated' | 'critical';
}

export interface LayerVisibilityDecision {
  readonly id: string;
  readonly visible: boolean;
  readonly reason: LayerVisibilityReason;
  readonly effectiveOpacity: number;
}

type NormalizedDescriptor = {
  readonly id: string;
  readonly enabled: boolean;
  readonly modes: readonly LayerVisibilityMode[];
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly opacity: number;
  readonly parentId?: string;
  readonly essential: boolean;
};

function scale(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive`);
  return value;
}

function normalize(input: LayerVisibilityDescriptor): NormalizedDescriptor {
  const id = input.id.trim();
  if (!id) throw new TypeError('layer visibility id must not be empty');
  const modes = Array.from(new Set(input.modes));
  if (modes.length === 0) throw new TypeError('layer visibility modes must not be empty');
  const minScale = scale(input.minScale, 'minScale');
  const maxScale = scale(input.maxScale, 'maxScale');
  if (minScale !== undefined && maxScale !== undefined && minScale > maxScale) throw new RangeError('minScale must be <= maxScale');
  const opacity = input.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new RangeError('opacity must be between 0 and 1');
  const parentId = input.parentId?.trim();
  if (parentId === id) throw new TypeError('layer must not parent itself');
  return Object.freeze({
    id,
    enabled: input.enabled,
    modes: Object.freeze(modes),
    minScale,
    maxScale,
    opacity,
    ...(parentId ? { parentId } : {}),
    essential: input.essential === true,
  });
}

export class LayerVisibilityPolicy {
  private readonly descriptors = new Map<string, NormalizedDescriptor>();
  private readonly maxLayers: number;

  constructor(maxLayers = 512) {
    if (!Number.isSafeInteger(maxLayers) || maxLayers <= 0) throw new RangeError('maxLayers must be a positive safe integer');
    this.maxLayers = maxLayers;
  }

  register(input: LayerVisibilityDescriptor): void {
    const descriptor = normalize(input);
    if (!this.descriptors.has(descriptor.id) && this.descriptors.size >= this.maxLayers) throw new Error('layer visibility capacity exceeded');
    if (descriptor.parentId && !this.descriptors.has(descriptor.parentId)) throw new Error(`unknown parent layer: ${descriptor.parentId}`);
    this.descriptors.set(descriptor.id, descriptor);
    this.assertAcyclic(descriptor.id);
  }

  remove(id: string): boolean {
    const normalized = id.trim();
    for (const descriptor of this.descriptors.values()) {
      if (descriptor.parentId === normalized) throw new Error('cannot remove a layer with registered children');
    }
    return this.descriptors.delete(normalized);
  }

  decide(id: string, context: LayerVisibilityContext): LayerVisibilityDecision {
    const descriptor = this.descriptors.get(id.trim());
    if (!descriptor) throw new Error(`unknown layer: ${id}`);
    if (!Number.isFinite(context.scale) || context.scale <= 0) throw new RangeError('context scale must be finite and positive');
    return this.decideDescriptor(descriptor, context, new Set());
  }

  decideAll(context: LayerVisibilityContext): readonly LayerVisibilityDecision[] {
    return Object.freeze(Array.from(this.descriptors.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((descriptor) => this.decideDescriptor(descriptor, context, new Set())));
  }

  private decideDescriptor(descriptor: NormalizedDescriptor, context: LayerVisibilityContext, visiting: Set<string>): LayerVisibilityDecision {
    if (visiting.has(descriptor.id)) throw new Error('layer visibility parent cycle detected');
    visiting.add(descriptor.id);
    let reason: LayerVisibilityReason = 'visible';
    if (!descriptor.enabled) reason = 'disabled';
    else if (!descriptor.modes.includes(context.mode)) reason = 'mode';
    else if (descriptor.minScale !== undefined && context.scale < descriptor.minScale) reason = 'scale';
    else if (descriptor.maxScale !== undefined && context.scale > descriptor.maxScale) reason = 'scale';
    else if (descriptor.opacity === 0) reason = 'opacity';
    else if (context.pressure === 'critical' && !descriptor.essential) reason = 'resource-pressure';
    else if (descriptor.parentId) {
      const parent = this.descriptors.get(descriptor.parentId);
      if (!parent) throw new Error(`unknown parent layer: ${descriptor.parentId}`);
      if (!this.decideDescriptor(parent, context, visiting).visible) reason = 'parent-hidden';
    }
    visiting.delete(descriptor.id);
    return Object.freeze({ id: descriptor.id, visible: reason === 'visible', reason, effectiveOpacity: reason === 'visible' ? descriptor.opacity : 0 });
  }

  private assertAcyclic(startId: string): void {
    const visited = new Set<string>();
    let current = this.descriptors.get(startId);
    while (current?.parentId) {
      if (visited.has(current.id)) throw new Error('layer visibility parent cycle detected');
      visited.add(current.id);
      current = this.descriptors.get(current.parentId);
    }
  }
}
