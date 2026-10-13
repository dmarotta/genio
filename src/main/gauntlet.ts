/**
 * The Gauntlet: Genio's Hardcore validation pipeline (companion delegates this
 * to the external no-mistakes tool). Deterministic steps, one AI review:
 *
 *   sync → setup/lint/build/test (world commands) → review → push → PR
 *
 * Findings go back to the unit as a ping (round n of validationMaxRounds);
 * ask-player findings and infrastructure failures become Your Move choices.
 * CI is watched afterwards by overwatch through the registered PR.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isDefaultUnityTest, unityTestCommand } from './play-editor'
import type { Task, ValidationRun, ValidationStep } from '@shared/types'
import type { OpResult } from '@shared/api'
import type { AppCtx } from './services'
import type { Home } from './home'
import * as git from './git'
import { appendLine, exists, nowIso, readText, rid, runShell, truncate } from './util'

export interface Gauntlet {
  run(taskId: string): Promise<OpResult>
  running(taskId: string): boolean
}

interface ReviewVerdict {
  verdict: 'pass' | 'fix' | 'ask-player'
  findings: { severity?: string; file?: string; line?: number; issue: string; fix?: string }[]
  question?: string
  options?: string[]
  summary?: string
}

const STEP_TIMEOUT_MS = 20 * 60_000

function section(md: string, heading: string): string {
  const i = md.indexOf(heading)
  if (i < 0) return ''
  const rest = md.slice(i + heading.length)
  const next = rest.search(/\n#{1,2} /)
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

function extractJson(text: string): ReviewVerdict | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)].filter(Boolean) as string[]
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as ReviewVerdict
      if (j && typeof j.verdict === 'string') {
        if (!Array.isArray(j.findings)) j.findings = []
        return j
      }
    } catch {
      /* try next */
    }
  }
  return undefined
}

export function createGauntlet(getCtx: () => AppCtx, home: Home): Gauntlet {
  const active = new Set<string>()

  const hc = () => getCtx().home(home.name)

  async function aiReview(t: Task, intent: string, spec: string, diff: string, log: (s: string) => void): Promise<{ verdict?: ReviewVerdict; error?: string }> {
    const s = getCtx().settings.get()
    const prompt = [
      'You are the reviewer in a game studio validation pipeline. Review the change below strictly against the player\'s intent.',
      'Check: does it do what was asked (no more, no less)? correctness bugs, crashes, broken game logic, performance traps in hot loops, missing or wrong tests, leftover debug code, accidental edits to unrelated assets/scenes, secrets.',
      'You may read files in the working directory to understand context. Do not suggest stylistic nitpicks.',
      'Use verdict "fix" only for concrete problems the coder can fix. Use "ask-player" only when the right behaviour is a product/design choice the player must make.',
      'Reply with ONLY a JSON object: {"verdict":"pass"|"fix"|"ask-player","summary":"one line","findings":[{"severity":"high|medium|low","file":"path","line":1,"issue":"...","fix":"..."}],"question":"(ask-player only)","options":["..."]}',
      '',
      "## Player's intent",
      intent || t.title,
      '',
      '## Build spec',
      spec || '(none)',
      '',
      '## Diff',
      '```diff',
      truncate(diff, 180_000),
      '```'
    ].join('\n')
    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk')
      const q = sdk.query({
        prompt,
        options: {
          cwd: t.worktree,
          model: s.reviewModel || undefined,
          tools: ['Read', 'Grep', 'Glob'],
          allowedTools: ['Read', 'Grep', 'Glob'],
          permissionMode: 'dontAsk',
          maxTurns: 40,
          settingSources: [],
          persistSession: false,
          pathToClaudeCodeExecutable: s.claudePath || undefined,
          stderr: (d: string) => log(`[review stderr] ${d.trim()}`)
        }
      })
      let text = ''
      for await (const m of q) {
        if (m.type === 'result') {
          try {
            getCtx().stats.addCost(m.total_cost_usd ?? 0)
          } catch {
            /* stats optional */
          }
          if (m.subtype === 'success') text = m.result
          else return { error: `review ended with ${m.subtype}: ${(m.errors ?? []).join('; ')}` }
        }
      }
      const verdict = extractJson(text)
      if (!verdict) return { error: `reviewer reply was not a JSON verdict: ${truncate(text, 400)}` }
      return { verdict }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }

  async function run(taskId: string): Promise<OpResult> {
    if (active.has(taskId)) return { ok: false, message: 'The Gauntlet is already running for this unit.' }
    const ctx = getCtx()
    const crew = hc().crew
    const t = crew.get(taskId)
    if (!t) return { ok: false, message: `Unknown unit: ${taskId}` }
    if (t.kind !== 'ship') return { ok: false, message: 'Recon missions do not run the Gauntlet.' }
    if (!exists(t.worktree)) return { ok: false, message: 'The unit worktree is gone.' }
    const project = ctx.projects.get(t.project)
    if (!project) return { ok: false, message: `World ${t.project} is not registered.` }
    const settings = ctx.settings.get()
    const prev = t.validation
    const round = prev && prev.state === 'findings' ? prev.round + 1 : 1
    if (round > settings.validationMaxRounds) {
      ctx.home(home.name).decisions.openForTask(
        taskId,
        'gauntlet-rounds',
        `The Gauntlet still finds problems after ${settings.validationMaxRounds} fix rounds on "${t.title}". Keep going, take over, or drop it?`,
        'validation',
        { project: t.project, options: ['Allow more rounds', 'Ship as-is via Standard PR', 'Drop the mission'], context: prev?.findings }
      )
      crew.update(taskId, { state: 'needs-decision', stateReason: 'Gauntlet round limit reached' })
      return { ok: false, message: 'Round limit reached; raised a choice for the player.' }
    }

    const cmds = { ...project.commands }
    if (project.engine === 'unity' && isDefaultUnityTest(cmds.test)) {
      const engineRoot = project.engineRoot || '.'
      const command = unityTestCommand(path.resolve(t.worktree, engineRoot), engineRoot)
      if (!command) return { ok: false, message: 'The Unity version required by this worktree is not installed in Unity Hub.' }
      cmds.test = command
    }
    active.add(taskId)
    const logFile = home.validationLog(taskId)
    const log = (s: string): void => appendLine(logFile, `[${nowIso()}] ${s}`)
    const stepNames: { name: string; command?: string }[] = [{ name: 'sync' }]
    const hasChecks = Boolean(cmds.lint || cmds.build || cmds.test)
    if (cmds.setup && hasChecks) stepNames.push({ name: 'setup', command: cmds.setup })
    if (cmds.lint) stepNames.push({ name: 'lint', command: cmds.lint })
    if (cmds.build) stepNames.push({ name: 'build', command: cmds.build })
    if (cmds.test) stepNames.push({ name: 'test', command: cmds.test })
    stepNames.push({ name: 'review' }, { name: 'push' }, { name: 'pr' })
    const vr: ValidationRun = {
      id: rid(4),
      state: 'running',
      round,
      startedAt: nowIso(),
      steps: stepNames.map((s) => ({ ...s, state: 'pending' as const }))
    }
    const save = (patch?: Partial<Task>): void => {
      crew.update(taskId, { validation: { ...vr, steps: vr.steps.map((x) => ({ ...x })) }, ...(patch ?? {}) })
    }
    const step = (name: string): ValidationStep => vr.steps.find((x) => x.name === name)!
    const begin = (st: ValidationStep): void => {
      st.state = 'running'
      st.startedAt = nowIso()
      log(`▶ ${st.name}${st.command ? `: ${st.command}` : ''}`)
      save()
    }
    const end = (st: ValidationStep, state: ValidationStep['state'], output?: string): void => {
      st.state = state
      st.endedAt = nowIso()
      if (output !== undefined) st.output = truncate(output, 20_000)
      log(`■ ${st.name}: ${state}`)
      save()
    }
    const skipRest = (): void => {
      for (const s of vr.steps) if (s.state === 'pending') s.state = 'skipped'
    }

    log(`=== Gauntlet round ${round} for ${taskId} (${t.branch}) ===`)
    save({ state: 'validating', stateReason: `Gauntlet round ${round}` })
    try {
      const findings: string[] = []
      const ref = await git.baseRef(project.path, t.baseBranch)

      // 1. sync: committed, ahead of base, not behind base
      const sync = step('sync')
      begin(sync)
      const dirty = await git.statusPorcelain(t.worktree)
      if (await git.hasRemote(project.path)) await git.fetch(project.path)
      const ab = await git.aheadBehind(t.worktree, 'HEAD', ref)
      const upToDate = await git.isAncestor(t.worktree, ref, 'HEAD')
      const syncIssues: string[] = []
      if (dirty.length) syncIssues.push(`There are ${dirty.length} uncommitted change(s): commit them or remove them.\n${dirty.slice(0, 20).join('\n')}`)
      if (ab.ahead === 0) syncIssues.push(`The branch has no commits ahead of ${ref}. Commit your work on ${t.branch}.`)
      if (!upToDate) syncIssues.push(`The branch is behind ${ref}. Rebase onto ${ref} and resolve conflicts.`)
      if (syncIssues.length) {
        end(sync, 'failed', syncIssues.join('\n\n'))
        findings.push(`### Branch state\n${syncIssues.join('\n\n')}`)
      } else end(sync, 'passed', `${ab.ahead} commit(s) ahead of ${ref}`)

      // 2. world commands
      if (!syncIssues.length) {
        for (const st of vr.steps.filter((x) => x.command)) {
          begin(st)
          const r = await runShell(st.command!, { cwd: t.worktree, timeoutMs: STEP_TIMEOUT_MS, onData: (d) => fs.appendFileSync(logFile, d) })
          const outTail = (r.stdout + '\n' + r.stderr).trim().split(/\r?\n/).slice(-80).join('\n')
          if (r.code === 0) end(st, 'passed', outTail)
          else {
            end(st, 'failed', outTail)
            findings.push(`### ${st.name} failed (exit ${r.code})\nCommand: \`${st.command}\`\n\`\`\`\n${outTail}\n\`\`\``)
            if (st.name === 'setup') break
          }
        }
      }

      if (findings.length) {
        skipRest()
        return await sendFindings(taskId, vr, round, findings.join('\n\n'), log)
      }

      // 3. AI review
      const review = step('review')
      begin(review)
      const brief = readText(t.briefPath)
      const intent = section(brief, "## Player's intent")
      const spec = section(brief, '## Genio spec')
      const diff = await git.diff(t.worktree, ref)
      const rv = await aiReview(t, intent, spec, diff, log)
      let reviewNote = ''
      if (rv.error || !rv.verdict) {
        reviewNote = `AI review unavailable: ${rv.error ?? 'no verdict'}`
        end(review, 'skipped', reviewNote)
      } else if (rv.verdict.verdict === 'fix') {
        const text = rv.verdict.findings
          .map((f, i) => `${i + 1}. [${f.severity ?? 'medium'}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}${f.issue}${f.fix ? `\n   Fix: ${f.fix}` : ''}`)
          .join('\n')
        end(review, 'failed', text)
        skipRest()
        return await sendFindings(taskId, vr, round, `### Review findings\n${rv.verdict.summary ? rv.verdict.summary + '\n\n' : ''}${text}`, log)
      } else if (rv.verdict.verdict === 'ask-player') {
        end(review, 'failed', rv.verdict.question ?? 'needs a player choice')
        skipRest()
        vr.state = 'findings'
        vr.findings = rv.verdict.question
        vr.endedAt = nowIso()
        ctx.home(home.name).decisions.openForTask(taskId, 'gauntlet-review', rv.verdict.question ?? `The reviewer needs a design call on "${t.title}".`, 'validation', {
          project: t.project,
          options: rv.verdict.options ?? [],
          context: rv.verdict.findings.map((f) => f.issue).join('\n')
        })
        save({ state: 'needs-decision', stateReason: 'Gauntlet review needs a player choice' })
        return { ok: false, message: 'The review needs a player choice; raised it in Your Move.' }
      } else {
        reviewNote = rv.verdict.summary ?? 'Review passed.'
        end(review, 'passed', reviewNote)
      }

      // 4. push
      const push = step('push')
      begin(push)
      if (!(await git.hasRemote(project.path))) {
        end(push, 'failed', 'world has no remote')
        skipRest()
        return infra(taskId, vr, `"${t.title}" passed the Gauntlet but ${t.project} has no remote to push to. Switch the world to Offline or add a remote.`, ['Switch to Offline and land locally', 'I will add a remote'])
      }
      const pr = await git.push(t.worktree, t.branch)
      if (pr.code !== 0) {
        end(push, 'failed', pr.stderr)
        skipRest()
        return infra(taskId, vr, `Pushing ${t.branch} failed: ${truncate(pr.stderr.trim(), 400)}. Check git credentials for ${t.project}.`, ['Retry the Gauntlet', 'Drop the mission'])
      }
      end(push, 'passed', truncate(pr.stderr || pr.stdout, 2000))

      // 5. PR
      const prStep = step('pr')
      begin(prStep)
      if (!ctx.forge.available()) {
        end(prStep, 'failed', 'gh/glab not installed')
        skipRest()
        return infra(taskId, vr, `"${t.title}" is pushed but no forge CLI is installed to open the PR. Install gh from SYSTEMS, then retry.`, ['Retry the Gauntlet after installing gh'])
      }
      const checksTable = vr.steps
        .filter((x) => x.name !== 'pr')
        .map((x) => `| ${x.name} | ${x.state === 'passed' ? 'pass' : x.state} |`)
        .join('\n')
      const body = [
        '## Intent',
        '',
        intent || t.title,
        '',
        '## Validation',
        '',
        '| step | result |',
        '| --- | --- |',
        checksTable,
        '',
        reviewNote ? `Review: ${reviewNote}` : '',
        '',
        `Diffstat:\n\n\`\`\`\n${await git.diffStat(t.worktree, ref)}\n\`\`\``
      ].join('\n')
      const created = await ctx.forge.createPr(t.worktree, { title: t.title, body, base: t.baseBranch, head: t.branch })
      if (!created.ok || !created.url) {
        end(prStep, 'failed', created.message)
        skipRest()
        return infra(taskId, vr, `Opening the PR for "${t.title}" failed: ${truncate(created.message, 400)}`, ['Retry the Gauntlet', 'Open the PR manually'])
      }
      end(prStep, 'passed', created.url)
      vr.state = 'passed'
      vr.endedAt = nowIso()
      save()
      log(`✔ passed: ${created.url}`)
      const reg = await crew.registerPr(taskId, created.url)
      return { ok: reg.ok, message: reg.ok ? `Gauntlet cleared: ${created.url}` : reg.message }
    } catch (e) {
      log(`✖ crashed: ${(e as Error).stack ?? e}`)
      vr.state = 'failed'
      vr.endedAt = nowIso()
      skipRest()
      save({ state: 'blocked', stateReason: `Gauntlet error: ${(e as Error).message}` })
      return { ok: false, message: `Gauntlet error: ${(e as Error).message}` }
    } finally {
      active.delete(taskId)
    }
  }

  async function sendFindings(taskId: string, vr: ValidationRun, round: number, findings: string, log: (s: string) => void): Promise<OpResult> {
    const crew = hc().crew
    const max = getCtx().settings.get().validationMaxRounds
    vr.state = 'findings'
    vr.findings = findings
    vr.endedAt = nowIso()
    crew.update(taskId, { validation: { ...vr }, state: 'working', stateReason: `fixing Gauntlet findings (round ${round}/${max})` })
    log(`✖ findings sent to the unit (round ${round}/${max})`)
    const msg = [
      `Gauntlet round ${round}/${max} found problems. Fix them, commit on your branch, then append \`done: <summary of fixes>\` to your status file again.`,
      '',
      findings
    ].join('\n')
    const r = await crew.send(taskId, msg)
    if (r.ok) crew.bump(taskId, 'fixRounds')
    return { ok: false, message: r.ok ? `Gauntlet round ${round} found problems; pinged the unit with fixes.` : `Gauntlet found problems but the ping failed: ${r.message}` }
  }

  function infra(taskId: string, vr: ValidationRun, question: string, options: string[]): OpResult {
    const t = hc().crew.get(taskId)
    vr.state = 'failed'
    vr.endedAt = nowIso()
    hc().decisions.openForTask(taskId, 'gauntlet', question, 'validation', { project: t?.project, options })
    hc().crew.update(taskId, { validation: { ...vr }, state: 'needs-decision', stateReason: 'Gauntlet needs the player' })
    return { ok: false, message: question }
  }

  return { run, running: (id) => active.has(id) }
}
