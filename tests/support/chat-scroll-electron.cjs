const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
console.log('Starting Chromium scroll fixture')

app.whenReady().then(async () => {
  console.log('Chromium ready', process.env.CHAT_SCROLL_URL)
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const js = code => win.webContents.executeJavaScript(code)
  win.webContents.on('console-message', (_event, _level, message) => console.log('Renderer:', message))
  const until = async (code, label) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { if (await js(code)) return; await wait(50) }
    throw new Error(`Timed out: ${label}`)
  }
  await win.loadURL(process.env.CHAT_SCROLL_URL)
  await until('!!window.fixture && !!document.querySelector(".chat-log")', 'fixture ready')
  const results = []
  for (const surface of ['screen', 'panel']) {
    await js(`window.fixture.setState({ view: '${surface === 'screen' ? 'comms' : 'squad'}' })`)
    await until(`!!document.querySelector('${surface === 'screen' ? '.comms-main' : '.genio-panel-slot'} .chat-log')`, 'host mounted')
    await wait(500)
    for (const streaming of [false, true]) {
      console.log('Checking', surface, { streaming })
      const id = `stream-${surface}-${streaming}`
      await js(`(() => {
        const el = document.querySelector('.chat-log')
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }))
        // Stay above the bottom even if content-visibility replaces tall layout with estimates.
        el.scrollTop = 0
        el.dispatchEvent(new Event('scroll'))
        ${streaming ? `window.fixture.handleEvent({ type: 'chat-delta', wksp: 'genio', id: '${id}', text: 'Streaming before jump ' })` : ''}
      })()`)
      await until('!!document.querySelector(".chat-jump")', 'scrolled-up jump control')
      assert(await js(`(() => { const el = document.querySelector('.chat-log'); return el.scrollHeight - el.clientHeight - el.scrollTop > 80 })()`), 'Streaming must not yank a scrolled-up reader down')
      const point = await js(`(() => { const r = document.querySelector('.chat-jump').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      await wait(50)
      // A DOM .click() misses this bug: .btn:active used to replace the jump's positioning
      // transform, moving it off the pointer so the browser never dispatched its click handler.
      assert(await js(`!!document.elementFromPoint(${point.x}, ${point.y})?.closest('.chat-jump')`), 'Pressed jump must stay under the pointer')
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
      await js(`(() => {
        ${streaming ? `let tokens = 0; const timer = setInterval(() => {
          window.fixture.handleEvent({ type: 'chat-delta', wksp: 'genio', id: '${id}', text: 'More streamed text.\\n\\n' })
          if (++tokens === 20) clearInterval(timer)
        }, 25)` : ''}
        // Deliberately grow content after the click, while the smooth scroll is in flight.
        setTimeout(() => { document.querySelector('.chat-log-body').style.paddingBottom = '350px' }, 100)
      })()`)
      await until(`(() => { const el = document.querySelector('.chat-log'); return el.scrollHeight - el.clientHeight - el.scrollTop <= 1 && !document.querySelector('.chat-jump') })()`, 'jump reaches the laid-out bottom')
      await wait(300)
      const gap = await js(`(() => { const el = document.querySelector('.chat-log'); return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) })()`)
      assert.equal(gap, 0, `${surface} must stay at the bottom after late layout`)
      results.push({ surface, streaming, gap })
      await js(`document.querySelector('.chat-log-body').style.paddingBottom = ''`)
    }
  }
  fs.writeFileSync(process.env.CHAT_SCROLL_RESULTS, JSON.stringify(results))
  app.exit(0)
}).catch(e => { console.error(e); app.exit(1) })
