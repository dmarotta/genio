const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const shots = process.env.TIP_CARD_SHOTS || path.join(path.dirname(process.env.TIP_CARD_RESULTS), 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } })
  const js = code => win.webContents.executeJavaScript(code)
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.error('Renderer:', message) })
  const until = async code => {
    for (let i = 0; i < 160; i++) { if (await js(code)) return; await wait(50) }
    throw new Error('Renderer did not settle: ' + code)
  }
  const settle = async () => {
    // Hidden Chromium windows paint on capture: finish entry/exit and pane animations,
    // then give ResizeObserver and the resulting React layout another frame to settle.
    await win.webContents.capturePage(); await wait(650)
    await win.webContents.capturePage(); await wait(100)
    await win.webContents.capturePage(); await wait(100)
    return win.webContents.capturePage()
  }
  const results = []
  await win.loadURL(process.env.TIP_CARD_URL)
  await until('!!window.fixture && !!document.querySelector(".stage-shell")')
  for (const [width, height] of [[1440, 900], [480, 360]]) {
    win.setContentSize(width, height)
    const size = `${width}x${height}`
    for (const [name, options] of [
      ['tip', {}], ['choice', { choice: true }], ['toast-terminal', { toast: true, pane: true }],
      ['choice-toast-terminal', { choice: true, toast: true, pane: true }]
    ]) {
      await js(`window.fixture.show(${JSON.stringify(options)})`)
      await until('!!document.querySelector(".tip-card")')
      const shot = await settle()
      const detail = await js(`(() => {
        const tip = document.querySelector('.tip-card'), shell = document.querySelector('.stage-shell')
        const t = tip.getBoundingClientRect(), s = shell.getBoundingClientRect()
        const visible = getComputedStyle(tip).visibility !== 'hidden'
        const collisions = [...document.querySelectorAll('.answers-float, .toasts, .term-pane.open')].filter(n => {
          const r = n.getBoundingClientRect()
          return r.width && r.height && t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top
        }).map(n => n.className)
        const buttons = [...tip.querySelectorAll('button')].map(b => {
          const r = b.getBoundingClientRect()
          return tip.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
        })
        return { visible, collisions, fits: t.top >= s.top && t.bottom <= s.bottom && t.left >= s.left && t.right <= s.right,
          hit: buttons.every(Boolean), count: document.querySelectorAll('.tip-card').length }
      })()`)
      const mustShow = name !== 'choice-toast-terminal'
      const ok = detail.count === 1 && (!mustShow || detail.visible) && (!detail.visible || (detail.fits && !detail.collisions.length && detail.hit))
      results.push({ label: `${size} ${name}`, ok, detail })
      if (!ok) console.error('FAILED', results.at(-1))
      fs.writeFileSync(path.join(shots, `${name}-${size}.png`), shot.toPNG())
    }
    // Restore room and verify the single global off/on row in the real General screen.
    await js('window.fixture.show({ general: true })')
    await until('!!document.querySelector("#setting-feature-tips input")')
    await js('document.querySelector("#setting-feature-tips").scrollIntoView({ block: "center" })')
    const shot = await settle()
    const settingsOk = await js(`(async () => {
      const input = document.querySelector('#setting-feature-tips input')
      if (!input.checked) return false
      input.click(); await new Promise(r => setTimeout(r, 30))
      if (window.fixture.getState().settings.featureTips || input.checked) return false
      input.click(); await new Promise(r => setTimeout(r, 30))
      return input.checked && window.fixture.getState().settings.featureTips && document.querySelectorAll('#setting-feature-tips').length === 1
    })()`)
    results.push({ label: `${size} General Feature tips switch`, ok: settingsOk })
    fs.writeFileSync(path.join(shots, `settings-${size}.png`), shot.toPNG())
  }
  fs.writeFileSync(process.env.TIP_CARD_RESULTS, JSON.stringify(results, null, 2))
  app.exit(results.every(r => r.ok) ? 0 : 1)
}).catch(error => { console.error(error); app.exit(1) })
