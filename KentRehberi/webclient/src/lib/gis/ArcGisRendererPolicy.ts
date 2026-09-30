export type ArcGisRendererKind = 'simple' | 'unique-value' | 'class-breaks'
export type ArcGisVisualVariableKind = 'size' | 'color' | 'opacity' | 'rotation'

export interface ArcGisRendererFieldContract {
  readonly field: string
  readonly allowedValues?: readonly string[]
}

export interface ArcGisRendererClass {
  readonly key: string
  readonly min?: number
  readonly max?: number
  readonly symbolKey: string
}

export interface ArcGisVisualVariable {
  readonly kind: ArcGisVisualVariableKind
  readonly field: string
  readonly stops: readonly { readonly value: number; readonly output: number }[]
}

export interface ArcGisRendererInput {
  readonly id: string
  readonly kind: ArcGisRendererKind
  readonly field?: string
  readonly symbolKey?: string
  readonly classes?: readonly ArcGisRendererClass[]
  readonly visualVariables?: readonly ArcGisVisualVariable[]
  readonly revision: number
}

export interface ArcGisRendererBudgets {
  readonly maxClasses: number
  readonly maxVisualVariables: number
  readonly maxStopsPerVariable: number
  readonly maxFieldLength: number
  readonly maxSymbolKeyLength: number
  readonly maxEstimatedGpuBytes: number
}

export interface ArcGisRendererPlan {
  readonly id: string
  readonly kind: ArcGisRendererKind
  readonly field?: string
  readonly symbolKey?: string
  readonly classes: readonly Readonly<ArcGisRendererClass>[]
  readonly visualVariables: readonly Readonly<ArcGisVisualVariable>[]
  readonly estimatedGpuBytes: number
  readonly revision: number
  readonly fingerprint: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FIELD = /^[A-Za-z_][A-Za-z0-9_.]*$/
const VISUAL_KINDS = new Set<ArcGisVisualVariableKind>(['size', 'color', 'opacity', 'rotation'])

function integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`)
  return value
}

function text(value: string, label: string, max: number, pattern = ID): string {
  const normalized = value.trim()
  if (normalized !== value || !normalized || normalized.length > max || !pattern.test(normalized)) throw new Error(`invalid ${label}`)
  return normalized
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16).padStart(8, '0')
}

function freezeClass(value: ArcGisRendererClass): Readonly<ArcGisRendererClass> {
  return Object.freeze({ ...value })
}

function freezeVariable(value: ArcGisVisualVariable): Readonly<ArcGisVisualVariable> {
  return Object.freeze({ ...value, stops: Object.freeze(value.stops.map(stop => Object.freeze({ ...stop }))) })
}

export class ArcGisRendererPolicy {
  readonly #budgets: Readonly<ArcGisRendererBudgets>
  readonly #fields: ReadonlyMap<string, ReadonlySet<string> | undefined>

  constructor(budgets: ArcGisRendererBudgets, fields: readonly ArcGisRendererFieldContract[]) {
    const normalized = {
      maxClasses: integer(budgets.maxClasses, 'maxClasses'),
      maxVisualVariables: integer(budgets.maxVisualVariables, 'maxVisualVariables'),
      maxStopsPerVariable: integer(budgets.maxStopsPerVariable, 'maxStopsPerVariable'),
      maxFieldLength: integer(budgets.maxFieldLength, 'maxFieldLength'),
      maxSymbolKeyLength: integer(budgets.maxSymbolKeyLength, 'maxSymbolKeyLength'),
      maxEstimatedGpuBytes: integer(budgets.maxEstimatedGpuBytes, 'maxEstimatedGpuBytes'),
    }
    if (Object.values(normalized).some(value => value < 1)) throw new Error('renderer budgets must be positive')
    this.#budgets = Object.freeze(normalized)
    const fieldMap = new Map<string, ReadonlySet<string> | undefined>()
    for (const contract of fields) {
      const field = text(contract.field, 'renderer field', normalized.maxFieldLength, FIELD)
      if (fieldMap.has(field)) throw new Error('duplicate renderer field contract')
      const values = contract.allowedValues
      if (!values) fieldMap.set(field, undefined)
      else {
        const normalizedValues = values.map(value => text(value, 'renderer field value', 128))
        if (new Set(normalizedValues).size !== normalizedValues.length) throw new Error('duplicate renderer field value')
        fieldMap.set(field, new Set(normalizedValues))
      }
    }
    this.#fields = fieldMap
  }

  plan(input: ArcGisRendererInput, expectedRevision = input.revision): ArcGisRendererPlan {
    const id = text(input.id, 'renderer id', 128)
    const revision = integer(input.revision, 'revision')
    if (revision !== integer(expectedRevision, 'expectedRevision')) throw new Error('stale renderer revision')
    if (input.kind !== 'simple' && input.kind !== 'unique-value' && input.kind !== 'class-breaks') throw new Error('unsupported renderer kind')

    const field = input.field === undefined ? undefined : text(input.field, 'renderer field', this.#budgets.maxFieldLength, FIELD)
    const symbolKey = input.symbolKey === undefined ? undefined : text(input.symbolKey, 'symbol key', this.#budgets.maxSymbolKeyLength)
    if (input.kind === 'simple' && !symbolKey) throw new Error('simple renderer requires symbol key')
    if (input.kind !== 'simple' && !field) throw new Error('classified renderer requires field')
    if (field && !this.#fields.has(field)) throw new Error('renderer field is not admitted')

    const rawClasses = [...(input.classes ?? [])]
    if (rawClasses.length > this.#budgets.maxClasses) throw new Error('renderer class budget exceeded')
    if (input.kind === 'simple' && rawClasses.length) throw new Error('simple renderer cannot retain classes')
    if (input.kind !== 'simple' && rawClasses.length === 0) throw new Error('classified renderer requires classes')

    const keys = new Set<string>()
    const classes = rawClasses.map(item => {
      const key = text(item.key, 'renderer class key', 128)
      if (keys.has(key)) throw new Error('duplicate renderer class key')
      keys.add(key)
      const classSymbolKey = text(item.symbolKey, 'symbol key', this.#budgets.maxSymbolKeyLength)
      if (input.kind === 'unique-value') {
        if (item.min !== undefined || item.max !== undefined) throw new Error('unique-value class cannot retain numeric bounds')
        const allowed = field ? this.#fields.get(field) : undefined
        if (allowed && !allowed.has(key)) throw new Error('renderer class value is not admitted')
      } else if (input.kind === 'class-breaks') {
        if (item.min === undefined || item.max === undefined) throw new Error('class-break requires bounds')
        const min = finite(item.min, 'class minimum')
        const max = finite(item.max, 'class maximum')
        if (max <= min) throw new Error('class break must have positive span')
        return freezeClass({ key, min, max, symbolKey: classSymbolKey })
      }
      return freezeClass({ key, symbolKey: classSymbolKey })
    })
    classes.sort((a, b) => a.key.localeCompare(b.key))
    if (input.kind === 'class-breaks') {
      const ordered = [...classes].sort((a, b) => (a.min ?? 0) - (b.min ?? 0))
      for (let index = 1; index < ordered.length; index += 1) {
        if ((ordered[index - 1].max ?? 0) > (ordered[index].min ?? 0)) throw new Error('class breaks overlap')
      }
    }

    const rawVariables = [...(input.visualVariables ?? [])]
    if (rawVariables.length > this.#budgets.maxVisualVariables) throw new Error('visual variable budget exceeded')
    const variableKinds = new Set<ArcGisVisualVariableKind>()
    const visualVariables = rawVariables.map(variable => {
      if (!VISUAL_KINDS.has(variable.kind)) throw new Error('unsupported visual variable')
      if (variableKinds.has(variable.kind)) throw new Error('duplicate visual variable kind')
      variableKinds.add(variable.kind)
      const variableField = text(variable.field, 'visual variable field', this.#budgets.maxFieldLength, FIELD)
      if (!this.#fields.has(variableField)) throw new Error('visual variable field is not admitted')
      if (variable.stops.length < 2 || variable.stops.length > this.#budgets.maxStopsPerVariable) throw new Error('visual variable stop budget exceeded')
      let previous = Number.NEGATIVE_INFINITY
      const stops = variable.stops.map(stop => {
        const value = finite(stop.value, 'visual stop value')
        const output = finite(stop.output, 'visual stop output')
        if (value <= previous) throw new Error('visual variable stops must be strictly increasing')
        previous = value
        if (variable.kind === 'opacity' && (output < 0 || output > 1)) throw new Error('opacity output must be between zero and one')
        if ((variable.kind === 'size' || variable.kind === 'rotation') && output < 0) throw new Error('visual output must be non-negative')
        return Object.freeze({ value, output })
      })
      return freezeVariable({ kind: variable.kind, field: variableField, stops })
    })
    visualVariables.sort((a, b) => a.kind.localeCompare(b.kind))

    const stopCount = visualVariables.reduce((sum, variable) => sum + variable.stops.length, 0)
    const estimatedGpuBytes = 256 + classes.length * 192 + visualVariables.length * 128 + stopCount * 32
    if (estimatedGpuBytes > this.#budgets.maxEstimatedGpuBytes) throw new Error('renderer GPU budget exceeded')
    const frozenClasses = Object.freeze(classes)
    const frozenVariables = Object.freeze(visualVariables)
    const canonical = JSON.stringify([id, input.kind, field ?? null, symbolKey ?? null, frozenClasses, frozenVariables, estimatedGpuBytes, revision])
    return Object.freeze({ id, kind: input.kind, ...(field ? { field } : {}), ...(symbolKey ? { symbolKey } : {}), classes: frozenClasses, visualVariables: frozenVariables, estimatedGpuBytes, revision, fingerprint: hash(canonical) })
  }
}
