import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderBrief, unitBriefSections, type BriefInput } from '../src/main/brief'
import { BUILTIN_HARNESSES } from '../src/main/harness'
import { capabilitiesBrief, capabilityGaps, UNIT_CAPABILITIES, unitLaunchExtras, unitSkillDir } from '../src/main/unitskills'

const PLUGIN = path.join('C:\\genio', 'skills', 'genio')
const fwd = (p: string): string => p.replace(/\\/g, '/')
const base: BriefInput = {
  taskId: 't-a1', kind: 'ship', project: 'game', worktree: 'C:\\genio\\worktrees\\game\\t-a1', branch: 'genio/t-a1', baseBranch: 'main',
  intent: 'x', statusFile: 'C:\\genio\\state\\t-a1.status', inboxDir: 'C:\\genio\\state\\t-a1.inbox', taskDataDir: 'C:\\genio\\data\\t-a1'
}
/** The four unit kinds as crew.ts deploys them: Recon, Build, and a Build with the Modeller or Generator flag. */
const KINDS = {
  recon: { kind: 'scout' },
  build: { kind: 'ship' },
  modeller: { kind: 'ship', modeller: true },
  generator: { kind: 'ship', generator: true }
} as const
const HARNESSES = BUILTIN_HARNESSES.map((h) => h.id)
type Kind = keyof typeof KINDS

/** A unit's brief as crew.ts renders it at deploy. The brief takes no runtime: every harness reads the same one. */
const briefFor = (kind: Kind, o: Partial<Parameters<typeof unitBriefSections>[0]> = {}): string => {
  const k = KINDS[kind]
  const sections = unitBriefSections({ pluginDir: PLUGIN, taskDataDir: base.taskDataDir, engine: 'unity', ...k, ...o })
  return renderBrief({ ...base, kind: k.kind, mode: k.kind === 'ship' ? 'local-only' : undefined, ...sections })
}
const toolsSection = (brief: string): string => brief.split('\n# Tools\n')[1]?.split('\n# ')[0] ?? ''
/** Every kind's gaps against the full capability set: empty when the set is uniform. */
const gapsByKind = (briefs: Record<string, string>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(briefs).map(([k, b]) => [k, capabilityGaps(b, PLUGIN)]).filter(([, g]) => g.length))

describe('every unit kind and runtime gets every capability', () => {
  it('lists the same capabilities, each with its own prerequisite, in every kind and harness brief', () => {
    const build = toolsSection(briefFor('build'))
    for (const kind of Object.keys(KINDS) as Kind[]) {
      for (const harness of HARNESSES) {
        const brief = briefFor(kind)
        expect(capabilityGaps(brief, PLUGIN), `${kind} on ${harness}`).toEqual([])
        // Only the mission rules differ: the Tools section is word for word the Build's.
        expect(toolsSection(brief), `${kind} on ${harness}`).toBe(build)
      }
    }
    expect(capabilitiesBrief()).toMatchInlineSnapshot(`
      "- Capabilities: you have every skill below, as every unit does whatever its kind (Recon, Build, Modeller, Generator) or runtime; only the mission rules differ. Each needs only its own prerequisite: assets (provider routing, placement and how to ask for spend; needs nothing), imagegen-codex (images; needs the player's ChatGPT plan; free, no approval), fal (textures, 3D, audio, music, video; needs the FAL key and a spend grant), uthana (character motions; needs the Uthana key and a spend grant), sound (SFX sets, UI sounds, ambience loops; needs nothing for local steps; its FAL steps need the FAL key and a spend grant), blender (batch modelling, export, Modeller steps; needs a local Blender), unity (compile, test, import, build, play; needs a Unity project). The Art Bible applies when the project has one.
      - Work is best done in units, and any paid call needs an approval (how to ask is in the assets skill, and under Spending below)."
    `)
    expect(build).toContain(capabilitiesBrief())
    expect(UNIT_CAPABILITIES.map((c) => c.skill)).toEqual(['assets', 'imagegen-codex', 'fal', 'uthana', 'sound', 'blender', 'unity'])
  })

  it('keeps the mission rules per kind', () => {
    const recon = briefFor('recon')
    expect(recon).toContain('Delivery contract: kind=recon')
    expect(recon).toContain('Never push, open a PR, or commit to shared branches')
    expect(recon).not.toContain('# Modeller')
    expect(recon).not.toContain('# Generator')
    expect(briefFor('modeller', { claims: ['Assets/Models/tower.fbx'] })).toContain('Claims: Genio gave you `Assets/Models/tower.fbx`')
    expect(briefFor('modeller')).toContain('Modeller delivery')
    expect(briefFor('generator', { claims: ['Assets/Audio/door.wav'] })).toContain('Claims: Genio gave you `Assets/Audio/door.wav`')
    expect(briefFor('build')).not.toMatch(/# Modeller|# Generator/)
  })

  it('fails when one kind loses a skill', () => {
    const briefs = Object.fromEntries((Object.keys(KINDS) as Kind[]).map((k) => [k, briefFor(k)]))
    expect(gapsByKind(briefs)).toEqual({})
    const sound = `${fwd(unitSkillDir(PLUGIN, 'sound'))}/SKILL.md`
    const lost = { ...briefs, modeller: briefs.modeller.split('\n').filter((l) => !l.includes(sound)).join('\n') }
    expect(gapsByKind(lost)).toEqual({ modeller: ['sound'] })
    const noBlender = { ...briefs, recon: briefs.recon.replaceAll(`${fwd(unitSkillDir(PLUGIN, 'blender'))}/SKILL.md`, '') }
    expect(gapsByKind(noBlender)).toEqual({ recon: ['blender'] })
  })
})

describe('every runtime gets the same keys and skill paths', () => {
  const opts = { pluginDir: PLUGIN, falKey: 'fal-key', uthanaKey: 'uthana-key', dataDir: 'C:/genio/data', taskDataDir: 'C:/genio/data/t-a1', helpDocs: 'C:/genio/docs' }

  it.each(HARNESSES)('%s gets every skill path, helper folder and key', (harness) => {
    const { env, args } = unitLaunchExtras(harness, opts)
    for (const c of UNIT_CAPABILITIES) expect(env[c.env], c.env).toBe(fwd(unitSkillDir(PLUGIN, c.skill)))
    expect(env).toMatchObject({
      GENIO_UNITY: 'C:/genio/skills/genio/skills/unity/scripts/genio-unity.mjs',
      GENIO_BLENDER_SCRATCH: 'C:/genio/data/t-a1/blender',
      GENIO_MODELLER_DATA: 'C:/genio/data/t-a1/modeller',
      GENIO_SOUND_DATA: 'C:/genio/data/t-a1/sound',
      GENIO_CODEX_IMAGE_SCRATCH: 'C:/genio/data/codex-image',
      GENIO_UTHANA_DATA: 'C:/genio/data/uthana',
      GENIO_HELP_DOCS: 'C:/genio/docs',
      FAL_KEY: 'fal-key',
      UTHANA_API_KEY: 'uthana-key'
    })
    // Claude Code also loads the plugin natively; that is how it finds skills, not an extra capability.
    expect(args).toEqual(harness === 'claude' ? ['--plugin-dir', PLUGIN] : [])
  })

  it('differs between runtimes only in the Claude plugin flag', () => {
    const envs = HARNESSES.map((h) => unitLaunchExtras(h, opts).env)
    for (const env of envs) expect(env).toEqual(envs[0])
  })
})
