import { useEffect, useSyncExternalStore } from 'react'
import { MAX_SCREEN_FACTS, type InventoryContext } from '@shared/inventory-context'
import { navItems, type ViewId } from './railmenu'

/**
 * One shared way for screens to tell the floating Genio panel what they show. A screen calls
 * useScreenContext(view, { facts, ...inventory chips }); the panel reads the current view's entry
 * and sends it, as chips, with each message. Nothing is posted to the chat when it changes.
 */
export type Fact = { label: string; value: string }
export type ScreenPublish = Partial<Omit<InventoryContext, 'screen'>> & { facts?: (Fact | false | null | undefined)[] }

const published = new Map<string, ScreenPublish>()
const listeners = new Set<() => void>()
const notify = (): void => { for (const l of listeners) l() }
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn) } }

export function publishScreenContext(view: string, value: ScreenPublish | undefined): void {
  if (value) published.set(view, value)
  else published.delete(view)
  notify()
}
export const getScreenContext = (view: string): ScreenPublish | undefined => published.get(view)

/** A screen publishes while mounted; equal values (by content) do not re-render the panel. */
export function useScreenContext(view: ViewId, value: ScreenPublish | undefined): void {
  const key = JSON.stringify(value ?? null)
  useEffect(() => { publishScreenContext(view, value) }, [view, key])
  useEffect(() => () => publishScreenContext(view, undefined), [view])
}
export function usePublishedScreen(view: string): ScreenPublish | undefined {
  return useSyncExternalStore(subscribe, () => published.get(view))
}

/** The floating panel shows everywhere in a project window except the main Chat screen. */
export const panelVisibleOn = (view: string): boolean => view !== 'comms'

export function screenLabel(view: string): string {
  return navItems().find(v => v.id === view)?.label ?? view
}

const tidy = (s: string, max: number): string => {
  const t = s.replace(/[\u0000-\u001f\s]+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** The compact, validated-shape context a message carries: screen id/label/facts plus any Inventory chips. */
export function screenContextFor(view: string, world: string, p?: ScreenPublish): InventoryContext {
  const { facts, ...rest } = p ?? {}
  const clean = (facts ?? []).filter((f): f is Fact => !!f && !!f.value?.trim())
    .slice(0, MAX_SCREEN_FACTS).map(f => ({ label: tidy(f.label, 40), value: tidy(f.value, 300) }))
  const context: InventoryContext = { ...rest, world: rest.world || world, screen: { id: view, label: screenLabel(view), ...(clean.length ? { facts: clean } : {}) } }
  for (const k of Object.keys(context) as (keyof InventoryContext)[]) if (context[k] === undefined) delete context[k]
  return context
}

/** "a.png, b.png, c.png +12": a bounded list of visible names. */
export function listFact(names: string[], total = names.length, max = 6): string {
  const shown = names.slice(0, max)
  return shown.join(', ') + (total > shown.length ? ` +${total - shown.length}` : '')
}

/** Ask the panel to expand (e.g. Play's "Ask Genio" button). */
export const PANEL_OPEN_EVENT = 'genio-panel-open'
export function openGenioPanel(): void { window.dispatchEvent(new Event(PANEL_OPEN_EVENT)) }
