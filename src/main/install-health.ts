/**
 * Startup health check of Genio's own install (existence checks only) and the plain recovery card shown
 * instead of a crash when it is broken. Genio never runs npm install in its checkout by itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { genioInstallReport, type GenioInstallReport } from '../../resources/unit-skills/genio/lib/node-deps.mjs'

export { genioInstallReport, type GenioInstallReport }

/** Title prefix the card sets on Copy; the main process copies the command (no preload, no clipboard permission). */
export const COPY_SIGNAL = 'genio-copy-'

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function recoveryCardHtml(r: GenioInstallReport): string {
  const missing = r.missing.slice(0, 8).map(m => `<li><code>${esc(m)}</code></li>`).join('') + (r.missing.length > 8 ? `<li>and ${r.missing.length - 8} more</li>` : '')
  const linked = r.linked.length
    ? `<p>These unit worktrees link their <code>node_modules</code> to this folder; an install run in one of them rewrites it. Genio removes those links when it next starts with a working install.</p><ul>${r.linked.map(l => `<li><code>${esc(l.worktree)}</code></li>`).join('')}</ul>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>Genio: dependencies are broken</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
body{margin:0;background:#07090e;color:#d8e2ee;font:14px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:620px;margin:24px;padding:24px 28px;border:1px solid #23303f;border-radius:10px;background:#0d131c}
h1{font-size:18px;margin:0 0 8px;color:#ffb347}code{font-family:Consolas,monospace;font-size:13px}
.cmd{display:flex;gap:8px;align-items:center;margin:14px 0}.cmd code{flex:1;padding:8px 10px;background:#05070b;border:1px solid #23303f;border-radius:6px;word-break:break-all}
button{padding:8px 14px;border:0;border-radius:6px;background:#00e5ff;color:#05070b;font-weight:600;cursor:pointer}ul{margin:4px 0 12px;padding-left:20px}
</style></head><body><div class="card" role="alert">
<h1>${esc(r.message)}</h1>
<p>Genio cannot start because packages it needs are missing from <code>${esc(path.join(r.root, 'node_modules'))}</code>. Close Genio, run this in a terminal, then start Genio again:</p>
<div class="cmd"><code id="cmd">${esc(r.command)}</code><button id="copy" type="button">Copy</button></div>
<p>Missing:</p><ul>${missing}</ul>${linked}
</div><script>
document.getElementById('copy').addEventListener('click', function () { document.title = '${COPY_SIGNAL}' + Date.now(); this.textContent = 'Copied' })
</script></body></html>`
}

/** One line per startup with a broken install, for the player and for whoever diagnoses it later. */
export function logInstallReport(r: GenioInstallReport, homeRoot: string): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event: 'install.broken', root: r.root, missing: r.missing, linkedWorktrees: r.linked.map(l => l.worktree) })
  console.error(`[genio] ${r.message}. Missing: ${r.missing.join(', ')}`)
  for (const l of r.linked) console.error(`[genio] unit worktree ${l.worktree} links node_modules to ${l.target}`)
  try {
    fs.mkdirSync(path.join(homeRoot, 'state'), { recursive: true })
    fs.appendFileSync(path.join(homeRoot, 'state', 'install-health.log'), line + '\n')
  } catch { /* the console line remains */ }
}
