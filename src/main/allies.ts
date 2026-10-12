/**
 * Allies (companion subsidiarys): persistent allied Genios, each running from
 * an isolated base under <main>/wksps/<name> with its own state, quest log,
 * worktrees and Genio session. Idle by default; main Genio routes in-scope
 * work to them and they report back through the parent channel (main-base
 * 'check' events), never by the player reading their chat.
 */
import path from 'node:path'
import type { Ally } from '@shared/types'
import { bus } from './bus'
import { makeHomeCtx } from './ctx'
import { Home } from './home'
import { allyCharterFile } from './prompts'
import type { AlliesService, AppCtx } from './services'
import { nowIso, rid, readJson, writeJson, writeText } from './util'

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/

export function createAlliesService(getCtx: () => AppCtx): AlliesService {
  // ctx.main exists before list() is first called (see createApp)
  const reg = (): string => getCtx().main.home.alliesFile

  let cache: Ally[] | undefined
  const load = (): Ally[] => {
    if (!cache) {
      cache = readJson<Ally[]>(reg(), [])
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
      if (load().some((a) => a.name === name && !a.retiredAt)) throw new Error(`an ally named ${name} already exists`)
      if (!req.scope.trim()) throw new Error('an ally needs a routing scope')
      const mainHome = ctx.main.home
      const root = mainHome.wkspHome(name)
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
      bus.publish({ type: 'wksp', wksp: hc.wksp.info() })
      bus.toast('success', 'Ally recruited', `${name} joins the squad — scope: ${ally.scope}`)
      return ally
    },

    async retire(name) {
      const ctx = getCtx()
      const ally = load().find((a) => a.name === name && !a.retiredAt)
      if (!ally) return { ok: false, message: `no active ally named ${name}` }
      const hc = ctx.homes.get(name)
      if (hc) {
        const live = hc.crew.list().filter((t) => !['cleaned', 'done'].includes(t.state))
        if (live.length) return { ok: false, message: `${name} still has ${live.length} unit(s) in play (${live.map((t) => t.id).join(', ')}); despawn or finish them first` }
        hc.supervisor.stop()
        await hc.wksp.stop().catch(() => undefined)
        ctx.homes.delete(name)
      }
      ally.retiredAt = nowIso()
      persist()
      return { ok: true, message: `${name} retired; its base is kept at ${ally.home}` }
    },

    async route(name, request) {
      const ctx = getCtx()
      const hc = ctx.homes.get(name)
      if (!hc) return { ok: false, message: `ally ${name} is not active` }
      const corr = rid(8)
      await hc.wksp.send(`[FROM GENIO MAIN corr=${corr}] ${request}\n\nWhen finished (or blocked), answer with report_to_main and corr=${corr}.`, 'system')
      ctx.ledger.record({ event: 'task.status', data: { routedTo: name, corr } })
      return { ok: true, message: `routed to ${name} (corr=${corr}); its answer returns as an ally event` }
    },

    reportToParent(from, verb, note, corr) {
      const ctx = getCtx()
      const routine = verb === 'note'
      ctx.main.wakes.enqueue({ kind: 'check', reason: `ally ${from} ${verb}${corr ? ` [corr=${corr}]` : ''}: ${note}`, lines: [note], routine })
      if (verb === 'needs-decision' || verb === 'blocked') ctx.notifier.sfx('decision')
      ctx.main.wksp.deliverWakes()
    }
  }
  return svc
}
