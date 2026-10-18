const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, _level, message) => console.log('Renderer:', message))
  const js = code => win.webContents.executeJavaScript(code)
  const until = async code => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { if (await js(code)) return; await wait(50) }
    throw new Error('Timed out: ' + code + '\n' + await js('document.body.innerText'))
  }
  await win.loadURL(process.env.CHAT_SCROLL_URL)
  await until('!!document.querySelector("[data-quota-protection]")')
  const results = []
  for (const [width, height] of [[1440, 900], [480, 360]]) {
    win.setContentSize(width, height)
    for (const surface of ['screen', 'panel']) {
      const label = `${width}x${height}-${surface}`
      await js(`window.fixture.setState({ view: '${surface === 'screen' ? 'comms' : 'squad'}', tip: undefined, toasts: [],
        snap: { ...window.fixture.getState().snap, decisions: [] } })`)
      await until(`!!document.querySelector('${surface === 'screen' ? '.comms' : '.genio-panel'} [data-quota-protection]')`)
      // Check each overlay and the busy combination; the tip yields when space runs out.
      for (const overlay of ['tip', 'toast', 'choice', 'all']) {
        await js(`window.fixture.setState({
          tip: ${['tip', 'all'].includes(overlay) ? `{ id: 'plans', line: 'Ask Genio for a plan.', question: 'How do I use a plan?', shownAt: Date.now() }` : 'undefined'},
          toasts: ${['toast', 'all'].includes(overlay) ? `[{ id: 't', level: 'info', title: 'Connection restored' }]` : '[]'},
          snap: { ...window.fixture.getState().snap, decisions: ${['choice', 'all'].includes(overlay) ? `[{ id: 'choice', key: 'choice', workspace: 'genio', project: 'fixture', question: 'Which scene?', options: ['Castle', 'Forest'], source: 'unit', urgency: 'normal', createdAt: new Date().toISOString() }]` : '[]'} }
        })`)
        await win.webContents.capturePage(); await wait(400)
        const g = await js(`(() => {
          const warning = document.querySelector('[data-quota-protection]'), r = warning.getBoundingClientRect()
          const host = warning.parentElement.getBoundingClientRect(), text = warning.querySelector('span')
          const css = getComputedStyle(warning)
          const overlap = b => b.width && b.height && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top
          const blockers = [...document.querySelectorAll('.titlebar, .genio-panel-bar, .answer-card, .toast, .tip-card')]
            .filter(n => getComputedStyle(n).visibility !== 'hidden' && overlap(n.getBoundingClientRect())).map(n => n.className)
          const buttons = [...warning.querySelectorAll('button')].every(b => { const v = b.getBoundingClientRect(); return document.elementFromPoint(v.x + v.width / 2, v.y + v.height / 2)?.closest('button') === b })
          const answers = document.querySelector('.answers-float')?.getBoundingClientRect()
          return { blockers, buttons, choices: document.querySelectorAll('.answer-card').length, toasts: document.querySelectorAll('.toast').length,
            answersInside: !answers || answers.bottom <= innerHeight,
            centre: (r.left + r.right - host.left - host.right) / 2,
            inside: r.top >= 44 && r.left >= 0 && r.right <= innerWidth && r.bottom < innerHeight,
            textVisible: text.scrollWidth <= text.clientWidth + 1, border: css.borderTopColor, background: css.backgroundColor,
            font: parseFloat(css.fontSize), height: r.height, width: r.width }
        })()`)
        assert.deepEqual(g.blockers, [], `${label}/${overlay}: overlaps ${g.blockers}`)
        assert(g.buttons && g.inside && g.textVisible, `${label}/${overlay}: visible text and usable actions ${JSON.stringify(g)}`)
        if (['choice', 'all'].includes(overlay)) assert.equal(g.choices, 1, 'real choice card must be mounted')
        if (['toast', 'all'].includes(overlay)) assert.equal(g.toasts, 1, 'real toast must be mounted')
        assert(g.answersInside, `${label}: choices remain within the available window height`)
        assert(Math.abs(g.centre) < 2, `${label}: centred within chat`)
        assert.equal(g.border, 'rgb(255, 182, 39)')
        assert.equal(g.background, 'rgba(255, 182, 39, 0.14)')
        assert(g.font >= 14, `${label}: readable text`)
        if (process.env.QUOTA_WARNING_SHOTS) {
          fs.mkdirSync(process.env.QUOTA_WARNING_SHOTS, { recursive: true })
          fs.writeFileSync(path.join(process.env.QUOTA_WARNING_SHOTS, `${label}-${overlay}.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
      results.push({ label, ok: true })
    }
  }
  fs.writeFileSync(process.env.CHAT_SCROLL_RESULTS, JSON.stringify(results))
  app.exit(0)
}).catch(e => { console.error(e); app.exit(1) })
