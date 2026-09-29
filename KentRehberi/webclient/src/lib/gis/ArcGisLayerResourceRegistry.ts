export type ArcGisResourceKind = 'feature-cache' | 'renderer' | 'label' | 'popup' | 'scene-mesh'
export type ArcGisResourceState = 'active' | 'idle'

export interface ArcGisLayerResourceBudget {
  readonly maxLayers: number
  readonly maxResources: number
  readonly maxResourcesPerLayer: number
  readonly maxCpuBytes: number
  readonly maxGpuBytes: number
  readonly maxIdleMs: number
  readonly maxLeaseMs: number
  readonly maxOwnersPerResource: number
}

export interface ArcGisLayerResourceDescriptor {
  readonly layerId: string
  readonly resourceId: string
  readonly kind: ArcGisResourceKind
  readonly cpuBytes: number
  readonly gpuBytes: number
  readonly generation: number
}

export interface ArcGisLayerResourceLease {
  readonly leaseId: string
  readonly layerId: string
  readonly resourceId: string
  readonly ownerId: string
  readonly generation: number
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
}

export interface ArcGisLayerResourceSnapshotEntry {
  readonly layerId: string
  readonly resourceId: string
  readonly kind: ArcGisResourceKind
  readonly state: ArcGisResourceState
  readonly generation: number
  readonly cpuBytes: number
  readonly gpuBytes: number
  readonly owners: readonly string[]
  readonly lastUsedAtMs: number
}

export interface ArcGisLayerResourceSnapshot {
  readonly resources: readonly ArcGisLayerResourceSnapshotEntry[]
  readonly leases: readonly ArcGisLayerResourceLease[]
  readonly cpuBytes: number
  readonly gpuBytes: number
  readonly layerCount: number
  readonly fingerprint: string
}

type StoredResource = {
  readonly layerId: string
  readonly resourceId: string
  readonly kind: ArcGisResourceKind
  readonly generation: number
  readonly cpuBytes: number
  readonly gpuBytes: number
  readonly owners: Map<string, string>
  lastUsedAtMs: number
}

type StoredLease = ArcGisLayerResourceLease & { readonly key: string }

const CONTROL = /[\u0000-\u001f\u007f]/
const KINDS = new Set<ArcGisResourceKind>(['feature-cache', 'renderer', 'label', 'popup', 'scene-mesh'])
const MAX_BYTES = 2 * 1024 * 1024 * 1024

function boundedId(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || CONTROL.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`)
  return value
}

function safeAdd(a: number, b: number, name: string): number {
  if (a > Number.MAX_SAFE_INTEGER - b) throw new Error(`${name}-overflow`)
  return a + b
}

function resourceKey(layerId: string, resourceId: string): string {
  return `${layerId}\u0000${resourceId}`
}

function leaseKey(layerId: string, resourceId: string, ownerId: string): string {
  return `${layerId}\u0000${resourceId}\u0000${ownerId}`
}

/**
 * Owns logical CPU/GPU resource leases without retaining ArcGIS SDK objects.
 * Hosts use generations to reject stale async work and explicit leases to make
 * renderer/cache/mesh ownership visible, bounded and deterministically releasable.
 */
export class ArcGisLayerResourceRegistry {
  private readonly budget: Readonly<ArcGisLayerResourceBudget>
  private readonly resources = new Map<string, StoredResource>()
  private readonly leases = new Map<string, StoredLease>()
  private disposed = false
  private cpuBytes = 0
  private gpuBytes = 0
  private leaseSequence = 0

  constructor(input: ArcGisLayerResourceBudget) {
    this.budget = Object.freeze({
      maxLayers: integer(input.maxLayers, 'maxLayers', 1, 10_000),
      maxResources: integer(input.maxResources, 'maxResources', 1, 100_000),
      maxResourcesPerLayer: integer(input.maxResourcesPerLayer, 'maxResourcesPerLayer', 1, 10_000),
      maxCpuBytes: integer(input.maxCpuBytes, 'maxCpuBytes', 1, MAX_BYTES),
      maxGpuBytes: integer(input.maxGpuBytes, 'maxGpuBytes', 1, MAX_BYTES),
      maxIdleMs: integer(input.maxIdleMs, 'maxIdleMs', 0, 24 * 60 * 60 * 1000),
      maxLeaseMs: integer(input.maxLeaseMs, 'maxLeaseMs', 1, 24 * 60 * 60 * 1000),
      maxOwnersPerResource: integer(input.maxOwnersPerResource, 'maxOwnersPerResource', 1, 1024),
    })
    if (this.budget.maxResourcesPerLayer > this.budget.maxResources) throw new Error('maxResourcesPerLayer must be <= maxResources')
  }

  register(input: ArcGisLayerResourceDescriptor, nowMsInput: number): ArcGisLayerResourceSnapshotEntry {
    this.assertLive()
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const descriptor = this.normalizeDescriptor(input)
    const key = resourceKey(descriptor.layerId, descriptor.resourceId)
    const previous = this.resources.get(key)
    if (previous) {
      if (descriptor.generation < previous.generation) throw new Error('stale-resource-generation')
      if (descriptor.generation === previous.generation) {
        if (descriptor.kind !== previous.kind || descriptor.cpuBytes !== previous.cpuBytes || descriptor.gpuBytes !== previous.gpuBytes) throw new Error('resource-generation-conflict')
        previous.lastUsedAtMs = Math.max(previous.lastUsedAtMs, nowMs)
        return this.snapshotEntry(previous)
      }
      if (previous.owners.size) throw new Error('resource-generation-in-use')
      this.removeResource(key, previous)
    }
    if (this.resources.size >= this.budget.maxResources) throw new Error('resource-count-budget-exceeded')
    const layerResources = [...this.resources.values()].filter(item => item.layerId === descriptor.layerId).length
    if (layerResources >= this.budget.maxResourcesPerLayer) throw new Error('layer-resource-count-budget-exceeded')
    const layers = new Set([...this.resources.values()].map(item => item.layerId))
    if (!layers.has(descriptor.layerId) && layers.size >= this.budget.maxLayers) throw new Error('layer-count-budget-exceeded')
    if (safeAdd(this.cpuBytes, descriptor.cpuBytes, 'cpu-bytes') > this.budget.maxCpuBytes) throw new Error('cpu-byte-budget-exceeded')
    if (safeAdd(this.gpuBytes, descriptor.gpuBytes, 'gpu-bytes') > this.budget.maxGpuBytes) throw new Error('gpu-byte-budget-exceeded')
    const stored: StoredResource = { ...descriptor, owners: new Map(), lastUsedAtMs: nowMs }
    this.resources.set(key, stored)
    this.cpuBytes += descriptor.cpuBytes
    this.gpuBytes += descriptor.gpuBytes
    return this.snapshotEntry(stored)
  }

  acquire(input: { readonly layerId: string; readonly resourceId: string; readonly ownerId: string; readonly generation: number; readonly ttlMs: number; readonly nowMs: number }): ArcGisLayerResourceLease {
    this.assertLive()
    const layerId = boundedId(input.layerId, 'layer-id')
    const resourceId = boundedId(input.resourceId, 'resource-id')
    const ownerId = boundedId(input.ownerId, 'owner-id')
    const generation = integer(input.generation, 'generation', 0, Number.MAX_SAFE_INTEGER)
    const ttlMs = integer(input.ttlMs, 'ttlMs', 1, this.budget.maxLeaseMs)
    const nowMs = integer(input.nowMs, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    if (nowMs > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error('lease-expiry-overflow')
    this.expireLeases(nowMs)
    const key = resourceKey(layerId, resourceId)
    const resource = this.resources.get(key)
    if (!resource) throw new Error('resource-not-registered')
    if (resource.generation !== generation) throw new Error('resource-generation-mismatch')
    const ownerKey = leaseKey(layerId, resourceId, ownerId)
    const existing = this.leases.get(ownerKey)
    if (existing) return this.publicLease(existing)
    if (resource.owners.size >= this.budget.maxOwnersPerResource) throw new Error('resource-owner-budget-exceeded')
    this.leaseSequence += 1
    if (!Number.isSafeInteger(this.leaseSequence)) throw new Error('lease-sequence-overflow')
    const lease: StoredLease = Object.freeze({
      key: ownerKey,
      leaseId: `${generation}:${this.leaseSequence}`,
      layerId,
      resourceId,
      ownerId,
      generation,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    })
    this.leases.set(ownerKey, lease)
    resource.owners.set(ownerId, lease.leaseId)
    resource.lastUsedAtMs = Math.max(resource.lastUsedAtMs, nowMs)
    return this.publicLease(lease)
  }

  touch(leaseIdInput: string, nowMsInput: number, ttlMsInput: number): ArcGisLayerResourceLease {
    this.assertLive()
    const leaseId = boundedId(leaseIdInput, 'lease-id')
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const ttlMs = integer(ttlMsInput, 'ttlMs', 1, this.budget.maxLeaseMs)
    if (nowMs > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error('lease-expiry-overflow')
    this.expireLeases(nowMs)
    const found = [...this.leases.values()].find(item => item.leaseId === leaseId)
    if (!found) throw new Error('lease-not-found')
    const resource = this.resources.get(resourceKey(found.layerId, found.resourceId))
    if (!resource || resource.generation !== found.generation) throw new Error('lease-resource-stale')
    const updated: StoredLease = Object.freeze({ ...found, expiresAtMs: nowMs + ttlMs })
    this.leases.set(found.key, updated)
    resource.lastUsedAtMs = Math.max(resource.lastUsedAtMs, nowMs)
    return this.publicLease(updated)
  }

  release(leaseIdInput: string, nowMsInput: number): boolean {
    this.assertLive()
    const leaseId = boundedId(leaseIdInput, 'lease-id')
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const found = [...this.leases.values()].find(item => item.leaseId === leaseId)
    if (!found) return false
    this.removeLease(found, nowMs)
    return true
  }

  releaseOwner(ownerIdInput: string, nowMsInput: number): number {
    this.assertLive()
    const ownerId = boundedId(ownerIdInput, 'owner-id')
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const matches = [...this.leases.values()].filter(item => item.ownerId === ownerId).sort((a, b) => a.leaseId.localeCompare(b.leaseId))
    for (const lease of matches) this.removeLease(lease, nowMs)
    return matches.length
  }

  expireLeases(nowMsInput: number): number {
    this.assertLive()
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    const expired = [...this.leases.values()].filter(item => item.expiresAtMs <= nowMs).sort((a, b) => a.leaseId.localeCompare(b.leaseId))
    for (const lease of expired) this.removeLease(lease, nowMs)
    return expired.length
  }

  evictIdle(nowMsInput: number): readonly string[] {
    this.assertLive()
    const nowMs = integer(nowMsInput, 'nowMs', 0, Number.MAX_SAFE_INTEGER)
    this.expireLeases(nowMs)
    const candidates = [...this.resources.entries()]
      .filter(([, resource]) => !resource.owners.size && nowMs >= resource.lastUsedAtMs && nowMs - resource.lastUsedAtMs >= this.budget.maxIdleMs)
      .sort((a, b) => a[1].lastUsedAtMs - b[1].lastUsedAtMs || a[0].localeCompare(b[0]))
    const removed: string[] = []
    for (const [key, resource] of candidates) {
      this.removeResource(key, resource)
      removed.push(`${resource.layerId}/${resource.resourceId}`)
    }
    return Object.freeze(removed)
  }

  unregister(layerIdInput: string, resourceIdInput: string, generationInput: number): boolean {
    this.assertLive()
    const layerId = boundedId(layerIdInput, 'layer-id')
    const resourceId = boundedId(resourceIdInput, 'resource-id')
    const generation = integer(generationInput, 'generation', 0, Number.MAX_SAFE_INTEGER)
    const key = resourceKey(layerId, resourceId)
    const resource = this.resources.get(key)
    if (!resource) return false
    if (resource.generation !== generation) throw new Error('resource-generation-mismatch')
    if (resource.owners.size) throw new Error('resource-in-use')
    this.removeResource(key, resource)
    return true
  }

  snapshot(): ArcGisLayerResourceSnapshot {
    const resources = Object.freeze([...this.resources.values()].map(item => this.snapshotEntry(item)).sort((a, b) => a.layerId.localeCompare(b.layerId) || a.resourceId.localeCompare(b.resourceId)))
    const leases = Object.freeze([...this.leases.values()].map(item => this.publicLease(item)).sort((a, b) => a.leaseId.localeCompare(b.leaseId)))
    const layerCount = new Set(resources.map(item => item.layerId)).size
    const fingerprint = resources.map(item => `${item.layerId}/${item.resourceId}:${item.generation}:${item.state}:${item.owners.join(',')}`).join('|')
    return Object.freeze({ resources, leases, cpuBytes: this.cpuBytes, gpuBytes: this.gpuBytes, layerCount, fingerprint })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resources.clear()
    this.leases.clear()
    this.cpuBytes = 0
    this.gpuBytes = 0
  }

  private normalizeDescriptor(input: ArcGisLayerResourceDescriptor): Readonly<ArcGisLayerResourceDescriptor> {
    if (!KINDS.has(input.kind)) throw new Error('invalid-resource-kind')
    return Object.freeze({
      layerId: boundedId(input.layerId, 'layer-id'),
      resourceId: boundedId(input.resourceId, 'resource-id'),
      kind: input.kind,
      cpuBytes: integer(input.cpuBytes, 'cpuBytes', 0, MAX_BYTES),
      gpuBytes: integer(input.gpuBytes, 'gpuBytes', 0, MAX_BYTES),
      generation: integer(input.generation, 'generation', 0, Number.MAX_SAFE_INTEGER),
    })
  }

  private removeLease(lease: StoredLease, nowMs: number): void {
    this.leases.delete(lease.key)
    const resource = this.resources.get(resourceKey(lease.layerId, lease.resourceId))
    if (!resource) return
    resource.owners.delete(lease.ownerId)
    resource.lastUsedAtMs = Math.max(resource.lastUsedAtMs, nowMs)
  }

  private removeResource(key: string, resource: StoredResource): void {
    this.resources.delete(key)
    this.cpuBytes -= resource.cpuBytes
    this.gpuBytes -= resource.gpuBytes
  }

  private snapshotEntry(resource: StoredResource): ArcGisLayerResourceSnapshotEntry {
    const owners = Object.freeze([...resource.owners.keys()].sort())
    return Object.freeze({
      layerId: resource.layerId,
      resourceId: resource.resourceId,
      kind: resource.kind,
      state: owners.length ? 'active' : 'idle',
      generation: resource.generation,
      cpuBytes: resource.cpuBytes,
      gpuBytes: resource.gpuBytes,
      owners,
      lastUsedAtMs: resource.lastUsedAtMs,
    })
  }

  private publicLease(lease: StoredLease): ArcGisLayerResourceLease {
    return Object.freeze({ leaseId: lease.leaseId, layerId: lease.layerId, resourceId: lease.resourceId, ownerId: lease.ownerId, generation: lease.generation, acquiredAtMs: lease.acquiredAtMs, expiresAtMs: lease.expiresAtMs })
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('arcgis-layer-resource-registry-disposed')
  }
}
