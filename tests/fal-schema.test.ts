import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildInput, coerceText, fieldErrorsFromMessage, fileFieldFor, initialValues, inputSchemaFromOpenApi, promptField, schemaDefaults, schemaToForm, validateValues,
  type JsonSchema
} from '@shared/fal-schema'

// real queue OpenAPI documents from fal.ai (2026-10-13)
const doc = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fal', `${name}.json`), 'utf8'))
const schemaOf = (name: string, endpoint: string): JsonSchema => {
  const s = inputSchemaFromOpenApi(doc(name), endpoint)
  if (!s) throw new Error(`no schema in ${name}`)
  return s
}

const SFX = 'fal-ai/elevenlabs/sound-effects/v2'
const sfx = (): JsonSchema => schemaOf('fal-ai__elevenlabs__sound-effects__v2', SFX)
const meshy = (): JsonSchema => schemaOf('meshy__v7.1__image-to-3d', 'meshy/v7.1/image-to-3d')

describe('OpenAPI → input schema', () => {
  it('takes the POST body of /<endpoint> and inlines component refs', () => {
    const s = sfx()
    expect(s.required).toEqual(['text'])
    expect(s['x-fal-order-properties']).toEqual(['text', 'duration_seconds', 'prompt_influence', 'output_format', 'loop'])
    const flux = schemaOf('fal-ai__flux__dev', 'fal-ai/flux/dev')
    // ImageSize was a $ref inside anyOf: now inline
    const size = flux.properties!.image_size
    expect(JSON.stringify(size)).not.toContain('$ref')
    expect(size.anyOf?.some((v) => v.properties && 'width' in v.properties)).toBe(true)
  })

  it('returns undefined for something that is not an OpenAPI document', () => {
    expect(inputSchemaFromOpenApi({}, 'x/y')).toBeUndefined()
    expect(inputSchemaFromOpenApi(null, 'x/y')).toBeUndefined()
  })
})

describe('schema → form model', () => {
  it('puts required fields first, pinned essentials next, the rest under More options, plumbing hidden', () => {
    const m = schemaToForm(sfx(), { pin: ['duration_seconds', 'loop', 'output_format'], defaults: { output_format: 'pcm_48000' } })
    expect(m.required.map((f) => f.key)).toEqual(['text'])
    expect(m.essentials.map((f) => f.key)).toEqual(['duration_seconds', 'loop', 'output_format'])
    expect(m.more.map((f) => f.key)).toEqual(['prompt_influence'])
    const flux = schemaToForm(schemaOf('fal-ai__flux__dev', 'fal-ai/flux/dev'))
    expect(flux.hidden.map((f) => f.key).sort()).toEqual(['enable_safety_checker', 'sync_mode'])
    expect(flux.fields.find((f) => f.key === 'sync_mode')?.section).toBe('hidden')
  })

  it('pins never invent fields the schema does not have', () => {
    const m = schemaToForm(sfx(), { pin: ['nope', 'loop'], defaults: { nope: 1 } })
    expect(m.essentials.map((f) => f.key)).toEqual(['loop'])
    expect(m.fields.some((f) => f.key === 'nope')).toBe(false)
  })

  it('picks widgets from types, enums, ranges and file hints', () => {
    const m = schemaToForm(sfx())
    const by = (k: string) => m.fields.find((f) => f.key === k)!
    expect(by('text')).toMatchObject({ widget: 'prompt', required: true, maxLength: 450 })
    expect(by('duration_seconds')).toMatchObject({ widget: 'slider', valueType: 'number', min: 0.5, max: 22, nullable: true, hasDefault: false })
    expect(by('prompt_influence')).toMatchObject({ widget: 'slider', default: 0.3, hasDefault: true })
    expect(by('output_format')).toMatchObject({ widget: 'select', default: 'mp3_44100_128' })
    expect(by('loop')).toMatchObject({ widget: 'toggle', default: false })

    const me = schemaToForm(meshy())
    const mb = (k: string) => me.fields.find((f) => f.key === k)!
    expect(mb('image_url')).toMatchObject({ widget: 'file', required: true, fileKind: 'image' })
    expect(mb('texture_image_url')).toMatchObject({ widget: 'file', required: false, nullable: true })
    expect(mb('model_type')).toMatchObject({ widget: 'segmented', options: ['standard', 'lowpoly', 'smart-topology'] })
    expect(mb('target_polycount')).toMatchObject({ widget: 'slider', valueType: 'integer', min: 100, max: 300000, step: 1 })

    const nb = schemaToForm(schemaOf('google__nano-banana-2.1__edit', 'google/nano-banana-2.1/edit'))
    const nbf = (k: string) => nb.fields.find((f) => f.key === k)!
    expect(nbf('image_urls')).toMatchObject({ widget: 'files', fileKind: 'image' })
    expect(nbf('seed')).toMatchObject({ widget: 'seed', nullable: true })
    expect(nbf('aspect_ratio')).toMatchObject({ widget: 'select', default: 'auto' })

    const flux = schemaToForm(schemaOf('fal-ai__flux__dev', 'fal-ai/flux/dev'))
    expect(flux.fields.find((f) => f.key === 'image_size')).toMatchObject({ widget: 'image_size', default: 'landscape_4_3' })
    expect(flux.fields.find((f) => f.key === 'image_size')?.options).toContain('square_hd')

    const rc = schemaToForm(schemaOf('recraft__v4__style__text-to-image', 'recraft/v4/style/text-to-image'))
    expect(rc.fields.find((f) => f.key === 'colors')?.widget).toBe('json')
    expect(rc.fields.find((f) => f.key === 'image_urls')).toMatchObject({ widget: 'files', nullable: true })
  })

  it('starts optional fields empty; only required defaults and Genio essentials are filled', () => {
    const over = { pin: ['model_type', 'target_polycount', 'enable_pbr', 'topology'], defaults: { model_type: 'lowpoly', target_polycount: 10000, enable_pbr: true } }
    const m = schemaToForm(meshy(), over)
    expect(m.essentials.find((f) => f.key === 'model_type')?.genioDefault).toBe('lowpoly')
    const v = initialValues(m)
    expect(v).toEqual({ model_type: 'lowpoly', target_polycount: 10000, enable_pbr: true })
    // topology is pinned without a Genio default: left empty, FAL's default applies
    expect('topology' in v).toBe(false)
    // remembered essentials (per model, per world) win over Genio's
    expect(initialValues(m, { target_polycount: 4000, ultra_mode: true })).toEqual({ model_type: 'lowpoly', target_polycount: 4000, enable_pbr: true })
  })

  it('empty means not sent; unknown keys from the JSON tab are kept', () => {
    expect(buildInput({ text: 'boom', duration_seconds: undefined, output_format: '', loop: false, seed: null, image_urls: [], extra_key: { a: 1 } })).toEqual({
      text: 'boom',
      loop: false,
      extra_key: { a: 1 }
    })
    expect(buildInput({ image_urls: ['', 'https://x/a.png'] })).toEqual({ image_urls: ['https://x/a.png'] })
  })

  it('coerces typed text', () => {
    const num = { valueType: 'number' as const, widget: 'number' as const }
    expect(coerceText(num, ' 2.5 ')).toBe(2.5)
    expect(coerceText(num, '')).toBeUndefined()
    expect(coerceText(num, 'abc')).toBe('abc')
    expect(coerceText({ valueType: 'any', widget: 'json' }, '[{"r":1}]')).toEqual([{ r: 1 }])
    expect(coerceText({ valueType: 'string', widget: 'select', options: [512, 1024] }, '1024')).toBe(1024)
  })

  it('validates required fields, ranges, lengths, enums and file values before the paid call', () => {
    const m = schemaToForm(sfx())
    expect(validateValues(m, {})).toEqual({ text: 'Required.' })
    expect(validateValues(m, { text: 'x'.repeat(451), duration_seconds: 30, prompt_influence: 'high', output_format: 'flac' })).toEqual({
      text: '451/450 characters: too long.',
      duration_seconds: 'At most 22.',
      prompt_influence: 'Must be a number.',
      output_format: expect.stringMatching(/^One of: mp3_22050_32/)
    })
    expect(validateValues(m, { text: 'door creak', duration_seconds: 2, loop: true })).toEqual({})
    const me = schemaToForm(meshy())
    expect(validateValues(me, { image_url: 'C:/art/golem.png' }).image_url).toMatch(/URL, an earlier output or a local file/)
    expect(validateValues(me, { image_url: '@file:C:/art/golem.png', target_polycount: 10.5 })).toEqual({ target_polycount: 'Must be a whole number.' })
  })

  it('maps FAL 422 details back onto fields', () => {
    expect(fieldErrorsFromMessage('FAL error 422: text: String should have at most 450 characters; image_url: field required; other: x', ['text', 'image_url'])).toEqual({
      text: 'String should have at most 450 characters',
      image_url: 'field required'
    })
    expect(fieldErrorsFromMessage('FAL error 500: Internal Server Error', ['text'])).toEqual({})
  })

  it('finds where a chained file and prompt go', () => {
    const me = schemaToForm(meshy())
    expect(fileFieldFor(me, 'image')?.key).toBe('image_url')
    expect(fileFieldFor(me, 'audio')).toBeUndefined()
    expect(promptField(schemaToForm(sfx()))?.key).toBe('text')
    expect(schemaDefaults(sfx())).toMatchObject({ prompt_influence: 0.3, output_format: 'mp3_44100_128', loop: false })
  })
})
