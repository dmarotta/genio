/**
 * Allies: persistent allied Genios, each running from
 * an isolated base under <main>/workspaces/<name> with its own state, quest log,
 * worktrees and Genio session. Idle by default; main Genio routes in-scope
 * work to them and they report back through the parent channel (main-base
 * 'check' events). The player can also talk to an ally directly in its chat tab;
 * routed requests show up there too, marked as from Genio.
 */
import path from 'node:path'
import type { Ally } from '@shared/types'
import { patchAllyControls } from '@shared/chat'
import { bus } from './bus'
import { makeHomeCtx } from './ctx'
import { Home } from './home'
import { allyCharterFile } from './prompts'
import { modernPath } from './workspaces-migration'
import type { AlliesService, AppCtx } from './services'
import { nowIso, rid, readJson, writeJson, writeText } from './util'

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

export function createAlliesService(getCtx: () => AppCtx): AlliesService {
  // ctx.main exists before list() is first called (see createApp)
  const reg = (): string => getCtx().main.home.alliesFile

  let cache: Ally[] | undefined
  const load = (): Ally[] => {
    if (!cache) {
      cache = readJson<Ally[]>(reg(), []).map((a) => ({ ...a, home: modernPath(path.resolve(reg(), '..', '..'), a.home) }))
    }
    return cache
  }
  const persist = (): void => {
    writeJson(reg(), load())
    bus.publish({ type: 'allies', allies: [...load()] })
  }

  const svc: AlliesService = {
    list() {
      return [...load()]
    },

    async create(req) {
      const ctx = getCtx()
      const name = req.name.trim().toLowerCase()
      if (!NAME_RE.test(name) || name === 'main') throw new Error('ally names are 2-31 chars: lowercase letters, digits and dashes (not "main")')
      if (load().some((a) => a.name === name && !a.retiredAt)) throw new Error(`A project chat already exists in base ${name}`)
      if (!req.scope.trim()) throw new Error('an ally needs a routing scope')
      const mainHome = ctx.main.home
      const root = mainHome.workspaceHome(name)
      const home = new Home(root, name, mainHome)
      home.ensure()
      writeText(path.join(home.data, 'charter.md'), allyCharterFile(name, req.scope, req.charter, req.projects))
      writeText(path.join(home.root, '.genio-ally'), JSON.stringify({ name, parent: mainHome.root, createdAt: nowIso() }, null, 2))
      const ally: Ally = {
        name, scope: req.scope.trim(), charter: req.charter.trim(), projects: req.projects, model: req.model || undefined,
        effort: req.effort || undefined, home: root, createdAt: nowIso()
      }
      const list = load().filter((a) => a.name !== name)
      list.push(ally)
      cache = list
      persist()
      const hc = makeHomeCtx(home, ally)
      ctx.homes.set(name, hc)
      await hc.crew.reconcileOnStart().catch(() => undefined)
      hc.supervisor.start()
      bus.publish({ type: 'workspace', workspace: hc.workspace.info() })
      bus.toast('success', 'Genio chat ready', `Genio is ready for ${ally.scope}.`)
      return ally
    },

    async retire(name) {
      const ctx = getCtx()
      const ally = load().find((a) => a.name === name && !a.retiredAt)
      if (!ally) return { ok: false, message: `No active Genio chat in base ${name}` }
      const hc = ctx.homes.get(name)
      if (hc) {
        const live = hc.crew.list().filter((t) => !['cleaned', 'done'].includes(t.state))
        if (live.length) return { ok: false, message: `Base ${name} still has ${live.length} unit(s) in play (${live.map((t) => t.id).join(', ')}); despawn or finish them first` }
        hc.supervisor.stop()
        await hc.workspace.stop().catch(() => undefined)
        await hc.design?.stop().catch(() => undefined)
        ctx.homes.delete(name)
      }
      ally.retiredAt = nowIso()
      persist()
      return { ok: true, message: `Genio chat closed; base ${name} is kept at ${ally.home}` }
    },

    update(name, patch) {
      const i = load().findIndex((a) => a.name === name && !a.retiredAt)
      if (i < 0) throw new Error(`No active Genio chat in base ${name}`)
      const enteredYolo = load()[i].shellMode !== 'all' && patch.shellMode === 'all'
      const next = patchAllyControls(load()[i], patch)
      // in place, so the running base's view of its ally record stays current
      for (const k of ['model', 'effort', 'shellMode'] as const) {
        if (next[k] === undefined) delete load()[i][k]
        else load()[i][k] = next[k] as never
      }
      persist()
      if (enteredYolo) bus.publish({ type: 'feature-used', feature: 'yolo-chat' })
      return { ...load()[i] }
    },

    async route(name, request) {
      const ctx = getCtx()
      const hc = ctx.homes.get(name)
      if (!hc) return { ok: false, message: `Genio chat in base ${name} is not active` }
      const corr = rid(8)
      await hc.workspace.send(`[FROM GENIO MAIN corr=${corr}] ${request}\n\nWhen finished (or blocked), answer with report_to_main and corr=${corr}.`, 'genio')
      ctx.ledger.record({ event: 'task.status', data: { routedTo: name, corr } })
      return { ok: true, message: `Routed to Genio in base ${name} (corr=${corr}); its answer returns as an ally event` }
    },

    reportToParent(from, verb, note, corr) {
      const ctx = getCtx()
      const routine = verb === 'note'
      ctx.main.wakes.enqueue({ kind: 'check', reason: `Genio in base ${from} ${verb}${corr ? ` [corr=${corr}]` : ''}: ${note}`, lines: [note], routine })
      if (verb === 'needs-decision' || verb === 'blocked') ctx.notifier.sfx('decision')
      ctx.main.workspace.deliverWakes()
    }
  }
  return svc
}
