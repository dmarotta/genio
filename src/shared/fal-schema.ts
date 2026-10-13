/** FAL OpenAPI resolution, defaults and validation for agent-driven generation. */
export interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  default?: unknown
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
  maxLength?: number
  minLength?: number
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  items?: JsonSchema
  title?: string
  description?: string
  examples?: unknown[]
  $ref?: string
  deprecated?: boolean
  'x-fal-order-properties'?: string[]
  _fal_ui_field?: string
  [k: string]: unknown
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

/** Inline every #/components/schemas ref (cycles and deep nesting stop at a stub). */
export function resolveRefs(node: unknown, components: Record<string, unknown>, stack: string[] = []): unknown {
  if (Array.isArray(node)) return node.map((x) => resolveRefs(x, components, stack))
  if (!isObj(node)) return node
  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop() ?? ''
    const { $ref: _ref, ...rest } = node
    const target = components[name]
    if (!isObj(target) || stack.includes(name) || stack.length > 8) return { type: 'object', title: name, ...rest }
    return resolveRefs({ ...target, ...rest }, components, [...stack, name])
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveRefs(v, components, stack)]))
}

/** The resolved input schema of an endpoint from its queue OpenAPI document. */
export function inputSchemaFromOpenApi(doc: unknown, endpoint: string): JsonSchema | undefined {
  if (!isObj(doc) || !isObj(doc.paths)) return undefined
  const paths = doc.paths as Record<string, Obj>
  const key = `/${endpoint}` in paths ? `/${endpoint}` : Object.keys(paths).find((k) => isObj(paths[k]?.post) && !k.includes('/requests/'))
  const post = key ? (paths[key]?.post as Obj | undefined) : undefined
  const body = post && isObj(post.requestBody) ? (post.requestBody as Obj) : undefined
  const content = body && isObj(body.content) ? (body.content as Obj)['application/json'] : undefined
  const schema = isObj(content) ? content.schema : undefined
  if (!schema) return undefined
  const comps = isObj(doc.components) && isObj((doc.components as Obj).schemas) ? ((doc.components as Obj).schemas as Record<string, unknown>) : {}
  const r = resolveRefs(schema, comps)
  return isObj(r) && isObj(r.properties) ? (r as JsonSchema) : undefined
}

/** Values omitted from an agent request do not satisfy required fields. */
export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)
}

const typeOf = (s: JsonSchema): string | undefined => Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type

/** Extract only the constraints needed to validate agent inputs before a paid call. */
function constraints(key: string, raw: JsonSchema, required: boolean) {
  const real = (raw.anyOf ?? raw.oneOf ?? []).filter((v) => typeOf(v) !== 'null')
  const outer = Object.fromEntries(Object.entries(raw).filter(([k, v]) => v !== undefined && k !== 'anyOf' && k !== 'oneOf'))
  const s: JsonSchema = real.length === 1 ? { ...real[0], ...outer, type: typeOf(real[0]) ?? typeOf(raw) } : raw
  const t = typeOf(s)
  const valueType = real.length > 1 ? 'any' : t ?? (Array.isArray(s.enum) ? 'string' : 'any')
  const file = /(^|_)urls?$/.test(key) || (typeof s._fal_ui_field === 'string' && /image|audio|video|file/.test(s._fal_ui_field))
  return { key, required, valueType,
    file: file && valueType === 'string',
    files: file && valueType === 'array' && (!s.items || typeOf(s.items) === 'string'),
    options: real.length <= 1 && Array.isArray(s.enum) && s.enum.every((v) => typeof v === 'string' || typeof v === 'number') ? s.enum : undefined,
    min: s.minimum, max: s.maximum, exclusiveMin: s.exclusiveMinimum, exclusiveMax: s.exclusiveMaximum,
    maxLength: s.maxLength, minLength: s.minLength
  }
}

const FILE_VALUE = /^(https?:\/\/|data:|@file:)/i

/** Checked before the paid call; keys are field keys. */
export function validateValues(schema: JsonSchema | undefined, values: Record<string, unknown>): Record<string, string> {
  const errs: Record<string, string> = {}
  for (const [key, raw] of Object.entries(schema?.properties ?? {})) {
    const f = constraints(key, raw, schema?.required?.includes(key) ?? false)
    const v = values[f.key]
    if (isEmptyValue(v)) {
      if (f.required) errs[f.key] = 'Required.'
      continue
    }
    if (f.valueType === 'number' || f.valueType === 'integer') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errs[f.key] = 'Must be a number.'
        continue
      }
      if (f.valueType === 'integer' && !Number.isInteger(v)) errs[f.key] = 'Must be a whole number.'
      else if (f.min !== undefined && v < f.min) errs[f.key] = `At least ${f.min}.`
      else if (f.max !== undefined && v > f.max) errs[f.key] = `At most ${f.max}.`
      else if (f.exclusiveMin !== undefined && v <= f.exclusiveMin) errs[f.key] = `More than ${f.exclusiveMin}.`
      else if (f.exclusiveMax !== undefined && v >= f.exclusiveMax) errs[f.key] = `Less than ${f.exclusiveMax}.`
      continue
    }
    if (f.file) {
      if (typeof v !== 'string' || !FILE_VALUE.test(v.trim())) errs[f.key] = 'Use a URL, an earlier output or a local file.'
      continue
    }
    if (f.files) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !FILE_VALUE.test(x.trim()))) errs[f.key] = 'Use URLs, earlier outputs or local files.'
      continue
    }
    if (f.options && !f.options.includes(v as string | number)) {
      errs[f.key] = `One of: ${f.options.join(', ')}.`
      continue
    }
    if (f.valueType === 'string') {
      if (typeof v !== 'string') { errs[f.key] = 'Must be text.'; continue }
      if (f.maxLength !== undefined && v.length > f.maxLength) errs[f.key] = `${v.length}/${f.maxLength} characters: too long.`
      else if (f.minLength !== undefined && v.trim().length < f.minLength) errs[f.key] = `At least ${f.minLength} characters.`
    }
    if (f.valueType === 'boolean' && typeof v !== 'boolean') errs[f.key] = 'Must be on or off.'
  }
  return errs
}

/** The schema's defaults (what FAL uses for fields left empty), for estimates. */
export function schemaDefaults(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(schema?.properties ?? {})) if (s && 'default' in s && s.default !== null) out[k] = s.default
  return out
}
