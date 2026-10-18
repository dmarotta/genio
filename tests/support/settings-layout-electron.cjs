// Real Chromium layout of Settings at three window sizes: every page's card fills the height below the
// header with one scrollbar, and the Auto-loot confirm on the short Delivery page renders over the whole
// window with both buttons visible and clickable. Writes screenshots to SETTINGS_SHOTS.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const SIZES = [{ name: '1440x900', width: 1440, height: 900 }, { name: '880x640', width: 880, height: 640 }, { name: '480x360', width: 480, height: 360 }]
const SHORT_PAGES = [['project', 'Delivery'], ['project', 'Asset generation']]

app.whenReady().then(async () => {
  const shots = process.env.SETTINGS_SHOTS || path.join(path.dirname(process.env.SETTINGS_RESULTS), 'shots')
  fs.mkdirSync(shots, { recursive: true })
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } })
  const js = code => win.webContents.executeJavaScript(code)
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log('Renderer:', message) })
  const until = async (code, label) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) { if (await js(code)) return; await wait(50) }
    throw new Error(`Timed out: ${label}`)
  }
  /** A settled frame: a hidden window only paints (and runs its animations) when asked for a frame. */
  const shot = async () => { await win.webContents.capturePage(); await wait(450); return win.webContents.capturePage() }
  const save = async name => fs.writeFileSync(path.join(shots, `${name}.png`), (await shot()).toPNG())
  const fail = async () => { const error = await js(`document.getElementById('fixture-error')?.textContent || ''`); if (error) throw new Error('Settings crashed:\n' + error) }
  const open = async (group, label) => {
    const ok = await js(`(() => {
      const link = [...document.querySelectorAll('.sys-nav-item.sys-in-${group} .sys-link')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)}))
      link?.click(); document.querySelector('.sys-view').scrollTop = 0; return !!link
    })()`)
    if (!ok) throw new Error(`No Settings page ${group} › ${label}`)
    await until(`document.querySelector('.sys-link.on')?.textContent.trim().startsWith(${JSON.stringify(label)})`, `page ${label}`)
    await shot()
    await fail()
  }
  /** The card reaches the bottom of the view's content box; only the view scrolls around it. */
  const measure = () => js(`(() => {
    const view = document.querySelector('.sys-view'), body = document.querySelector('.sys-body')
    view.scrollTop = 0
    const cs = getComputedStyle(view), vr = view.getBoundingClientRect(), br = body.getBoundingClientRect()
    const floor = vr.top + view.clientHeight - parseFloat(cs.paddingBottom)
    const scrollers = []
    for (let el = body; el; el = el.parentElement) {
      const s = getComputedStyle(el)
      if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1) scrollers.push(el.className || el.tagName)
    }
    const page = document.scrollingElement
    return {
      fills: br.bottom >= floor - 1, gap: Math.round(floor - br.bottom), cardOverflow: body.scrollHeight > body.clientHeight + 1,
      scrollers, pageScrolls: page.scrollHeight > page.clientHeight + 1 || page.scrollWidth > page.clientWidth + 1, sideways: view.scrollWidth > view.clientWidth + 1
    }
  })()`)

  const results = []
  const check = (label, ok, detail) => { results.push({ label, ok }); if (!ok) console.log('FAILED', label, JSON.stringify(detail)) }
  await win.loadURL(process.env.SETTINGS_URL)
  await until('!!document.querySelector(".sys-nav") || !!document.getElementById("fixture-error")', 'Settings mounted')
  await fail()
  const pages = await js(`[...document.querySelectorAll('.sys-nav-item')].map(n => [n.className.match(/sys-in-(\\w+)/)[1], n.querySelector('.sys-link').textContent.trim()])`)

  for (const size of SIZES) {
    win.setContentSize(size.width, size.height)
    await shot()
    for (const [group, label] of pages) {
      await open(group, label)
      const m = await measure()
      check(`${size.name} ${group} › ${label} fills`, m.fills && !m.cardOverflow && m.scrollers.length <= 1 && !m.pageScrolls && !m.sideways, m)
    }
    for (const [group, label] of SHORT_PAGES) {
      await open(group, label)
      await save(`short-${label.toLowerCase().replace(/\W+/g, '-')}-${size.name}`)
    }

    // The fixture has no remote: the PR modes are grey, and hovering one says why below the picker.
    await open('project', 'Delivery')
    await js(`document.querySelector('[aria-label="Delivery"] button[aria-haspopup="listbox"]').click()`)
    await until(`!!document.querySelector('[role="listbox"] [role="option"]')`, 'Delivery list')
    const at = await js(`(() => { const r = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === 'Standard').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
    // A hidden window handles input only as it paints: move in from outside the row, a frame after each move.
    for (const point of [{ x: at.x, y: at.y - 200 }, at]) { win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await shot() }
    await until(`document.querySelector('.picker-desc')?.textContent.includes('has no remote')`, 'reason on hover')
    const p = await js(`(() => {
      const rows = [...document.querySelectorAll('[role="option"]')], list = document.querySelector('[role="listbox"]'), desc = document.querySelector('.picker-desc')
      const inView = r => r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
      const look = o => { const s = getComputedStyle(o); return { color: s.color, cursor: s.cursor, pad: [s.paddingTop, s.paddingLeft].map(parseFloat) } }
      const off = rows.filter(o => o.getAttribute('aria-disabled') === 'true').map(look), on = rows.filter(o => o.getAttribute('aria-disabled') !== 'true').map(look)
      return { names: rows.map(o => o.textContent), off, on, listInView: inView(list.getBoundingClientRect()), descInView: desc.getBoundingClientRect().right <= innerWidth,
        descShown: (r => document.elementFromPoint(r.left + 4, r.top + r.height / 2) === desc)(desc.getBoundingClientRect()) }
    })()`)
    check(`${size.name} Delivery picker`, p.names.join('|') === 'Auto · Offline|Hardcore|Hardcore (prod)|Standard|Offline' && p.off.length === 3 && p.on.length === 2 &&
      p.off.every(o => o.cursor === 'not-allowed' && o.color !== p.on[0].color) && [...p.off, ...p.on].every(o => o.pad[0] >= 8 && o.pad[1] >= 12) && p.listInView && p.descInView && (p.descShown || size.height < 640), p)
    await save(`delivery-picker-${size.name}`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await until(`!document.querySelector('[role="listbox"]')`, 'Esc closes the Delivery list')

    await open('project', 'Delivery')
    await js(`[...document.querySelectorAll('label.field')].find(f => f.querySelector('.label')?.textContent === 'Merge finished work automatically').querySelector('input').click()`)
    await until(`!!document.querySelector('[role="dialog"]')`, 'Auto-loot confirm')
    await shot()
    const d = await js(`(() => {
      const dialog = document.querySelector('[role="dialog"]'), body = document.querySelector('.sys-body')
      const inView = r => r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
      const buttons = ['Cancel', 'Turn on Auto-loot'].map(text => {
        const b = [...dialog.querySelectorAll('.modal-foot button')].find(x => x.textContent.trim() === text)
        const r = b.getBoundingClientRect()
        // Hit-tested a few points inside each button: nothing clips or covers them.
        const hit = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5]].every(([fx, fy]) => document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)?.closest('button') === b)
        return { text, visible: inView(r), hit }
      })
      const sr = dialog.getBoundingClientRect(), title = document.querySelector('.titlebar').getBoundingClientRect()
      return {
        inLayer: dialog.parentElement?.id === 'genio-layer' && dialog.parentElement.parentElement === document.body,
        outsideCard: !body.contains(dialog), covers: sr.left <= 0 && sr.top <= 0 && sr.right >= innerWidth && sr.bottom >= innerHeight,
        overTitle: dialog.contains(document.elementFromPoint(title.left + title.width / 2, title.top + title.height / 2)),
        buttons
      }
    })()`)
    check(`${size.name} Auto-loot confirm over the window`, d.inLayer && d.outsideCard && d.covers && d.overTitle && d.buttons.every(b => b.visible && b.hit), d)
    await save(`autoloot-confirm-${size.name}`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    await until(`!document.querySelector('[role="dialog"]')`, 'Esc closes the confirm')
  }
  fs.writeFileSync(process.env.SETTINGS_RESULTS, JSON.stringify(results, null, 1))
  app.exit(results.every(r => r.ok) ? 0 : 1)
}).catch(error => {
  console.error(error)
  app.exit(1)
})
