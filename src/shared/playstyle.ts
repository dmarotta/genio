/**
 * Playstyle titles for the Character Sheet. Deterministic: the last landed
 * missions on the dispatch scorecard, grouped into category families. A title
 * needs enough samples and a clear majority; otherwise the player is an
 * Adventurer. Titles once earned stay available to equip (src/main/stats.ts).
 */
import type { OutcomeRecord } from './dispatch'
import type { PlaystyleId, PlaystyleTitleId, TaskCategory } from './types'

export const PLAYSTYLE_RULES = { window: 20, minSamples: 5, majority: 0.6 } as const

export const PLAYSTYLES: { id: PlaystyleId; name: string; work: string; categories: TaskCategory[] }[] = [
  { id: 'builder', name: 'Builder', work: 'features, UI, refactors, chores or docs', categories: ['feature', 'ui', 'refactor', 'chore', 'docs'] },
  { id: 'scout', name: 'Scout', work: 'recons', categories: ['recon-design', 'large-context'] },
  { id: 'artificer', name: 'Artificer', work: 'art or graphics', categories: ['art', 'graphics'] },
  { id: 'warden', name: 'Warden', work: 'fixes, tests, reviews or CI', categories: ['bugfix', 'tests', 'review', 'build-ci'] }
]

export const titleName = (id: PlaystyleTitleId): string => PLAYSTYLES.find((p) => p.id === id)?.name ?? 'Adventurer'

export const isPlaystyleId = (v: unknown): v is PlaystyleId => PLAYSTYLES.some((p) => p.id === v)

type Sample = Pick<OutcomeRecord, 'kind' | 'category' | 'categoryGuessed'>

/**
 * A recon is scouting whatever its topic; builds go by category. A build whose
 * category was guessed or is not one we know is unknown: it has no family.
 */
export function familyOf(r: Sample): PlaystyleId | undefined {
  if (r.kind === 'scout') return 'scout'
  if (r.categoryGuessed) return undefined
  return PLAYSTYLES.find((p) => p.categories.includes(r.category))?.id
}

export interface PlaystyleReading {
  title: PlaystyleTitleId
  samples: number
  counts: Record<PlaystyleId, number>
  why: string
}

/** Records in scorecard order (oldest first); only landed missions of a known family count. */
export function classifyPlaystyle(records: readonly (Sample & Pick<OutcomeRecord, 'landed'>)[]): PlaystyleReading {
  const { window, minSamples, majority } = PLAYSTYLE_RULES
  const recent = records.flatMap((r) => {
    const family = r.landed ? familyOf(r) : undefined
    return family ? [family] : []
  }).slice(-window)
  const counts: Record<PlaystyleId, number> = { builder: 0, scout: 0, artificer: 0, warden: 0 }
  for (const family of recent) counts[family]++
  const samples = recent.length
  if (samples < minSamples) {
    return { title: 'adventurer', samples, counts, why: `Land ${minSamples} missions to earn a title · ${samples} so far` }
  }
  const [top] = PLAYSTYLES.map((p) => ({ p, n: counts[p.id] })).sort((a, b) => b.n - a.n)
  const share = top.n / samples
  if (share >= majority) {
    return { title: top.p.id, samples, counts, why: `${top.n} of last ${samples} landings were ${top.p.work} (${Math.round(share * 100)}%)` }
  }
  const mix = PLAYSTYLES.filter((p) => counts[p.id])
    .sort((a, b) => counts[b.id] - counts[a.id])
    .map((p) => `${p.name} ${counts[p.id]}`)
    .join(' · ')
  return { title: 'adventurer', samples, counts, why: `No style above ${Math.round(majority * 100)}% in last ${samples} landings · ${mix}` }
}
