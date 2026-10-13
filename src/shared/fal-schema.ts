/**
 * FAL input schema → form model (shared by the FAL screen and its tests).
 * FAL publishes an OpenAPI 3.0 document per endpoint; the input is the POST
 * body of path "/<endpoint>". Fields: required first, then the catalogue's
 * pinned essentials (with Genio defaults), then More options, which start
 * empty: an empty field is not sent, so FAL's own default applies.
 */
import type { FalOutputKind } from './api'

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

// ---------------------------------------------------------------- form model

export type FieldWidget = 'prompt' | 'text' | 'number' | 'slider' | 'seed' | 'toggle' | 'segmented' | 'select' | 'file' | 'files' | 'image_size' | 'json'
export type FieldSection = 'required' | 'essential' | 'more' | 'hidden'
export type ValueType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any'

export interface FormField {
  key: string
  title: string
  description?: string
  widget: FieldWidget
  section: FieldSection
  required: boolean
  valueType: ValueType
  nullable: boolean
  /** FAL's default, shown as the placeholder of an empty field */
  default?: unknown
  hasDefault: boolean
  /** Genio's (catalogue or world) default for an essential */
  genioDefault?: unknown
  options?: (string | number)[]
  min?: number
  max?: number
  exclusiveMin?: number
  exclusiveMax?: number
  step?: number
  maxLength?: number
  minLength?: number
  fileKind?: FalOutputKind | 'any'
  /** a ready-made placeholder from the schema examples */
  example?: string
}

export interface FormModel {
  fields: FormField[]
  required: FormField[]
  essentials: FormField[]
  more: FormField[]
  hidden: FormField[]
}

export interface FormOverrides {
  pin?: string[]
  defaults?: Record<string, unknown>
  hide?: string[]
}

/** Never shown: sync_mode must stay off (outputs must be URLs), the rest is plumbing. */
export const ALWAYS_HIDDEN = new Set(['sync_mode'])
const PLUMBING = new Set(['enable_safety_checker'])
const PROMPTISH = new Set(['prompt', 'text', 'negative_prompt', 'texture_prompt', 'preview_text', 'system_prompt', 'style_prompt', 'lyrics'])
const FILE_KEY = /(^|_)urls?$/
const SEED_KEY = /(^|_)seed$/

const typeOf = (s: JsonSchema): string | undefined => (Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type)

function fileKindOf(key: string, s: JsonSchema): FalOutputKind | 'any' {
  const ui = typeof s._fal_ui_field === 'string' ? s._fal_ui_field : ''
  const hay = `${ui} ${key}`.toLowerCase()
  if (/image|mask|texture|style|reference|photo|frame/.test(hay)) return 'image'
  if (/audio|voice|sound|music|speech/.test(hay)) return 'audio'
  if (/video/.test(hay)) return 'video'
  if (/model|mesh|glb|obj|fbx/.test(hay)) return 'model'
  return 'any'
}

function example(s: JsonSchema): string | undefined {
  const e = Array.isArray(s.examples) ? s.examples[0] : undefined
  return typeof e === 'string' ? e : typeof e === 'number' ? String(e) : undefined
}

function stepOf(vt: ValueType, s: JsonSchema): number | undefined {
  if (typeof s.multipleOf === 'number') return s.multipleOf
  if (vt === 'integer') return 1
  if (typeof s.minimum === 'number' && typeof s.maximum === 'number') {
    const span = s.maximum - s.minimum
    return span <= 1 ? 0.01 : span <= 20 ? 0.1 : 1
  }
  return undefined
}

/** One property → field. anyOf [T, null] is nullable T; anyOf [ImageSize, enum] is the size picker. */
export function fieldFrom(key: string, raw: JsonSchema, required: boolean): Omit<FormField, 'section' | 'genioDefault'> {
  const variants = (raw.anyOf ?? raw.oneOf ?? []).filter(isObj) as JsonSchema[]
  const nullable = variants.some((v) => typeOf(v) === 'null') || (Array.isArray(raw.type) && raw.type.includes('null'))
  const real = variants.filter((v) => typeOf(v) !== 'null')
  const outer: JsonSchema = { ...raw, anyOf: undefined, oneOf: undefined }
  const s: JsonSchema = real.length === 1 ? { ...real[0], ...stripUndef(outer), type: typeOf(real[0]) ?? typeOf(outer) } : outer
  const base = {
    key,
    title: raw.title ?? key.replace(/_/g, ' '),
    description: raw.description,
    required,
    nullable,
    default: raw.default,
    hasDefault: 'default' in raw && raw.default !== null
  }
  if (real.length > 1) {
    const en = real.find((v) => Array.isArray(v.enum))
    const sized = real.find((v) => isObj(v.properties) && 'width' in v.properties && 'height' in v.properties)
    if (en && sized) return { ...base, widget: 'image_size', valueType: 'any', options: en.enum as (string | number)[], example: example(raw) }
    return { ...base, widget: 'json', valueType: 'any' }
  }
  const t = typeOf(s)
  const vt: ValueType = t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'array' || t === 'object' ? t : Array.isArray(s.enum) ? 'string' : 'any'
  const isFileish = FILE_KEY.test(key) || (typeof s._fal_ui_field === 'string' && /image|audio|video|file/.test(s._fal_ui_field))
  if (isFileish && vt === 'string') return { ...base, widget: 'file', valueType: vt, fileKind: fileKindOf(key, s), example: example(s) }
  if (isFileish && vt === 'array' && (!s.items || typeOf(s.items) === 'string')) return { ...base, widget: 'files', valueType: vt, fileKind: fileKindOf(key, s) }
  if (Array.isArray(s.enum) && s.enum.every((x) => typeof x === 'string' || typeof x === 'number')) {
    const options = s.enum as (string | number)[]
    return { ...base, widget: options.length <= 5 ? 'segmented' : 'select', valueType: vt, options }
  }
  if (vt === 'boolean') return { ...base, widget: 'toggle', valueType: vt }
  if (vt === 'number' || vt === 'integer') {
    const min = s.minimum
    const max = s.maximum
    const widget: FieldWidget = SEED_KEY.test(key) ? 'seed' : typeof min === 'number' && typeof max === 'number' ? 'slider' : 'number'
    return {
      ...base,
      widget,
      valueType: vt,
      min,
      max,
      exclusiveMin: s.exclusiveMinimum,
      exclusiveMax: s.exclusiveMaximum,
      step: stepOf(vt, s),
      example: example(s)
    }
  }
  if (vt === 'string') {
    const long = PROMPTISH.has(key) || (s.maxLength ?? 0) > 300 || /prompt/.test(key)
    return { ...base, widget: long ? 'prompt' : 'text', valueType: vt, maxLength: s.maxLength, minLength: s.minLength, example: example(s) }
  }
  return { ...base, widget: 'json', valueType: vt }
}

function stripUndef(o: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as JsonSchema
}

/** Order: FAL's x-fal-order-properties, then any remaining keys. */
function orderedKeys(schema: JsonSchema): string[] {
  const props = Object.keys(schema.properties ?? {})
  const order = (schema['x-fal-order-properties'] ?? []).filter((k) => props.includes(k))
  return [...order, ...props.filter((k) => !order.includes(k))]
}

export function schemaToForm(schema: JsonSchema | undefined, over: FormOverrides = {}): FormModel {
  const props = schema?.properties ?? {}
  const req = new Set(schema?.required ?? [])
  const pin = (over.pin ?? []).filter((k) => k in props)
  const hide = new Set(over.hide ?? [])
  const fields: FormField[] = []
  for (const key of orderedKeys(schema ?? {})) {
    const f = fieldFrom(key, props[key] ?? {}, req.has(key))
    const deprecated = props[key]?.deprecated === true
    const section: FieldSection = f.required
      ? 'required'
      : ALWAYS_HIDDEN.has(key) || hide.has(key) || deprecated
        ? 'hidden'
        : pin.includes(key)
          ? 'essential'
          : PLUMBING.has(key)
            ? 'hidden'
            : 'more'
    const field: FormField = { ...f, section }
    if (section === 'essential' && over.defaults && key in over.defaults) field.genioDefault = over.defaults[key]
    fields.push(field)
  }
  const essentials = pin.map((k) => fields.find((f) => f.key === k && f.section === 'essential')).filter((f): f is FormField => !!f)
  return {
    fields,
    required: fields.filter((f) => f.section === 'required'),
    essentials,
    more: fields.filter((f) => f.section === 'more'),
    hidden: fields.filter((f) => f.section === 'hidden')
  }
}

/** Starting values: required fields with a schema default, and essentials with a Genio default. Everything else starts empty. */
export function initialValues(model: FormModel, remembered: Record<string, unknown> = {}): Record<string, unknown> {
  const v: Record<string, unknown> = {}
  for (const f of model.required) if (f.hasDefault) v[f.key] = f.default
  for (const f of model.essentials) {
    if (f.key in remembered && !isEmptyValue(remembered[f.key])) v[f.key] = remembered[f.key]
    else if (f.genioDefault !== undefined) v[f.key] = f.genioDefault
  }
  return v
}

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0)
}

/** The request body: every non-empty value (unknown keys from the JSON tab included). Empty = not sent. */
export function buildInput(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    if (isEmptyValue(v)) continue
    out[k] = Array.isArray(v) ? v.filter((x) => !isEmptyValue(x)) : v
    if (Array.isArray(out[k]) && (out[k] as unknown[]).length === 0) delete out[k]
  }
  return out
}

/** Text from an input box → typed value (blank → undefined, i.e. not sent). */
export function coerceText(field: Pick<FormField, 'valueType' | 'widget' | 'options'>, raw: string): unknown {
  const t = raw.trim()
  if (!t) return undefined
  if (field.valueType === 'number' || field.valueType === 'integer' || field.widget === 'seed') {
    const n = Number(t)
    return Number.isFinite(n) ? n : raw
  }
  if (field.options?.length && field.options.every((o) => typeof o === 'number')) {
    const n = Number(t)
    return Number.isFinite(n) ? n : raw
  }
  if (field.widget === 'json' || field.valueType === 'array' || field.valueType === 'object' || field.valueType === 'any') {
    if (/^[[{"]|^-?\d|^(true|false|null)$/.test(t)) {
      try {
        return JSON.parse(t) as unknown
      } catch {
        return raw
      }
    }
  }
  return raw
}

const FILE_VALUE = /^(https?:\/\/|data:|@file:)/i

/** Checked before the paid call; keys are field keys. */
export function validateValues(model: FormModel, values: Record<string, unknown>): Record<string, string> {
  const errs: Record<string, string> = {}
  for (const f of model.fields) {
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
    if (f.widget === 'file') {
      if (typeof v !== 'string' || !FILE_VALUE.test(v.trim())) errs[f.key] = 'Use a URL, an earlier output or a local file.'
      continue
    }
    if (f.widget === 'files') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !FILE_VALUE.test(x.trim()))) errs[f.key] = 'Use URLs, earlier outputs or local files.'
      continue
    }
    if ((f.widget === 'segmented' || f.widget === 'select') && f.options && !f.options.includes(v as string | number)) {
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

/**
 * FAL 422s arrive as "FAL error 422: image_url: field required; prompt: too long"
 * (src/main/fal.ts detailText): map "key: msg" parts back onto the form.
 */
export function fieldErrorsFromMessage(message: string, keys: string[]): Record<string, string> {
  const errs: Record<string, string> = {}
  const body = message.replace(/^FAL error \d+:\s*/, '')
  for (const part of body.split(/;\s*/)) {
    const m = /^([\w.[\]]+):\s*(.+)$/.exec(part.trim())
    if (!m) continue
    const key = m[1].split(/[.[]/)[0]
    if (keys.includes(key)) errs[key] = m[2]
  }
  return errs
}

/** The input key a file of this kind goes into (required file fields first). */
export function fileFieldFor(model: FormModel, kind: FalOutputKind): FormField | undefined {
  const files = model.fields.filter((f) => (f.widget === 'file' || f.widget === 'files') && f.section !== 'hidden')
  const fits = (f: FormField): boolean => f.fileKind === kind || f.fileKind === 'any'
  return files.find((f) => f.required && fits(f)) ?? files.find(fits)
}

/** The schema's defaults (what FAL uses for fields left empty), for estimates. */
export function schemaDefaults(schema: JsonSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(schema?.properties ?? {})) if (s && 'default' in s && s.default !== null) out[k] = s.default
  return out
}

/** The main text field (prompt / text) of a model. */
export function promptField(model: FormModel): FormField | undefined {
  return model.fields.find((f) => f.widget === 'prompt' && f.required) ?? model.fields.find((f) => f.widget === 'prompt' && (f.key === 'prompt' || f.key === 'text'))
}
