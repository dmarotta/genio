// Real Chromium layout of the jump-to-latest control in both chat hosts, at a wide and a narrow
// window, with Clean HUD on and off, while a reply streams and under queued-message chips.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const SIZES = [{ name: 'wide', width: 1280, height: 900 }, { name: 'narrow', width: 480, height: 360 }]
const VARIANTS = [
  { name: 'plain', calm: false, streaming: false, queued: false },
  { name: 'calm-queued', calm: true, streaming: false, queued: true },
  { name: 'streaming', calm: false, streaming: true, queued: false }
]

app.whenReady().then(async () => {
  const shots = process.env.CHAT_JUMP_SHOTS || path.join(path.dirname(process.env.CHAT_SCROLL_RESULTS), 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const win = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } })
  const js = code => win.webContents.executeJavaScript(code)
  win.webContents.on('console-message', (_event, _level, message) => console.log('Renderer:', message))
  const until = async (code, label) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { if (await js(code)) return; await wait(50) }
    throw new Error(`Timed out: ${label}`)
  }
  /** A settled frame: a hidden window only paints (and advances the fade-in) when asked for a frame. */
  const shot = async () => { await win.webContents.capturePage(); await wait(300); return win.webContents.capturePage() }
  const crop = (image, r, dip) => {
    const k = image.getSize().width / dip
    return image.crop({ x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.width * k), height: Math.round(r.height * k) }).toBitmap()
  }
  /** A band inside the button, clear of .btn's clipped corners (which show what is under them). */
  const band = r => ({ x: r.x + 10, y: r.y + 3, width: r.width - 20, height: r.height - 6 })
  await win.loadURL(process.env.CHAT_SCROLL_URL)
  await until('!!window.fixture && !!document.querySelector(".chat-log")', 'fixture ready')
  const base = await js('JSON.stringify(window.fixture.getState().chats.genio)')
  const results = []
  for (const size of SIZES) {
    win.setContentSize(size.width, size.height)
    for (const surface of ['screen', 'panel']) {
      for (const v of VARIANTS) {
        const label = `${size.name}-${surface}-${v.name}`
        console.log('Checking', label)
        await js(`(() => {
          const s = window.fixture.getState()
          const chat = JSON.parse(${JSON.stringify(base)})
          ${v.queued ? `for (let i = 0; i < 3; i++) chat.push({ id: 'q-' + i, wksp: 'genio', role: 'player', text: 'Queued follow-up ' + i, ts: '2026-10-14T06:00:00Z', queue: 'queued' })` : ''}
          window.fixture.setState({ view: '${surface === 'screen' ? 'comms' : 'squad'}', chats: { genio: chat },
            settings: { ...s.settings, calm: ${v.calm} },
            snap: { ...s.snap, wksps: s.snap.wksps.map(m => ({ ...m, activity: '${v.streaming ? 'thinking' : 'idle'}' })) } })
        })()`)
        await until(`!!document.querySelector('${surface === 'screen' ? '.comms-main' : '.genio-panel-slot'} .chat-log')`, 'host mounted')
        const delta = text => `window.fixture.handleEvent({ type: 'chat-delta', wksp: 'genio', id: 'stream-${label}', text: ${JSON.stringify(text)} })`
        if (v.streaming) await js(delta('Streaming under the jump control. '.repeat(30)))
        await shot()
        const before = await js(`document.querySelector('.chat-log').clientHeight`)
        await js(`(() => {
          const el = document.querySelector('.chat-log')
          el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
          el.scrollTop = el.scrollHeight - el.clientHeight - 1200
          el.dispatchEvent(new Event('scroll'))
          ${v.streaming ? delta('More streamed text. ') : ''}
        })()`)
        await until('!!document.querySelector(".chat-jump")', 'scrolled-up jump control')
        await shot() // let the fade-in finish before measuring
        const g = await js(`(() => {
          const log = document.querySelector('.chat-log'), jump = document.querySelector('.chat-jump'), dock = jump.parentElement
          const viewport = log.parentElement, composer = viewport.parentElement.querySelector('.composer')
          const lr = log.getBoundingClientRect(), jr = jump.getBoundingClientRect(), vr = viewport.getBoundingClientRect()
          const hits = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5]].every(([fx, fy]) => document.elementFromPoint(jr.left + jr.width * fx, jr.top + jr.height * fy)?.closest('.chat-jump') === jump)
          return {
            inLog: log.contains(jump), sibling: dock.parentElement === viewport && viewport.classList.contains('chat-viewport'),
            dockPosition: getComputedStyle(dock).position, viewportPosition: getComputedStyle(viewport).position,
            dockPointer: getComputedStyle(dock).pointerEvents, jumpPointer: getComputedStyle(jump).pointerEvents,
            zIndex: Number(getComputedStyle(dock).zIndex), background: getComputedStyle(jump).backgroundColor,
            logHeight: Math.round(lr.height), viewportHeight: Math.round(vr.height), clientHeight: log.clientHeight,
            above: Math.round(lr.bottom - jr.bottom), composerGap: Math.round(composer.getBoundingClientRect().top - jr.bottom),
            centre: Math.round((jr.left + jr.right) / 2 - (lr.left + lr.right) / 2), inside: jr.left >= lr.left && jr.right <= lr.right && jr.top >= lr.top,
            hits, rect: { x: Math.round(jr.left), y: Math.round(jr.top), width: Math.round(jr.width), height: Math.round(jr.height) },
            content: { x: Math.round(lr.left + 12), y: Math.max(Math.round(lr.top), Math.round(jr.top) - 60), width: Math.round(lr.width - 24), height: 40 }
          }
        })()`)
        assert.equal(g.inLog, false, `${label}: jump must not be inside the scroller`)
        assert.equal(g.sibling, true, `${label}: jump dock must be the scroller's sibling in .chat-viewport`)
        assert.equal(g.dockPosition, 'absolute', `${label}: dock must be absolutely positioned`)
        assert.equal(g.viewportPosition, 'relative', `${label}: viewport must anchor the dock`)
        assert.equal(g.dockPointer, 'none', `${label}: only the button takes the pointer`)
        assert.equal(g.jumpPointer, 'auto', `${label}: the button takes the pointer`)
        assert(g.zIndex > 0 && g.zIndex < 30, `${label}: z-index above messages, below menus (${g.zIndex})`)
        assert.match(g.background, /^rgb\(/, `${label}: opaque background, got ${g.background}`)
        assert.equal(g.logHeight, g.viewportHeight, `${label}: the dock takes no layout space`)
        assert.equal(g.clientHeight, before, `${label}: showing the jump must not shift layout`)
        assert(g.above >= 4 && g.above <= 40, `${label}: anchored just above the composer (${g.above}px)`)
        assert(g.composerGap >= 4, `${label}: must not overlap the composer (${g.composerGap}px)`)
        assert(Math.abs(g.centre) <= 2 && g.inside, `${label}: bottom-centre inside the viewport`)
        assert(g.hits, `${label}: nothing may paint over the button`)
        // A true overlay looks the same whatever scrolls beneath it: no text bleeds through it.
        const a = await shot()
        fs.writeFileSync(path.join(shots, `${label}.png`), a.toPNG())
        await js(`document.querySelector('.chat-log').scrollTop -= 37`)
        assert(await js('!!document.querySelector(".chat-jump")'), `${label}: still scrolled up`)
        const b = await shot()
        const [jumpA, contentA, jumpB, contentB] = [crop(a, band(g.rect), size.width), crop(a, g.content, size.width), crop(b, band(g.rect), size.width), crop(b, g.content, size.width)]
        assert(!contentA.equals(contentB), `${label}: the content under the button must have moved`)
        assert(jumpA.equals(jumpB), `${label}: the button must not change with the content scrolling under it`)
        results.push({ label, ok: true })
        await js(`document.querySelector('.chat-jump').click()`)
        // Wait out the smooth scroll, so it cannot land the next case back at the bottom.
        await until(`(() => { const el = document.querySelector('.chat-log'); return el.scrollHeight - el.clientHeight - el.scrollTop <= 1 && !document.querySelector('.chat-jump') })()`, 'jump reaches the bottom')
        await wait(200)
      }
    }
  }
  fs.writeFileSync(process.env.CHAT_SCROLL_RESULTS, JSON.stringify(results))
  app.exit(0)
}).catch(e => { console.error(e); app.exit(1) })
