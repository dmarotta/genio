import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Play's progress and status show on the Play screen's one status line only: nothing on its paths pushes a message elsewhere.
const PLAY_PATHS = [
  'src/renderer/src/views/Play.tsx', 'src/renderer/src/views/PlayLive.tsx', 'src/renderer/src/views/PlayerInstanceSettings.tsx',
  'src/renderer/src/lib/play-screen.ts', 'src/renderer/src/lib/play-nav.ts', 'src/renderer/src/lib/play-audio.ts', 'src/renderer/src/lib/play-audio-worklet.ts',
  'src/main/play.ts', 'src/main/play-unity.ts', 'src/main/play-stream.ts', 'src/main/player-instance.ts', 'src/main/player-copy.ts',
  'src/main/player-process.ts', 'src/main/player-sources.ts'
]

describe('Play reports only on its own screen', () => {
  it('has no toast, desktop notification, feed or chat call on any Play path', () => {
    for (const file of PLAY_PATHS) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\btoast\(|\bnotify\w*\(|new Notification\b|showNotification|\.publish\(|\bpostChat|\bkillfeed|\bfeed\(/i)
    }
    expect(readFileSync('src/main/index.ts', 'utf8')).not.toMatch(/playerInstanceService\([^)]*\)\.start\(\)[^\n]*toast/)
  })

  it('keeps the instance status out of Settings and the unit page', () => {
    expect(readFileSync('src/renderer/src/views/PlayerInstanceSettings.tsx', 'utf8')).not.toMatch(/playerInstanceStatus|This project:/)
    expect(readFileSync('src/renderer/src/views/Squad.tsx', 'utf8')).not.toMatch(/playerInstanceStatus/)
  })
})
