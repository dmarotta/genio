// Reproducible UPM tarball. No npm/network required at application runtime.
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
const root = path.resolve('resources/unity/com.genio.play')
const chunks = []
function walk(dir, prefix = 'package') {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name), name = `${prefix}/${e.name}`
    if (e.isDirectory()) { walk(p, name); continue }
    if (!e.isFile()) throw new Error('Package links are forbidden')
    const body = fs.readFileSync(p), header = Buffer.alloc(512)
    if (Buffer.byteLength(name) > 100) throw new Error('Tar path too long')
    header.write(name); header.write('0000644\0',100); header.write('0000000\0',108); header.write('0000000\0',116)
    header.write(body.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136)
    header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257); header.write('00',263)
    header.write([...header].reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148)
    chunks.push(header,body,Buffer.alloc((512-body.length%512)%512))
  }
}
walk(root); chunks.push(Buffer.alloc(1024))
fs.writeFileSync(path.join(root, '..', 'com.genio.play-0.1.0.tgz'), gzipSync(Buffer.concat(chunks), { level: 9 }))
