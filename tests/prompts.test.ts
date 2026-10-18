import { describe, expect, it } from 'vitest'
import { botContract, customContract, CUSTOM_CONTRACT_BUDGET, eventsPrompt, procedureText, PROCEDURES, projectOpenPrompt, sessionStartPrompt } from '../src/main/prompts'
import { chatUsageLine } from '../src/shared/usage-mode'

describe('bounded custom contract and lazy procedures', () => {
  it('fits main, ally and Bot including usage and arbitrarily large memory/charters', () => {
    for (const isAlly of [false, true]) for (const bot of [false, true]) {
      const o = { gamertag: 'Alex', base: 'art', isAlly, charter: 'charter'.repeat(20000), scope: 'scope'.repeat(20000),
        playerProfile: 'private-memory'.repeat(20000), sharedProfile: 'shared'.repeat(20000), lore: 'lore'.repeat(20000) }
      const prompt = customContract(o, bot, chatUsageLine('balanced'))
      expect(prompt.length).toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
      expect(prompt).not.toContain('private-memory')
      expect(prompt).not.toContain('chartercharter')
      expect(prompt).toContain('skill_read')
      expect(prompt).toContain('events_ack')
      expect(prompt).toContain('Auto-loot')
      expect(prompt).toContain('full authority over units')
      expect(prompt).toContain('the approval mode never approves spend')
    }
  })

  it('serves only the requested procedure with the complete ally charter on demand', () => {
    const o = { gamertag: 'Alex', base: 'art', isAlly: true, charter: 'full charter '.repeat(2000), scope: 'art assets' }
    for (const name of PROCEDURES) expect(procedureText(name, o).length).toBeGreaterThan(50)
    expect(procedureText('ally', o)).toContain(o.charter)
    expect(procedureText('delivery', o)).not.toContain('## 9.')
    expect(procedureText('memory', o)).toContain('memory_archive')
    expect(() => customContract(o, false, 'x'.repeat(10000))).toThrow('Custom contract exceeds')
  })

  it('pins the Recon follow-through rules in the main and project contracts and the procedures', () => {
    for (const isAlly of [false, true]) {
      const o = { gamertag: 'Alex', base: 'world', isAlly }
      const rule = customContract(o).split('\n').find(l => l.startsWith('- Recon ended:'))
      expect(rule).toBe('- Recon ended: relay the finding; deploy the follow-up at once only if the player\'s earlier words authorized it (never the Recon alone; an "only" Recon stays report-only), else open ONE such choice (task=Recon) and wait. Its answer event: deploy the chosen work now (quests, dependencies, serial order; queue the rest), then report.')
      expect(customContract(o)).toContain('Only the chat\'s approval mode decides whether the player is asked')
      const intake = procedureText('intake', o)
      expect(intake).toContain('**Recon follow-through.**')
      expect(intake).toContain('open ONE choice with choice_open (task = the Recon, options, recommendation) rather than a wall of questions, and wait')
      expect(intake).toContain('a Recon Alex ordered "only" stays report-only until they choose')
      expect(intake).toContain('respect dependencies and serial order, deploy what is unblocked and queue the rest, then report')
      expect(intake).toContain('Merging follows the merge rules (section 7).')
      const events = procedureText('events', o)
      expect(events).toContain('- **answer** (Alex answered a choice in the answer panel, the Hub or another chat): act on it now')
      expect(events).toContain('do not echo the answer back')
      expect(events).toContain('a finished Recon left without a choice or follow-up')
    }
  })

  it('explains reactions: a like confirms the path but is no click on a prompt, a dislike pauses and asks', () => {
    for (const isAlly of [false, true]) {
      const o = { gamertag: 'Alex', base: 'world', isAlly }
      expect(customContract(o)).toContain('Act on the player\'s wishes, not on a diagnosis, report, recommendation or liked message alone.')
      const events = procedureText('events', o)
      expect(events).toContain('- **reaction** (Alex liked or disliked one of your messages, or undid it): reply with a very short acknowledgement.')
      expect(events).toContain('A like confirms that path: proceed confidently and stop re-asking about it; it is not a click on a prompt or a spend approval, so merges, discards and spending are cleared as usual.')
      expect(events).toContain('wait for Alex\'s answer before you relaunch, release, merge or redo that work (going ahead anyway is cleared by the approval mode)')
    }
  })

  it('pins the plan rules: one line in the always-on contract, the full rules in the intake procedure', () => {
    for (const isAlly of [false, true]) {
      const o = { gamertag: 'Alex', base: 'world', isAlly }
      const line = customContract(o).split('\n').find(l => l.startsWith('- Deploy independent work'))
      expect(line).toContain('Work for 2+ units (a Recon\'s builds, several subsystems, a unit past ~60 min): plan_create, never order in prose; not for small or same-file changes (procedure_read("intake")).')
      const intake = procedureText('intake', o)
      const rules = intake.slice(intake.indexOf('- **Plans.**'), intake.indexOf('- For one-off operational work'))
      expect(rules).toMatchSnapshot(isAlly ? 'plan rules (project base)' : 'plan rules (main base)')
      expect(procedureText('units', o)).not.toContain('**Plans.**')
    }
  })

  it('sends questions about Genio itself to genio_help first, in every contract within the cap', () => {
    const line = '- Asked how Genio works, what a mode or setting does or why it behaves so: genio_help first; answer from its excerpts, naming the source doc.'
    for (const isAlly of [false, true]) for (const bot of [false, true]) {
      const prompt = customContract({ gamertag: 'x'.repeat(80), base: 'b'.repeat(128), isAlly }, bot, chatUsageLine('max'))
      expect(prompt.split('\n')).toContain(line)
      expect(prompt.length).toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
    }
  })

  it('helps decide a choice brought from the panel and resolves it only on the player\'s stated decision', () => {
    const rule = 'Helping decide one: explain, recommend, ask them to click or name one. choice_resolve only on the player\'s stated decision (an option or their verbatim words).'
    for (const isAlly of [false, true]) for (const bot of [false, true]) {
      const prompt = customContract({ gamertag: 'x'.repeat(80), base: 'b'.repeat(128), isAlly }, bot, chatUsageLine('max'))
      expect(prompt.split('\n').find(l => l.startsWith('- Open multi-option decisions'))).toContain(rule)
      expect(prompt.length).toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
    }
    expect(procedureText('voice', { gamertag: 'Alex', base: 'world', isAlly: false })).toContain('Resolve it (choice_resolve) only on Alex\'s stated decision, an option or their own words passed verbatim')
  })

  it('ends an event turn with no text when nothing needs the player, never with an "All clear" reply', () => {
    const old = [/Reply exactly/i, /reply exactly "All clear/i, /exact no-op reply/i, /end routine turns with "All clear/i, /Exactly "All clear/i, /still needs an answer/i]
    for (const isAlly of [false, true]) for (const bot of [false, true]) {
      const prompt = customContract({ gamertag: 'x'.repeat(80), base: 'b'.repeat(128), isAlly }, bot, chatUsageLine('max'))
      expect(prompt).toContain('Routine progress, automatic fixes and waiting stay silent. Silent means no text at all, never "All clear"; finished work or a pending choice always gets a message.')
      for (const re of old) expect(prompt).not.toMatch(re)
      expect(prompt.length).toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
    }
    const o = { gamertag: 'Alex', base: 'world', isAlly: false }
    const events = procedureText('events', o)
    expect(events).toContain('When nothing in the batch needs Alex, finish with no text at all: no "All clear", no summary')
    expect(events).toContain('call events_ack with its sequence ID') // handling and acknowledging events is unchanged
    expect(events).toContain('Waiting is silent. Empty polls, elapsed time and no-change updates are not player-facing news.')
    const voice = procedureText('voice', o)
    expect(voice).toContain('An event turn with nothing for Alex (an empty tick, an idle re-read, a pure acknowledgement) ends right after its tool calls with no text at all: not "All clear", not a summary.')
    expect(voice).toContain('Never stay silent about a completed request or anything that needs review, approval, merge or a design pick.')
    expect(voice).toContain('final message of every turn that has something to say must stand alone')
    expect(voice).not.toContain('Reply exactly')
    const batch = eventsPrompt('#1 signal unit finished')
    expect(batch).toContain('call events_ack immediately for its ID')
    expect(batch).toContain('otherwise end the turn right after the tool calls with no text at all (no "All clear", no summary): any text you write is shown.')
    expect(sessionStartPrompt('Alex')).toContain('otherwise end the turn with no text at all (not "All clear")')
    expect(botContract('Alex')).toContain('end routine turns with no text.')
    // the visible greeting is never the quiet turn
    expect(projectOpenPrompt('Alex', 'Project: x.', '')).toContain('never end this turn without the greeting')
    for (const text of [batch, sessionStartPrompt('Alex'), botContract('Alex'), projectOpenPrompt('Alex', 'Project: x.', ''), events, voice]) for (const re of old) expect(text).not.toMatch(re)
  })

  it('tells the chats to attach only what the player pasted or named, and leaves it out of the Bot, which attaches nothing', () => {
    const rule = 'Attach only what the player pasted or named; never guess a path.'
    for (const isAlly of [false, true]) {
      expect(customContract({ gamertag: 'Alex', base: 'b', isAlly })).toContain(rule)
      expect(customContract({ gamertag: 'Alex', base: 'b', isAlly }, true)).not.toContain(rule)
    }
    expect(procedureText('units', { gamertag: 'Alex', base: 'b', isAlly: false })).toContain('**attachments** (deploy, quest_add, plan steps, upgrade_recon)')
  })

  it('leaves budget for provider instructions even with long identity fields', () => {
    expect(customContract({ gamertag: 'x'.repeat(1000), base: 'b'.repeat(1000), isAlly: true }, true, 'u'.repeat(300)).length)
      .toBeLessThanOrEqual(CUSTOM_CONTRACT_BUDGET)
  })
})

it('keeps the assistant Genio in contracts and project-open greetings, naming the project separately', () => {
  const project = 'founders-of-avalon'
  const prompt = customContract({ gamertag: 'Alex', base: project, isAlly: true })
  expect(prompt).toContain('You are Genio,')
  expect(prompt).toContain('(workspace, never your name)')
  expect(prompt).toContain(`Base: ${project} (workspace, never your name).`)
  const opening = projectOpenPrompt('Alex', `Project: ${project}.`, '')
  expect(opening).toContain(`Project: ${project}.`)
  expect(opening).toContain('You are Genio; name the project from the recap separately, never as your own name.')
})
