import { expect, test } from 'claude-code/testing'

import { isNewer, nicknameOf, noticeOf, cantDraw, causeOf, NO_FFMPEG, noFfmpeg } from '../hooks/register'

test('a newer version is spotted, an older or equal one is not', () => {
  expect(isNewer('0.5.0', '0.4.0')).toBe(true)
  expect(isNewer('1.10.0', '1.9.3')).toBe(true)
  expect(isNewer('0.4.0', '0.4.0')).toBe(false)
  expect(isNewer('0.4.0', '0.5.0')).toBe(false)
  expect(isNewer('1.0.0-beta', '0.9.0')).toBe(true)
})



test('the missing-ffmpeg message says how to install it, Homebrew included', () => {
  expect(NO_FFMPEG.includes('brew install ffmpeg')).toBe(true)
  expect(NO_FFMPEG.includes('https://brew.sh')).toBe(true)
  expect(/ENOENT/.test(NO_FFMPEG)).toBe(false)
})

const P = '/Users/u/Desktop/hero.png'
const kindOf = (raw: string, path = P) => noticeOf(new Error(raw), path, '/Users/u').kind

test('each failure gets its own plain notice', () => {
  expect(kindOf('show-your-work: $.fs.stat(/Users/u/Desktop/hero.png) failed: ENOENT')).toBe('missing')
  expect(kindOf("could not convert /x/.show-your-work/c50a67.txt: Error: Cannot extract image from file.")).toBe('not_image')
  expect(kindOf('ffmpeg could not read /x/9e1d4a.mp4: moov atom not found')).toBe('broken_video')
  expect(kindOf('ffmpeg could not read /x/a.mp4: [out#0/image2] Output file does not contain any stream')).toBe('no_picture')
  expect(kindOf(NO_FFMPEG)).toBe('no_ffmpeg')
  expect(kindOf('$.process.run(/opt/homebrew/bin/ffprobe) failed: ENOENT')).toBe('missing')
  expect(kindOf('something odd')).toBe('other')
})

test('notices use the person\'s own path, never raw tool output or internal copies', () => {
  for (const raw of ['show-your-work: $.fs.stat(/private/tmp/x) failed: ENOENT', 'could not convert /a/.show-your-work/c50a67.txt: sips', 'ffmpeg could not read /tmp/claude-show-your-work/v1/a.mp4: moov atom not found']) {
    const n = noticeOf(new Error(raw), P, '/Users/u')
    for (const text of [n.message, n.text, n.prompt]) {
      expect(/ENOENT|sips|moov|\.show-your-work|show-your-work:/.test(text)).toBe(false)
    }
    expect(n.message.includes('~/Desktop/hero.png')).toBe(true)
  }
})

test('a picture that cannot draw says why, and tells Claude it was not seen', () => {
  expect(causeOf(true, 'ghostty')).toBe('tmux')
  expect(causeOf(false, 'ghostty')).toBe('background')
  expect(causeOf(false, 'apple_terminal')).toBe('terminal')
  expect(cantDraw('tmux', 'a.png', 'picture', 'id1').command).toBe('set -g allow-passthrough on')
  expect(cantDraw('terminal', 'a.png', 'picture', 'id1').title).toBe("This terminal can't show pictures")
  expect(cantDraw('background', 'a.png', 'video', 'id1').command.includes('--resume id1')).toBe(true)
  for (const cause of ['tmux', 'terminal', 'background'] as const) expect(cantDraw(cause, 'a.png', 'picture', '').claude.includes('saw a notice')).toBe(true)
})

test('Linux gets its own ffmpeg notice, with a package manager instead of Homebrew', () => {
  const n = noticeOf(new Error(noFfmpeg(false)), '/home/u/a.jpg', '/home/u')
  expect(n.kind).toBe('no_ffmpeg')
  expect(n.text.includes('apt install ffmpeg')).toBe(true)
  expect(/brew/.test(n.text + n.prompt + n.message)).toBe(false)
  expect(noticeOf(new Error(noFfmpeg(true)), '/Users/u/a.mp4', '/Users/u').text.includes('brew install ffmpeg')).toBe(true)
})

test('Windows gets a winget ffmpeg notice', () => {
  const n = noticeOf(new Error(noFfmpeg(false, true)), 'C:/Users/u/a.mp4', 'C:/Users/u')
  expect(n.kind).toBe('no_ffmpeg')
  expect(n.text.includes('winget install Gyan.FFmpeg')).toBe(true)
  expect(n.prompt.includes('winget install Gyan.FFmpeg')).toBe(true)
  expect(/brew|apt/.test(n.text + n.prompt + n.message)).toBe(false)
})

test('each install gets a made-up name, the same every time', () => {
  const id = '8f14e45f-ceea-467f-a9d3-6c1b7c8d2e11'
  expect(nicknameOf(id)).toBe(nicknameOf(id))
  expect(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{1,3}$/.test(nicknameOf(id))).toBe(true)
  expect(nicknameOf(id)).not.toBe(nicknameOf('0b7e0d1a-1234-4c4c-9a9a-aaaaaaaaaaaa'))
})

