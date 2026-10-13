import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const canonical = p => { const v = fs.realpathSync(p); return process.platform === 'win32' ? v.toLowerCase() : v }
export function poolDirectory(data, world) { return path.join(data, 'play-pools', createHash('sha256').update(canonical(world)).digest('hex').slice(0, 24)) }
export class PlayPool {
  constructor(data, world, engineRoot = '') {
    this.world = fs.realpathSync(world)
    if (path.isAbsolute(engineRoot) || /[:\x00-\x1f]/.test(engineRoot) || engineRoot.split(/[\\/]/).includes('..')) throw new Error('Invalid Unity root')
    this.engineRoot = engineRoot
    this.dir = poolDirectory(data, world)
    fs.mkdirSync(this.dir, { recursive: true })
  }
  async transaction(fn) {
    const lock = path.join(this.dir, 'mutex')
    let acquired = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { fs.mkdirSync(lock); acquired = true; break } catch (e) { if (e.code !== 'EEXIST') throw e }
      await new Promise(r => setTimeout(r, 20))
    }
    // Never race another writer by deleting its lock. A crashed transaction needs inspection.
    if (!acquired) throw new Error(`Play pool transaction locked; inspect ${lock} before recovery`)
    try {
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }))
      const file = path.join(this.dir, 'state.json')
      const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { cap: 1, slots: [], queue: [] }
      const now = Date.now()
      state.queue = state.queue.filter(q => q.expires > now && alive(q.pid))
      for (const s of state.slots) if (s.lease && (!alive(s.lease.pid) || !s.preparing && s.lease.expires <= now)) { delete s.lease; s.preparing = false }
      const result = fn(state)
      const temp = path.join(this.dir, 'state.tmp')
      fs.writeFileSync(temp, JSON.stringify(state, null, 2))
      fs.renameSync(temp, file)
      return result
    } finally { fs.rmSync(lock, { recursive: true }) }
  }
  root(id) { if (!Number.isInteger(id) || id < 1 || id > 8) throw new Error('Invalid Play slot'); return path.join(this.dir, `slot-${id}`, this.engineRoot) }
  async state() { return this.transaction(s => ({ cap: s.cap, slots: s.slots.map(v => ({ id: v.id, root: this.root(v.id), revision: v.revision, owner: v.lease?.owner, expires: v.lease?.expires, preparing: v.preparing })), queue: s.queue.map(q => q.owner) })) }
  async configure(cap) {
    if (!Number.isInteger(cap) || cap < 1 || cap > 8) throw new Error('Play cap must be 1–8')
    return this.transaction(s => {
      if (s.slots.some(v => v.id > cap && (v.lease || this.editorAlive(v.id)))) throw new Error('Release slots and close their editors before lowering the cap')
      s.cap = cap
    })
  }
  editorAlive(id) {
    const root = this.root(id)
    if (fs.existsSync(path.join(root, 'Temp/UnityLockfile'))) return true
    try { const d = JSON.parse(fs.readFileSync(path.join(root, 'Library/EditorInstance.json'), 'utf8')); return Number.isInteger(d.process_id) && d.process_id > 0 && alive(d.process_id) } catch { return false }
  }
  async acquire(owner, pid = process.pid, preferred, takeover = false) {
    if (typeof owner !== 'string' || !owner || owner.length > 160 || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) throw new Error('Invalid Play owner')
    if (preferred !== undefined) this.root(preferred)
    return this.transaction(s => {
      if (preferred > s.cap) throw new Error('Slot exceeds pool cap')
      const existing = s.slots.find(v => v.lease?.owner === owner && v.lease.pid === pid)
      if (existing) { existing.lease.expires = Date.now() + 30000; return { id: existing.id, token: existing.lease.token, root: this.root(existing.id) } }
      let request = s.queue.find(q => q.owner === owner && q.pid === pid)
      if (!request) { request = { owner, pid, expires: 0 }; s.queue.push(request) }
      request.expires = Date.now() + 30000
      if (!takeover && s.queue[0] !== request) return null
      let slot = s.slots.find(v => v.id <= s.cap && (!preferred || v.id === preferred) && (!v.lease || takeover && !v.preparing))
      if (!slot) {
        const id = Array.from({ length: s.cap }, (_, i) => i + 1).find(id => (!preferred || preferred === id) && !s.slots.some(v => v.id === id))
        if (id) { slot = { id }; s.slots.push(slot) }
      }
      if (!slot) return null
      slot.lease = { owner, pid, token: randomUUID(), expires: Date.now() + 30000 }
      s.queue = s.queue.filter(q => q !== request)
      return { id: slot.id, token: slot.lease.token, root: this.root(slot.id) }
    })
  }
  async check(id, token) { return this.transaction(s => { const v = s.slots.find(v => v.id === id); if (!v?.lease || v.lease.token !== token) throw new Error('Play lease lost; stop controlling this editor'); v.lease.expires = Date.now() + 30000; return this.root(id) }) }
  async release(id, token) { return this.transaction(s => { const v = s.slots.find(v => v.id === id); if (v?.lease?.token === token) { delete v.lease; v.preparing = false } }) }
  async cancel(owner, pid = process.pid) { return this.transaction(s => { s.queue = s.queue.filter(q => q.owner !== owner || q.pid !== pid) }) }
  async mainControl() {
    return this.transaction(s => {
      if (s.main && s.main.pid !== process.pid && alive(s.main.pid) && s.main.expires > Date.now()) throw new Error('The main editor is controlled by another Genio process')
      s.main = { pid: process.pid, expires: Date.now() + 30000 }
    })
  }
  async releaseMain() { return this.transaction(s => { if (s.main?.pid === process.pid) delete s.main }) }
  async estimate() {
    let bytes = 0
    const scan = async dir => { for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) { if (e.isSymbolicLink() || ['.git', 'Temp', 'Logs'].includes(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) await scan(p); else if (e.isFile()) bytes += (await fs.promises.stat(p)).size } }
    await scan(path.join(this.world, this.engineRoot))
    return bytes
  }
  async prepare(id, token, source = this.world) {
    await this.check(id, token)
    // Source must be the registered repository or one of its git worktrees.
    const gitOptions = { windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(this.dir, 'no-hooks') } }
    const git = async (cwd, args) => (await exec('git', args, { ...gitOptions, cwd })).stdout.trim()
    const common = async cwd => canonical(path.resolve(cwd, await git(cwd, ['rev-parse', '--git-common-dir'])))
    if (await common(source) !== await common(this.world)) throw new Error('Play source must belong to the registered world')
    const revision = await git(source, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const dest = path.join(this.dir, `slot-${id}`)
    const ready = await this.transaction(s => {
      const slot = s.slots.find(v => v.id === id)
      if (slot?.lease?.token !== token) throw new Error('Play lease lost')
      if (slot.revision === revision && fs.existsSync(this.root(id))) return true
      if (this.editorAlive(id)) throw new Error('Close the slot editor before changing its branch')
      slot.preparing = true; return false
    })
    if (ready) return this.root(id)
    try {
      if (!fs.existsSync(dest)) await exec('git', ['clone', '--no-hardlinks', '--no-checkout', '--', this.world, dest], gitOptions)
      if (await git(dest, ['status', '--porcelain', '--untracked-files=normal'])) {
        // A new --no-checkout clone has an empty index and appears entirely deleted.
        const populated = fs.existsSync(path.join(dest, '.git', 'genio-play-ready'))
        if (populated) throw new Error('Play slot has local changes; preserve them before switching branches')
      }
      await git(dest, ['fetch', '--', source, revision])
      await this.check(id, token)
      await git(dest, ['checkout', '--detach', revision])
      // A Unity import may write anywhere under these trees. Reject links before
      // opening the editor so a copied project's link cannot reach another world.
      await this.validateCopy(id)
      const library = path.join(this.root(id), 'Library')
      if (!fs.existsSync(library)) {
        const original = path.join(this.world, this.engineRoot, 'Library')
        if (fs.existsSync(original)) await fs.promises.cp(original, library, { recursive: true, filter: async p => !['Pipeline', 'EditorInstance.json', 'SourceAssetDB-lock', 'ArtifactDB-lock'].includes(path.basename(p)) && !(await fs.promises.lstat(p)).isSymbolicLink() })
      }
      // Marker lives in .git, never dirties the copied project.
      fs.writeFileSync(path.join(dest, '.git', 'genio-play-ready'), revision)
      await this.transaction(s => { const slot = s.slots.find(v => v.id === id); if (slot?.lease?.token !== token) throw new Error('Play lease lost'); slot.revision = revision; slot.preparing = false })
      return this.root(id)
    } catch (e) { await this.transaction(s => { const slot = s.slots.find(v => v.id === id); if (slot?.lease?.token === token) slot.preparing = false }); throw e }
  }
  async validateCopy(id) {
    const slot = path.join(this.dir, `slot-${id}`)
    const check = async p => {
      const stat = await fs.promises.lstat(p)
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error('Play slots cannot contain symlinks, junctions or hardlinks')
      if (stat.isDirectory()) for (const name of await fs.promises.readdir(p)) await check(path.join(p, name))
    }
    let current = slot
    await checkParents(slot)
    for (const part of this.engineRoot.split(/[\\/]/).filter(Boolean)) { current = path.join(current, part); await checkParents(current) }
    for (const name of ['Assets', 'Packages', 'ProjectSettings']) if (fs.existsSync(path.join(current, name))) await check(path.join(current, name))
    async function checkParents(p) { if ((await fs.promises.lstat(p)).isSymbolicLink()) throw new Error('Play root cannot follow a link') }
  }
}
