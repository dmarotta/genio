/**
 * Level titles for the Character Sheet: one title per level, never chosen. The
 * level comes from XP (src/main/stats.ts); a family repeats as Mk I, II, III so no
 * two levels share a title. Past the last level the last title stays.
 */
export const LEVEL_TITLES: readonly string[] = [
  'Recruit', // 1
  'Rookie',
  'Apprentice',
  'Journeyman',
  'Adept', // 5
  'Operator Mk I',
  'Operator Mk II',
  'Operator Mk III',
  'Veteran',
  'Specialist', // 10
  'Expert',
  'Ace Mk I',
  'Ace Mk II',
  'Ace Mk III',
  'Elite', // 15
  'Commander Mk I',
  'Commander Mk II',
  'Commander Mk III',
  'Master',
  'Grandmaster', // 20
  'Champion Mk I',
  'Champion Mk II',
  'Champion Mk III',
  'Hero',
  'Paragon Mk I', // 25
  'Paragon Mk II',
  'Paragon Mk III',
  'Mythic',
  'Titan Mk I',
  'Titan Mk II', // 30
  'Titan Mk III',
  'Immortal',
  'Legend Mk I',
  'Legend Mk II',
  'Legend Mk III', // 35
  'Ascendant Mk I',
  'Ascendant Mk II',
  'Ascendant Mk III',
  'Hall of Famer',
  'Living Legend' // 40
]

/** the last level with a title of its own */
export const TITLE_CAP = LEVEL_TITLES.length

export function levelTitle(level: number): string {
  const n = Math.min(TITLE_CAP, Math.max(1, Math.floor(level) || 1))
  return LEVEL_TITLES[n - 1]
}

/** The title the next level brings; none at the last title. */
export function nextTitle(level: number): { title: string; level: number } | undefined {
  const n = Math.max(1, Math.floor(level) || 1)
  return n < TITLE_CAP ? { title: LEVEL_TITLES[n], level: n + 1 } : undefined
}
