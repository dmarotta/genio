import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { upgradeKeys } from '../src/main/legacy-keys'
import { Home } from '../src/main/home'
import { readJson, readJsonl } from '../src/main/util'

const dirs: string[] = []
const tmp = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'genio-legacy-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

describe('records written before the workspace rename', () => {
  it('renames the old keys on read and keeps new ones', () => {
    expect(JSON.parse('{"wksp":"a","wkspModel":"m","nested":[{"wksp":"b"}]}', upgradeKeys)).toEqual({ workspace: 'a', workspaceModel: 'm', nested: [{ workspace: 'b' }] })
    expect(JSON.parse('{"wksp":"old","workspace":"new"}', upgradeKeys)).toEqual({ workspace: 'new' })
    expect(JSON.parse('{"estimate":1,"material":2}', upgradeKeys)).toEqual({ estimate: 1, material: 2 })
  })

  it('loads old json and jsonl files', () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, 'a.json'), '{"project":"p","wksp":"main"}')
    fs.writeFileSync(path.join(d, 'a.jsonl'), '{"type":"x","wksp":"ally"}\n{"type":"y","wksp":"main"}\n')
    expect(readJson(path.join(d, 'a.json'), {})).toEqual({ project: 'p', workspace: 'main' })
    expect(readJsonl(path.join(d, 'a.jsonl'))).toEqual([{ type: 'x', workspace: 'ally' }, { type: 'y', workspace: 'main' }])
  })

  it('reads the old wksp.json until workspace.json exists', () => {
    const home = new Home(tmp())
    fs.mkdirSync(home.state, { recursive: true })
    fs.writeFileSync(path.join(home.state, 'wksp.json'), '{}')
    expect(home.workspaceFileToRead).toBe(path.join(home.state, 'wksp.json'))
    fs.writeFileSync(home.workspaceFile, '{}')
    expect(home.workspaceFileToRead).toBe(home.workspaceFile)
  })
})