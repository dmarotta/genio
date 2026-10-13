import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inputSchemaFromOpenApi, schemaDefaults, validateValues, type JsonSchema } from '@shared/fal-schema'

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

describe('agent input constraints', () => {
  it('validates required fields, ranges, lengths, enums and file values before the paid call', () => {
    const m = sfx()
    expect(validateValues(m, {})).toEqual({ text: 'Required.' })
    expect(validateValues(m, { text: 'x'.repeat(451), duration_seconds: 30, prompt_influence: 'high', output_format: 'flac' })).toEqual({
      text: '451/450 characters: too long.',
      duration_seconds: 'At most 22.',
      prompt_influence: 'Must be a number.',
      output_format: expect.stringMatching(/^One of: mp3_22050_32/)
    })
    expect(validateValues(m, { text: 'door creak', duration_seconds: 2, loop: true })).toEqual({})
    const me = meshy()
    expect(validateValues(me, { image_url: 'C:/art/golem.png' }).image_url).toMatch(/URL, an earlier output or a local file/)
    expect(validateValues(me, { image_url: '@file:C:/art/golem.png', target_polycount: 10.5 })).toEqual({ target_polycount: 'Must be a whole number.' })
  })

  it('retains schema defaults for generation and estimates', () => {
    expect(schemaDefaults(sfx())).toMatchObject({ prompt_influence: 0.3, output_format: 'mp3_44100_128', loop: false })
    expect(schemaDefaults(undefined)).toEqual({})
  })
  it('checks nullable types, file arrays and boolean values', () => {
    const schema: JsonSchema = { properties: {
      count: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      image_urls: { type: 'array', items: { type: 'string' } },
      loop: { type: 'boolean' }
    } }
    expect(validateValues(schema, { count: 0, image_urls: ['bad'], loop: 1 })).toMatchObject({ count: 'At least 1.', image_urls: expect.any(String), loop: 'Must be on or off.' })
    expect(validateValues(schema, { count: null, image_urls: ['https://example.com/a.png'], loop: false })).toEqual({})
  })
})
