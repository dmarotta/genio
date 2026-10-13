/** Plain JS worker source keeps stat/sidecar IO off Electron's main thread, also in packaged builds. */
export const INVENTORY_WORKER = String.raw`
const { parentPort, workerData: d } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.realpathSync(d.root);
const dirs = new Map();
function inside(p) {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel);
}
function safe(rel) {
  const p = path.join(root, rel), dir = path.dirname(p);
  let real = dirs.get(dir);
  if (!real) { real = fs.realpathSync(dir); dirs.set(dir, real); }
  if (real !== root && !inside(real)) throw Error('Outside project');
  if (!rel.toLowerCase().startsWith('.genio/') && path.relative(root, real).toLowerCase().split(path.sep).includes('.genio')) throw Error('Hidden folder');
  if (path.relative(root, real).split(path.sep).some(p => /^(?:\.git|\.godot|\.import|Library|Temp|Logs|obj|Build|Builds|BuildOutput|UserSettings|Intermediate|Saved|DerivedDataCache|Binaries|node_modules)$/i.test(p))) throw Error('Hidden folder');
  return p;
}
function read(rel, cap) {
  const p = safe(rel);
  if (!fs.lstatSync(p).isFile()) throw Error('Not a regular file');
  const fd = fs.openSync(p, 'r');
  try {
    const b = Buffer.alloc(cap);
    return b.subarray(0, fs.readSync(fd, b, 0, cap, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function meta(rel) {
  const text = read(rel, 65536);
  const labels = /(?:^|\n)labels:[ \t]*\r?\n((?:[ \t]*-[^\n]*\r?\n?)*)/.exec(text)?.[1] || '';
  const texture = /\btextureType:\s*(\d+)/.exec(text);
  return { path: rel, loaded: true, mtimeMs: fs.statSync(safe(rel)).mtimeMs, guid: /(?:^|\n)guid:\s*([a-f\d]+)/i.exec(text)?.[1],
    uid: /\buid="([^"]+)"/.exec(text)?.[1],
    importer: /(?:^|\n)(\w+Importer):/.exec(text)?.[1] || /\bimporter="([^"]+)"/.exec(text)?.[1],
    textureType: texture ? Number(texture[1]) : undefined,
    labels: labels.split('\n').map(s => s.replace(/^\s*-\s*/, '').trim()).filter(Boolean) };
}
try {
  if (d.hash) {
    if (!fs.lstatSync(safe(d.hash)).isFile()) throw Error('Not a regular file');
    const stream = fs.createReadStream(safe(d.hash));
    const hash = crypto.createHash('sha256');
    stream.on('data', b => hash.update(b));
    stream.on('error', e => { throw e; });
    stream.on('end', () => parentPort.postMessage(hash.digest('hex')));
  } else {
    const results = [];
    for (const a of d.assets) {
      try {
        if (d.metadataOnly) {
          try { a.meta = meta(a.meta.path); } catch { a.meta = undefined; }
          a.tags = [...new Set([...a.tags, ...(a.meta?.labels || [])])];
          if (a.meta?.importer === 'TextureImporter' || a.meta?.importer === 'texture') a.tags.push('texture');
          if (a.meta?.textureType === 8) a.tags.push('sprite');
          if (a.meta?.textureType === 1) a.tags.push('normal');
          results.push(a); continue;
        }
        const file = safe(a.path), stat = fs.lstatSync(file);
        if (!stat.isFile()) continue;
        a.size = stat.size; a.mtimeMs = stat.mtimeMs;
        a.lfs = false; a.generated = false;
        if (stat.size <= 1024) {
          const text = read(a.path, 1024);
          const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:([a-f\d]{64})\r?\nsize (\d+)\s*$/i.exec(text);
          if (pointer) { a.lfs = true; a.lfsOid = pointer[1]; a.lfsSize = Number(pointer[2]); }
        }
        if (a.ext === 'tres' && !a.lfs && !/^\[gd_resource\s+type="[^"]*Material[^"]*"/m.test(read(a.path, 1024))) continue;
        if (a.sidecar) {
          if (!a.meta?.loaded) a.meta = { path: a.sidecar, labels: [], loaded: false };
          else try {
            const s = fs.lstatSync(safe(a.sidecar));
            if (s.isFile()) {
              if (!a.meta?.loaded || a.meta.mtimeMs !== s.mtimeMs) a.meta = { path: a.sidecar, labels: [], loaded: false, mtimeMs: s.mtimeMs };
            } else a.meta = undefined;
          } catch { a.meta = undefined; }
        } else a.meta = undefined;
        if (a.record) {
          try {
            const p = JSON.parse(read(a.record, 262144));
            if (p.schema === 'genio.provenance.v1' && p.path === a.path && typeof p.sha256 === 'string' && typeof p.by === 'string' && typeof p.provider === 'string') {
              a.provenance = p; a.generated = true;
            }
          } catch {}
        }
        a.tags.push(...(a.meta?.labels || []));
        if (a.meta?.importer === 'TextureImporter' || a.meta?.importer === 'texture') a.tags.push('texture');
        if (a.meta?.textureType === 8) a.tags.push('sprite');
        if (a.meta?.textureType === 1) a.tags.push('normal');
        delete a.sidecar; delete a.record;
        results.push(a);
      } catch { /* deleted, inaccessible or symlink: omit */ }
    }
    parentPort.postMessage(results);
  }
} catch (e) { throw e; }
`
