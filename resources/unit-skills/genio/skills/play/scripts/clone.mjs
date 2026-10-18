// Dev Drive (ReFS) block cloning: probe volumes, clone a folder, verify sharing once.
// Dependency-free. Never creates, mounts or changes a volume; anything unexpected falls back to a normal copy.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

/** Files under one 4 KB cluster copy faster than they clone. */
export const SMALL_FILE = 4096
const BLOCK_REFCOUNTING = 0x08000000 // FILE_SUPPORTS_BLOCK_REFCOUNTING
const DRIVE_FIXED = 3
// From Windows 11 24H2 CopyFile (and so Node's fs.copyFile) clones by itself on ReFS and Dev Drive.
const AUTO_CLONE_BUILD = 26100
const VERIFY_MIN = 64 * 1024
const PARALLEL = 16

export function windowsBuild(release = os.release()) { return Number(release.split('.')[2]) || 0 }
/** copyfile: CopyFile clones (24H2+). fsctl: an explicit FSCTL_DUPLICATE_EXTENTS_TO_FILE helper (23H2). */
export function cloneMethod(build = windowsBuild()) { return build >= AUTO_CLONE_BUILD ? 'copyfile' : 'fsctl' }
const normal = p => { const v = path.resolve(p); return process.platform === 'win32' ? v.toLowerCase() : v }
/** Stable folder name for one Genio directory's files on another volume. */
export function volumeKey(dir) { return createHash('sha256').update(normal(dir)).digest('hex').slice(0, 16) }
/** Where a Genio directory keeps its files on another volume: <volume>/.genio/<key>. */
export function volumeHome(dir, volumeRoot) { return path.join(volumeRoot, '.genio', volumeKey(dir)) }
/** The first folder under <volume>/.genio/<key(dir)>/<sub>/ that contains p, or undefined. */
export function volumeChild(p, dir, sub) {
  const original = path.resolve(p).replace(/\\/g, '/'), text = process.platform === 'win32' ? original.toLowerCase() : original
  const marker = `/.genio/${volumeKey(dir)}/${sub}/`, at = text.indexOf(marker)
  return at < 0 ? undefined : original.slice(at + marker.length).split('/')[0] || undefined
}

/**
 * Short folder ids keep Unity's deepest paths (Library/PackageCache) under Windows' 260 characters: a Play copy
 * or slot folder is named by the first 8 hex of its 24-hex key, or a longer prefix when another key took that one.
 */
export const SHORT_ID_LENGTHS = [8, 12, 16, 24]
/** True when name is one of key's short ids. */
export function isShortId(name, key) { return SHORT_ID_LENGTHS.includes(name.length) && key.startsWith(name) && /^[0-9a-f]+$/.test(name) }
/**
 * Claims <parent>/<short id of key>: the first id whose folder is created now, is empty, or owns(dir) says is
 * already this key's. mkdir is atomic, so two keys never share a folder. Returns the folder.
 */
export function claimShortFolder(parent, key, owns = () => false) {
  fs.mkdirSync(parent, { recursive: true })
  for (const n of SHORT_ID_LENGTHS) {
    const dir = path.join(parent, key.slice(0, n))
    try { fs.mkdirSync(dir); return dir } catch (e) { if (e.code !== 'EEXIST') throw e }
    try { if (owns(dir) || !fs.readdirSync(dir).length) return dir } catch { /* Not a readable folder: try the next id. */ }
  }
  throw new Error(`No free folder for ${key} under ${parent}`)
}

/**
 * The flat layout of Play copies and slots: one folder per copy or slot, directly under <volume>/.genio (the
 * project's block-cloning volume) or Genio's data folder, named by FLAT_ID_LENGTH hex. Nothing else in the path,
 * so Unity's deepest paths (Library/PackageCache) keep the most room under Windows' 260 characters.
 */
export const FLAT_ID_LENGTH = 9
export const FLAT_MARKER = '.genio-copy.json'
export function flatBase(data, volumeRoot) { return volumeRoot ? path.join(volumeRoot, '.genio') : data }
/** True when name is a flat copy folder name. */
export function isFlatId(name) { return /^[0-9a-f]{9}$/.test(name) }
/**
 * Claims a new <parent>/<id>: the id is a hash of seed (project key plus kind and slot) and a random part, and
 * mkdir is atomic, so a folder that exists for another owner is never reused. Returns the folder.
 */
export function claimFlatFolder(parent, seed) {
  fs.mkdirSync(parent, { recursive: true })
  for (let attempt = 0; attempt < 64; attempt++) {
    const id = createHash('sha256').update(`${seed}\0${randomBytes(8).toString('hex')}`).digest('hex').slice(0, FLAT_ID_LENGTH)
    const dir = path.join(parent, id)
    try { fs.mkdirSync(dir); return dir } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  throw new Error(`No free folder for ${seed} under ${parent}`)
}
/** The manifest of a flat copy folder: what it is for, or undefined when it has none. */
export function readFlatMarker(dir) {
  try { const m = JSON.parse(fs.readFileSync(path.join(dir, FLAT_MARKER), 'utf8')); return m && typeof m === 'object' ? m : undefined } catch { return undefined }
}
/** True when dir is a flat copy folder (a flat id under a .genio folder or Genio's data) carrying a manifest. */
export function isFlatCopyDir(dir, data) {
  const resolved = path.resolve(dir), parent = path.dirname(resolved)
  const norm = p => process.platform === 'win32' ? p.toLowerCase() : p
  return isFlatId(path.basename(resolved)) && (path.basename(parent).toLowerCase() === '.genio' || norm(parent) === norm(path.resolve(data))) && !!readFlatMarker(resolved)
}

/** True when the volume holding p is not mounted, such as a Dev Drive VHDX that was not re-attached after a reboot. */
export function volumeMissing(p, options = {}) { return !{ ...defaultSystem, ...options.system }.mounted(rootOf(p)) }
/** Throws a player-facing error when p is missing because its whole drive is not mounted. */
export function assertMounted(p, options) {
  if (!fs.existsSync(p) && volumeMissing(p, options)) throw new Error(`The project drive ${rootOf(p)} is not mounted. If it is a Dev Drive VHDX, attach it again (Disk Management > Action > Attach VHD) and retry.`)
}
const rootOf = p => path.parse(path.resolve(p)).root
const driveOf = p => rootOf(p).toLowerCase()
// Windows cannot boot from ReFS, so the system drive never block clones: no probe needed.
const onSystemDrive = (p, system) => { const drive = system.systemDrive(); return !!drive && driveOf(p) === driveOf(`${drive}\\`) }
function existing(p) {
  for (let at = path.resolve(p); ; at = path.dirname(at)) { if (fs.existsSync(at)) return at; if (path.dirname(at) === at) return undefined }
}

const VOLUME_CS = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class GenioVolume {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumePathNameW(string file, StringBuilder volume, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeNameForVolumeMountPointW(string mount, StringBuilder name, int size);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeInformationW(string root, StringBuilder label, int labelSize, out uint serial, out uint maxComponent, out uint flags, StringBuilder fs, int fsSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetDiskFreeSpaceW(string root, out uint sectorsPerCluster, out uint bytesPerSector, out uint freeClusters, out uint totalClusters);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);

  public static string Probe(string path) {
    var root = new StringBuilder(1024);
    if (!GetVolumePathNameW(path, root, root.Capacity)) return path + "\t!" + Marshal.GetLastWin32Error();
    string r = root.ToString();
    var guid = new StringBuilder(1024);
    string id = GetVolumeNameForVolumeMountPointW(r, guid, guid.Capacity) ? guid.ToString() : "";
    uint serial, max, flags, spc, bps, free, total;
    var fs = new StringBuilder(64);
    if (!GetVolumeInformationW(r, null, 0, out serial, out max, out flags, fs, fs.Capacity)) return path + "\t!" + Marshal.GetLastWin32Error();
    long cluster = GetDiskFreeSpaceW(r, out spc, out bps, out free, out total) ? (long)spc * bps : 0;
    return string.Join("\t", new string[] { path, r, id, serial.ToString(), fs.ToString(), flags.ToString(), cluster.ToString(), GetDriveTypeW(r).ToString() });
  }

  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, SHARE_READ = 1, OPEN_EXISTING = 3, CREATE_NEW = 1, SPARSE = 0x200;
  const uint FSCTL_DUPLICATE_EXTENTS_TO_FILE = 0x00098344, FSCTL_SET_SPARSE = 0x000900C4, FSCTL_GET_INTEGRITY_INFORMATION = 0x0009027C, FSCTL_SET_INTEGRITY_INFORMATION = 0x0009C280;
  // Each call must stay under 4 GB; 1 GB is cluster-aligned for every ReFS cluster size.
  const long CHUNK = 1L << 30;
  [StructLayout(LayoutKind.Sequential)] struct Duplicate { public IntPtr Source; public long SourceOffset; public long TargetOffset; public long Count; }
  [StructLayout(LayoutKind.Sequential)] struct GetIntegrity { public ushort Algorithm; public ushort Reserved; public uint Flags; public uint ChunkSize; public uint ClusterSize; }
  [StructLayout(LayoutKind.Sequential)] struct SetIntegrity { public ushort Algorithm; public ushort Reserved; public uint Flags; }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] struct Info { public uint Attributes; public long Created; public long Accessed; public long Written; public uint Serial; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle h, uint code, ref Duplicate input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle h, uint code, ref SetIntegrity input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr input, int inputSize, out GetIntegrity output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool DeviceIoControl(SafeFileHandle h, uint code, IntPtr input, int inputSize, IntPtr output, int outputSize, out int returned, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int infoClass, ref long value, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFileTime(SafeFileHandle h, IntPtr created, IntPtr accessed, ref long written);

  // Block clone one file: same size, sparseness, integrity and write time; the data blocks are shared.
  static int CloneOne(string src, string dst, long cluster, out bool created) {
    created = false;
    int ret;
    using (var s = CreateFileW(src, GENERIC_READ, SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
      if (s.IsInvalid) return Marshal.GetLastWin32Error();
      Info info;
      if (!GetFileInformationByHandle(s, out info)) return Marshal.GetLastWin32Error();
      long size = ((long)info.SizeHigh << 32) | info.SizeLow;
      using (var d = CreateFileW(dst, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero, CREATE_NEW, 0, IntPtr.Zero)) {
        if (d.IsInvalid) return Marshal.GetLastWin32Error();
        created = true;
        if ((info.Attributes & SPARSE) != 0 && !DeviceIoControl(d, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out ret, IntPtr.Zero)) return Marshal.GetLastWin32Error();
        GetIntegrity gi;
        if (DeviceIoControl(s, FSCTL_GET_INTEGRITY_INFORMATION, IntPtr.Zero, 0, out gi, Marshal.SizeOf(typeof(GetIntegrity)), out ret, IntPtr.Zero) && gi.Algorithm != 0) {
          var si = new SetIntegrity { Algorithm = gi.Algorithm, Flags = gi.Flags };
          if (!DeviceIoControl(d, FSCTL_SET_INTEGRITY_INFORMATION, ref si, Marshal.SizeOf(typeof(SetIntegrity)), IntPtr.Zero, 0, out ret, IntPtr.Zero)) return Marshal.GetLastWin32Error();
        }
        if (!SetFileInformationByHandle(d, 6, ref size, 8)) return Marshal.GetLastWin32Error();
        // Ranges are cluster-aligned; the last one may end past EOF inside its cluster.
        long end = (size + cluster - 1) / cluster * cluster;
        for (long at = 0; at < end; at += CHUNK) {
          var dup = new Duplicate { Source = s.DangerousGetHandle(), SourceOffset = at, TargetOffset = at, Count = Math.Min(CHUNK, end - at) };
          if (!DeviceIoControl(d, FSCTL_DUPLICATE_EXTENTS_TO_FILE, ref dup, Marshal.SizeOf(typeof(Duplicate)), IntPtr.Zero, 0, out ret, IntPtr.Zero)) return Marshal.GetLastWin32Error();
        }
        long written = info.Written;
        SetFileTime(d, IntPtr.Zero, IntPtr.Zero, ref written);
      }
      uint keep = info.Attributes & 0x7; // read-only, hidden, system
      if (keep != 0) File.SetAttributes(dst, (FileAttributes)(keep | 0x20));
    }
    return 0;
  }

  // Lines of "source<TAB>destination". A file that cannot be cloned is copied instead.
  public static string Clone(string list, long cluster) {
    int cloned = 0, copied = 0, failed = 0, firstError = 0;
    string failure = "";
    foreach (var line in File.ReadAllLines(list, Encoding.UTF8)) {
      int tab = line.IndexOf('\t');
      if (tab < 0) continue;
      string src = line.Substring(0, tab), dst = line.Substring(tab + 1);
      bool created = false;
      int error;
      try { error = CloneOne(src, dst, cluster, out created); } catch (Exception) { error = -1; }
      if (error == 0) { cloned++; continue; }
      if (firstError == 0) firstError = error;
      try {
        if (created) { File.SetAttributes(dst, FileAttributes.Normal); File.Delete(dst); }
        File.Copy(src, dst);
        copied++;
      } catch (Exception e) { failed++; if (failure == "") failure = dst + ": " + e.Message; }
    }
    return "cloned=" + cloned + "\tcopied=" + copied + "\tfailed=" + failed + "\terror=" + firstError + "\tfailure=" + failure.Replace('\t', ' ').Replace('\n', ' ');
  }
}
`

async function powershell(script, env) {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -TypeDefinition $env:GENIO_VOLUME_CS; ${script}`, 'utf16le').toString('base64')],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60 * 1000, env: { ...process.env, GENIO_VOLUME_CS: VOLUME_CS, ...env } })
  return stdout
}
/** One record per path: its volume mount point, GUID, file system, flags, cluster size and drive type. */
export function parseProbe(line) {
  const [p, root, guid, serial, fsName, flags, cluster, driveType] = line.split('\t')
  if (root?.startsWith('!')) return { path: p, error: `GetVolumeInformation failed (${root.slice(1)})` }
  const f = Number(flags)
  return { path: p, root, guid: guid || `serial:${serial}`, fs: fsName, flags: f, cluster: Number(cluster), driveType: Number(driveType), blockClone: (f & BLOCK_REFCOUNTING) !== 0 && Number(driveType) === DRIVE_FIXED && Number(cluster) > 0 }
}
async function probeWindows(paths) {
  const stdout = await powershell('foreach ($p in ($env:GENIO_VOLUME_PATHS | ConvertFrom-Json)) { [GenioVolume]::Probe($p) }', { GENIO_VOLUME_PATHS: JSON.stringify(paths) })
  const rows = stdout.split(/\r?\n/).filter(Boolean).map(parseProbe)
  return paths.map(p => rows.find(r => r.path === p) ?? { path: p, error: 'no probe result' })
}
async function helperWindows(list, cluster) {
  const out = (await powershell('[GenioVolume]::Clone($env:GENIO_CLONE_LIST, [long]$env:GENIO_CLONE_CLUSTER)', { GENIO_CLONE_LIST: list, GENIO_CLONE_CLUSTER: String(cluster) })).trim().split(/\r?\n/).pop() ?? ''
  const fields = Object.fromEntries(out.split('\t').map(kv => { const at = kv.indexOf('='); return [kv.slice(0, at), kv.slice(at + 1)] }))
  if (!('cloned' in fields)) throw new Error(`clone helper gave no result: ${out.slice(0, 200)}`)
  return { cloned: Number(fields.cloned), copied: Number(fields.copied), failed: Number(fields.failed), error: Number(fields.error), failure: fields.failure || undefined }
}
async function fsutilWindows(file) {
  try { return (await exec('fsutil', ['file', 'queryExtentsAndRefCounts', file], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout }
  catch (e) { return `error: ${(e.stdout || e.stderr || e.message || '').toString().trim()}` }
}
const defaultSystem = { probe: probeWindows, helper: helperWindows, fsutil: fsutilWindows, build: windowsBuild, platform: () => process.platform, systemDrive: () => process.env.SystemDrive, mounted: root => fs.existsSync(root) }

/** fsutil file queryExtentsAndRefCounts output: true when any extent is shared (refcount above 1), null when unreadable. */
export function sharedExtents(output) {
  const refs = [...String(output).matchAll(/\bRef(?:\s*Count)?\s*[:=]\s*(0x[0-9a-f]+|\d+)/gi)].map(m => Number(m[1]))
  return refs.length ? refs.some(n => n > 1) : null
}

/**
 * Can files under source be block cloned to target? Both must sit on one fixed volume that reports
 * FILE_SUPPORTS_BLOCK_REFCOUNTING (ReFS, Dev Drive). target need not exist yet.
 */
export async function probeClone(source, target, options = {}) {
  const system = { ...defaultSystem, ...options.system }
  if (system.platform() !== 'win32') return { capable: false, reason: 'block cloning is only used on Windows' }
  for (const p of [source, target]) if (volumeMissing(p, { system })) return { capable: false, detached: true, reason: `${rootOf(p)} is not mounted (a Dev Drive VHDX may need re-attaching)` }
  if (driveOf(source) !== driveOf(target)) return { capable: false, reason: `${driveOf(source).toUpperCase()} and ${driveOf(target).toUpperCase()} are different volumes` }
  if (onSystemDrive(source, system)) return { capable: false, reason: `${driveOf(source).toUpperCase()} is the system drive, which is never ReFS` }
  const paths = [existing(source), existing(target)]
  if (paths.some(p => !p)) return { capable: false, reason: 'path not found' }
  let a, b
  try { [a, b] = await system.probe(paths) } catch (e) { return { capable: false, reason: `volume probe failed (${e.message})` } }
  if (a.error || b.error) return { capable: false, reason: a.error || b.error }
  if (a.guid !== b.guid) return { capable: false, reason: `${a.root} and ${b.root} are different volumes` }
  if (!a.blockClone) return { capable: false, reason: `${a.root} (${a.fs}) does not support block cloning` }
  return { capable: true, volume: a, method: cloneMethod(system.build()) }
}

/**
 * Where Genio puts its copies of project files that live under anchor (a Genio folder): on the project's
 * volume when that volume block clones and anchor's does not share it. undefined keeps anchor.
 */
export async function volumePlacement(project, anchor, options = {}) {
  const system = { ...defaultSystem, ...options.system }
  if (system.platform() !== 'win32' || volumeMissing(project, { system }) || onSystemDrive(project, system)) return undefined
  // Same drive: same volume (a folder-mounted volume under it is not detected and keeps the anchor).
  if (driveOf(project) === driveOf(anchor)) return undefined
  const paths = [existing(project) ?? rootOf(project), existing(anchor) ?? rootOf(anchor)]
  let a, b
  try { [a, b] = await system.probe(paths) } catch { return undefined }
  if (a.error || !a.blockClone || !b.error && a.guid === b.guid) return undefined
  return a.root
}

const VOLUMES = 'clone-volumes.json'
function readVerified(data) { try { return JSON.parse(fs.readFileSync(path.join(data, VOLUMES), 'utf8')).volumes ?? {} } catch { return {} } }
function writeVerified(data, guid, record) {
  const volumes = { ...readVerified(data), [guid]: record }, temp = path.join(data, `${VOLUMES}.${process.pid}.tmp`)
  fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(temp, JSON.stringify({ volumes }, null, 2)); fs.renameSync(temp, path.join(data, VOLUMES))
}
/** The recorded sharing check for a volume: { shared: true | false | null, at, method, file }. */
export function volumeVerification(data, guid) { return readVerified(data)[guid] }

async function walk(source, dest, skip, files) {
  for (const e of await fs.promises.readdir(source, { withFileTypes: true })) {
    // Links (symlinks and junctions) are never followed or copied.
    if (e.isSymbolicLink() || skip(e.name, e.isDirectory())) continue
    const from = path.join(source, e.name), to = path.join(dest, e.name)
    if (e.isDirectory()) { await fs.promises.mkdir(to); await walk(from, to, skip, files) }
    else if (e.isFile()) files.push({ from, to, size: (await fs.promises.stat(from)).size })
  }
}
async function each(items, fn) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => { while (next < items.length) await fn(items[next++]) }))
}
const long = p => process.platform === 'win32' && !p.startsWith('\\\\') ? `\\\\?\\${p}` : p

/**
 * Seed dest (missing or empty) from source, leaving out entries for which skip(name, isDirectory) is true. Clones when both share a block-cloning volume, otherwise
 * (and after any clone failure, with dest removed again) runs fallback(), the normal copy.
 * Returns what happened: method 'clone' (via copyfile or fsctl) or 'copy' with the reason.
 */
export async function seedTree(source, dest, { skip = () => false, fallback, data, system: injected } = {}) {
  const system = { ...defaultSystem, ...injected }
  const started = Date.now()
  const copy = async reason => { await fallback(); return { method: 'copy', reason, ms: Date.now() - started } }
  const probe = await probeClone(source, path.dirname(dest), { system })
  if (!probe.capable) return copy(probe.reason)
  const recorded = data && volumeVerification(data, probe.volume.guid)
  if (recorded?.shared === false) return copy(`${probe.volume.root} was verified not to share cloned blocks (${recorded.method}, ${recorded.at})`)
  await fs.promises.mkdir(dest, { recursive: true })
  if ((await fs.promises.readdir(dest)).length) throw new Error(`Clone destination is not empty: ${dest}`)
  const files = []
  try {
    await walk(source, dest, skip, files)
    let cloned = 0, copied = 0
    const small = probe.method === 'copyfile' ? files : files.filter(f => f.size < SMALL_FILE)
    const large = probe.method === 'copyfile' ? [] : files.filter(f => f.size >= SMALL_FILE)
    await each(small, async f => { await fs.promises.copyFile(f.from, f.to, fs.constants.COPYFILE_EXCL); if (f.size >= SMALL_FILE) cloned++; else copied++ })
    if (large.length) {
      const list = path.join(os.tmpdir(), `genio-clone-${randomUUID()}.txt`)
      fs.writeFileSync(list, large.map(f => `${long(f.from)}\t${long(f.to)}`).join('\r\n'), 'utf8')
      let result
      try { result = await system.helper(list, probe.volume.cluster) } finally { fs.rmSync(list, { force: true }) }
      if (result.failed) throw new Error(`could not copy ${result.failed} file(s): ${result.failure}`)
      cloned += result.cloned; copied += result.copied
      if (!result.cloned) {
        // Every clone was refused, so each file was copied instead: dest is complete. Stop trying on this volume.
        if (data) writeVerified(data, probe.volume.guid, { shared: false, at: new Date().toISOString(), method: probe.method, root: probe.volume.root, error: result.error })
        return { method: 'copy', reason: `${probe.volume.root} refused block cloning (Windows error ${result.error})`, files: files.length, copied, ms: Date.now() - started }
      }
    }
    const verified = data ? await verifyOnce(data, probe, files, system) : undefined
    const bytes = files.reduce((n, f) => n + f.size, 0)
    return { method: 'clone', via: probe.method, files: files.length, bytes, cloned, copied, verified, ms: Date.now() - started }
  } catch (e) {
    await fs.promises.rm(dest, { recursive: true, force: true })
    return copy(`block clone failed (${e.message})`)
  }
}

// One check per volume: fsutil must show the largest cloned file sharing its blocks. A definite
// "not shared" turns cloning off for that volume; an unreadable answer is retried next time.
async function verifyOnce(data, probe, files, system) {
  const recorded = volumeVerification(data, probe.volume.guid)
  if (typeof recorded?.shared === 'boolean') return recorded.shared
  const sample = files.filter(f => f.size >= Math.max(VERIFY_MIN, probe.volume.cluster)).sort((a, b) => b.size - a.size)[0]
  if (!sample) return null
  const shared = sharedExtents(await system.fsutil(sample.to))
  writeVerified(data, probe.volume.guid, { shared, at: new Date().toISOString(), method: probe.method, root: probe.volume.root, file: sample.to })
  return shared
}
