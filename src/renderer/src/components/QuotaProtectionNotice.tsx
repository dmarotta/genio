import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { LEVEL_RANK, planLabel, type PlanId, type PlanStatus } from '@shared/usage-mode'
import { settingAnchor } from '@shared/settings-index'
import { openSettings } from '../lib/settings-nav'
import { useStore } from '../store'
import { useUsagePolicy } from './PlanMeter'

// Shared by both surfaces; persisted so reopening a window never repeats a dismissed level.
const dismissed = new Map<string, number>()
const listeners = new Set<() => void>()
let revision = 0
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  const changed = (): void => { revision++; listener() }
  window.addEventListener('storage', changed)
  return () => { listeners.delete(listener); window.removeEventListener('storage', changed) }
}
const snapshot = (): number => revision
const keyFor = (project: string, plan: PlanId): string => `genio.quota-dismissed.${project}.${plan}`
const dismissedRank = (key: string): number => {
  try { return Math.max(dismissed.get(key) ?? 0, Number(localStorage.getItem(key) ?? 0)) } catch { return dismissed.get(key) ?? 0 }
}

export function protectionText(p: PlanStatus): string {
  const name = planLabel(p.plan)
  if (p.level === 'warm') return `${name} is at 70%+ used, so Genio runs one ${name} unit at a time with lower automatic effort.`
  if (p.level === 'hot') return `${name} is at 85%+ used: no new automatic units.`
  return `${name} ${p.rejected ? 'reported a limit' : 'is at 95%+ used'}: automatic units and low-priority quests wait.`
}

export function QuotaProtectionNotice({ project }: { project: string }) {
  const enabled = useStore(s => s.settings?.quotaProtection !== false)
  const view = useUsagePolicy()
  useSyncExternalStore(subscribe, snapshot)
  const acting = enabled && view?.quotaProtection !== false
    ? (view?.plans ?? []).filter(p => p.level !== 'ok' && LEVEL_RANK[p.level] > dismissedRank(keyFor(project, p.plan)))
    : []
  if (!acting.length) return null
  const held = (view?.heldLaunches ?? []).filter(h => h.project === project && acting.some(p => p.plan === h.plan))
  const text = [...acting.map(protectionText), ...held.map(h => `Pinned “${h.title}” waits for ${planLabel(h.plan)}.`)].join(' ')
  const dismiss = (): void => {
    for (const p of acting) {
      const key = keyFor(project, p.plan)
      const rank = LEVEL_RANK[p.level]
      dismissed.set(key, rank)
      try { localStorage.setItem(key, String(rank)) } catch { /* memory still covers both surfaces */ }
    }
    revision++
    for (const listener of listeners) listener()
  }
  return <div className="chat-limit" role="status" data-quota-protection>
    <span>{text}</span>
    <button className="btn sm" onClick={() => openSettings('usage', settingAnchor('Quota protection'))}>Settings</button>
    <button className="btn sm ghost icon" aria-label="Dismiss quota protection warning" onClick={dismiss}><X size={14} /></button>
  </div>
}
