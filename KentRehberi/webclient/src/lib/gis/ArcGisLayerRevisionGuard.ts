export interface ArcGisLayerRevisionToken {
  readonly layerId: string
  readonly generation: number
  readonly revision: string
}

const CONTROL = /[\u0000-\u001f\u007f]/

function text(value: string, name: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || CONTROL.test(normalized)) throw new Error(`invalid-${name}`)
  return normalized
}

function generation(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid-generation')
  return value
}

/** Small fail-closed guard used at async layer boundaries to reject stale completions. */
export class ArcGisLayerRevisionGuard {
  private readonly current = new Map<string, Readonly<ArcGisLayerRevisionToken>>()

  advance(input: ArcGisLayerRevisionToken): ArcGisLayerRevisionToken {
    const token = Object.freeze({ layerId: text(input.layerId, 'layer-id'), generation: generation(input.generation), revision: text(input.revision, 'revision') })
    const previous = this.current.get(token.layerId)
    if (previous && token.generation < previous.generation) throw new Error('stale-layer-generation')
    if (previous && token.generation === previous.generation && token.revision !== previous.revision) throw new Error('layer-revision-conflict')
    this.current.set(token.layerId, token)
    return token
  }

  accepts(input: ArcGisLayerRevisionToken): boolean {
    const layerId = text(input.layerId, 'layer-id')
    const token = this.current.get(layerId)
    return Boolean(token && token.generation === generation(input.generation) && token.revision === text(input.revision, 'revision'))
  }

  invalidate(layerIdInput: string): boolean {
    return this.current.delete(text(layerIdInput, 'layer-id'))
  }

  snapshot(): readonly ArcGisLayerRevisionToken[] {
    return Object.freeze([...this.current.values()].sort((a, b) => a.layerId.localeCompare(b.layerId)))
  }

  clear(): void {
    this.current.clear()
  }
}
