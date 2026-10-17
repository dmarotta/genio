/** Fixed, once-only feature hints. No IO or model calls live in this module. */
export type TipMoment = 'build-ready' | 'merge' | 'choice-wait' | 'generated' | 'generation-approved' | 'copy' | 'project-open'

export interface TipSignals {
  enabled: boolean
  presence: 'online' | 'dnd' | 'afk'
  playing: boolean
  replying: boolean
  dialogOpen: boolean
  /** Other cards block all tips; the waiting choice itself allows Ask Genio. */
  choiceOpen: boolean
  active: boolean
  achievements: readonly string[]
  unity: boolean
  mergesTotal: number
  choicesAnswered: number
  choiceAgeMs: number
  approvalsInWords: number
  autoLoot: boolean
  standingUsed: boolean
  artBible: boolean
  generationsToday: number
  copyMs: number
  projectBlockClone: boolean
  cloneVolumeMounted: boolean
  firstOpening: boolean
  designNotes: boolean
  setupStarted: boolean
}

export interface TipHistory {
  shown: Record<string, string>
  lastShownAt?: string
  /** Session-only; never written to disk. */
  shownThisSession?: boolean
}
export interface Tip {
  id: string
  moment: TipMoment
  when(s: TipSignals): boolean
  used(s: TipSignals): boolean
  usedAchievements: readonly string[]
  line: string
  question: string
}
const earned = (s: TipSignals, id: string): boolean => s.achievements.includes(id)
const feature = (ids: string[]) => ({ usedAchievements: ids, used: (s: TipSignals) => ids.some(id => earned(s, id)) })

export const TIPS: readonly Tip[] = [
  { id: 'play-unit', moment: 'build-ready', ...feature(['play-unit']),
    when: s => s.unity && earned(s, 'play-first'),
    line: 'You can play this build in Play before it lands: pick the unit as the source.',
    question: "How do I play a unit's build before it lands?" },
  { id: 'plans', moment: 'merge', ...feature(['plan-first']), when: s => s.mergesTotal >= 10,
    line: 'Work that needs several units in order? Ask Genio for a plan.',
    question: 'How do I use a plan for work that needs several units in order?' },
  { id: 'ask-genio', moment: 'choice-wait', ...feature(['ask-genio-choice']),
    when: s => s.active && s.choicesAnswered >= 5 && s.choiceAgeMs >= 10 * 60_000,
    line: 'Not sure? Ask Genio on the card takes the choice to the chat.',
    question: 'How does Ask Genio on a choice card work?' },
  { id: 'standing', moment: 'merge', usedAchievements: [], used: s => s.standingUsed,
    when: s => !s.autoLoot && s.approvalsInWords >= 3,
    line: 'Merging a lot? Say "keep merging everything" and Genio merges green work for 8 hours.',
    question: 'How does a standing approval to keep merging everything work?' },
  { id: 'art-bible', moment: 'generated', ...feature(['art-bible-chat', 'art-bible-edit']), when: s => !s.artBible,
    line: 'Generated art follows an Art Bible. Ask Genio to write one or link your style doc.',
    question: 'How do I write an Art Bible or link my style document?' },
  { id: 'generator', moment: 'generation-approved', ...feature(['generator-first']), when: s => s.generationsToday >= 3,
    line: 'Many assets to make? Ask Genio for a Generator unit to batch them.',
    question: 'How can a Generator unit batch my asset generation jobs?' },
  { id: 'dev-drive', moment: 'copy', usedAchievements: [], used: s => s.projectBlockClone,
    when: s => s.copyMs > 60_000 && !s.projectBlockClone && s.cloneVolumeMounted,
    line: "This project's copies are full copies. On a Dev Drive they are almost instant.",
    question: 'How does using a Dev Drive make project copies faster?' },
  { id: 'setup', moment: 'project-open', usedAchievements: [], used: s => s.setupStarted,
    when: s => s.firstOpening && !s.artBible && !s.designNotes,
    line: 'Ask Genio to set this project up: art direction, design notes, how work lands.',
    question: 'Can you guide me through setting up this project, one step at a time?' }
]

/** Calendar day in the player's local timezone, shared with persisted daily caps. */
export const tipDay = (now: number): string => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function pickTip(moment: TipMoment, s: TipSignals, history: TipHistory, now: number): Tip | null {
  if (!s.enabled || s.presence !== 'online' || s.playing || s.replying || s.dialogOpen) return null
  if (s.choiceOpen && moment !== 'choice-wait') return null
  if (history.shownThisSession || (history.lastShownAt && tipDay(Date.parse(history.lastShownAt)) === tipDay(now))) return null
  return TIPS.find(t => t.moment === moment && !history.shown[t.id] && !t.used(s) && t.when(s)) ?? null
}
