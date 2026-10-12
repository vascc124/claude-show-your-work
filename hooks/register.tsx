import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Check, Frames, KeyChange, Overlay, Shown, Summary } from '../types'

const PANE = 'show-your-work'
// The tools, and their names from before the rename, so old windows still draw.
const TOOLS = ['show_image', 'show_video'].map(t => `mcp__show-your-work__${t}`)
// Frames and converted pictures. A private folder per user, chosen at session
// start: a fixed name in the shared /tmp could be made first, or pointed
// elsewhere, by another user on the same machine.
let TMP = '/tmp/claude-show-your-work'
export const PICK_TMP = [
  'base="${TMPDIR:-/tmp}"; base="${base%/}"; d="$base/claude-show-your-work-$(id -u)"',
  'mkdir -m 700 -p "$d" 2>/dev/null',
  'if [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ]; then chmod 700 "$d"; printf "%s" "$d"; else mktemp -d "$base/claude-show-your-work-XXXXXX"; fi',
].join('\n')
// Deletes the oldest frame folders until the cache is under $1 KB, keeping the
// newest two and the ones named in $2; only inside a folder this user owns.
export const TRIM_SH = [
  '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] && cd -P "$0" 2>/dev/null || exit 0',
  'all=$(ls -dtr v* p* 2>/dev/null); n=$(printf "%s\\n" "$all" | grep -c .)',
  'for d in $(printf "%s\\n" "$all" | head -n $((n > 2 ? n - 2 : 0))); do',
  '  [ "$(du -sk . | cut -f1)" -le "$1" ] && break',
  '  case " $2 " in *" $d "*) continue ;; esac',
  '  [ -L "$d" ] || rm -rf "./$d"',
  'done; true',
].join('\n')
// Deletes anything in the cache older than a week, without following links.
export const CLEAN_SH = [
  '[ -d "$0" ] && [ ! -L "$0" ] && [ -O "$0" ] || exit 0',
  'find -P "$0" -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null; true',
].join('\n')
const MARK = 'show-your-work:'
const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi|gif)$/i
// Frames a clip is cut into at most, and the rate it plays at below that.
const MAX_FRAMES = 900
const MAX_FPS = 12
// The window's fill: a step lighter than a dark terminal, so it reads as one panel.
const PANEL = '#2c2e35'
// The QA report beside the picture, and the width the window needs for it.
const SIDE = 40
// The sidebar's fill: darker than the window, so the report stands apart.
const SIDEBAR = '#1d1e23'
const WIDE_ENOUGH = 110
const current = atom({ plugin: 'show-your-work', key: 'current' } as const, null)

let cwd = ''
let home = ''
let ffmpeg = 'ffmpeg'
let ffprobe = 'ffprobe'
let generation = 0
let pastedNames: string[] = []
// A button press, by name only. False, so it chains: act('save') || keep().
const act = (action: string): false => (track('action', { action }), false)

// Playback per drawn site (a transcript row's tool_use_id, or the pane).
type Player = {
  frame: number
  timer?: Timer
  isCompare?: boolean
  isSplit?: boolean
  // which earlier version the compared side is, when there are several
  step?: number
  // the sidebar lists the versions instead of what changed
  isHistory?: boolean
  // scrolled out of view since it was last drawn
  wasAway?: boolean
  // back in view: send the frame on screen again after drawing
  resend?: boolean
  hasAutoplayed?: boolean
  // how many bar cells the scrub row last drew, so playback redraws only on a change
  segments?: number
  // which page of key changes the sidebar shows
  changesPage?: number
  // where the updated video was, kept while a still original is shown
  updatedFrame?: number
  // the picture's size in cells as last drawn, for repaints
  box?: { columns: number; rows: number }
}
const players = new Map<string, Player>()
// Calls made since this load: only these autoplay, not every window a reload redraws.
const freshCalls = new Set<string>()
// Each failed show's notice, by tool call, for the box drawn in its place.
const notices = new Map<string, Notice>()
// Every change that should repaint bumps this; a window's drawing is kept and
// handed back while nothing changed (scrolling only moves which rows show).
let version = 0
const versions = new Map<string, number>()
const drawn = new Map<string, { key: string; tree: unknown }>()

// A change to one window bumps only its own count, so the others hand back
// their kept drawing when the repaint reaches them.
function redraw($: EngineInterface, site?: string) {
  if (site) versions.set(site, (versions.get(site) ?? 0) + 1)
  else version += 1
  $.ui.invalidate('ui.render')
}
export const player = (site: string): Player => {
  let one = players.get(site)
  if (!one) players.set(site, (one = { frame: 0 }))

  return one
}

// A typed or dragged-in path: quotes, backslash-escaped spaces and ~ allowed.
// On Windows a backslash is a separator, made forward, and a Git Bash path
// (/c/Users/...) becomes the drive path it names.
export function expand(path: string, base: string, homeDir: string, win = isWin): string {
  let p = path.trim().replace(/^(['"])(.*)\1$/, '$2')
  p = win ? p.replace(/\\/g, '/').replace(/^\/([a-z])\//i, (_, d: string) => `${d.toUpperCase()}:/`) : p.replace(/\\(.)/g, '$1')
  if (p === '~' || p.startsWith('~/')) p = homeDir + p.slice(1)
  if (p.startsWith('/') || (win && /^[a-z]:\//i.test(p))) return p

  return `${base.replace(/\/$/, '')}/${p}`
}

// A name with its look-alike spaces made plain: macOS writes a narrow
// no-break space before AM/PM in screenshot names, which a typed path lacks.
export const looseName = (name: string) =>
  name.normalize('NFC').replace(/[  -   　]/g, ' ')

// The file a path means: as given when it exists, else the one entry in its
// folder whose name matches once spaces are made plain.
async function locate($: EngineInterface, raw: string): Promise<string> {
  const path = expand(raw, cwd, home)
  if (await $.fs.stat(path).then(() => true, () => false)) return path
  const cut = path.lastIndexOf('/')
  const dir = path.slice(0, cut) || '/'
  const want = looseName(path.slice(cut + 1))
  const hit = (await $.fs.list(dir).catch(() => [])).find(f => looseName(f.name) === want)

  return hit ? `${dir.replace(/\/$/, '')}/${hit.name}` : path
}

export const frameFile = (frames: Frames, i: number) => `${frames.dir}/f${String(i + 1).padStart(5, '0')}.png`

// How fast to sample a clip so it stays under MAX_FRAMES.
export const sampleRate = (duration: number) =>
  Math.max(1, Math.min(MAX_FPS, Math.floor(MAX_FRAMES / Math.max(duration, 0.1))))

export const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`

// macOS unless the session says Linux: every Linux path below is a branch
// beside the macOS one, which stays as it was.
let isMac = true
// Windows, from the session's OS variable. Pictures convert as on Linux
// (ffmpeg), and the Unix tools the scripts here use come from Git for
// Windows, which Claude Code on Windows already needs.
let isWin = false
let usrBin = ''

// A Windows path written with forward slashes, which Git's tools, ffmpeg and
// the terminal all read; other systems' paths stay as they are.
const slash = (path: string) => (isWin ? path.replace(/\\/g, '/') : path)
// A Unix tool by name: on Windows, the one in Git for Windows' usr/bin.
const unix = (name: string) => (isWin ? `${usrBin}/${name}.exe` : name)
// Runs a script in sh with its arguments as $0, $1...; on Windows Git's
// sh, with its own tools first on the PATH, so `find` is never Windows' own.
const sh = ($: EngineInterface, script: string, ...args: string[]) =>
  $.process.run([unix('sh'), '-c', isWin ? `PATH=/usr/bin:$PATH\n${script}` : script, ...args])

// A small text file's content, or null when it can't be read.
async function readText($: EngineInterface, file: string): Promise<string | null> {
  if (isWin) return ($.fs.read(file) as Promise<string>).catch(() => null)
  const r = await $.process.run(['cat', file]).catch(() => null)

  return r && r.exitCode === 0 ? r.stdout : null
}

// Opens a file or URL with the desktop's default app.
const openCommand = () => (isMac ? 'open' : 'xdg-open')
const isUrl = (target: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
// The command that opens it; Windows' file handler wants backslashes.
const openArgv = (target: string) =>
  isWin
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', isUrl(target) ? target : target.replace(/\//g, '\\')]
    : [openCommand(), target]
// Shows a file in its folder. Explorer exits 1 even when it worked, so on
// Windows the run counts as done once it starts.
async function reveal($: EngineInterface, file: string) {
  if (!isWin) return $.process.run(isMac ? ['open', '-R', file] : ['xdg-open', file.slice(0, file.lastIndexOf('/')) || '/'])
  await $.process.run(['explorer.exe', `/select,${file.replace(/\//g, '\\')}`])

  return { exitCode: 0, stdout: '', stderr: '' }
}

// Git for Windows' usr/bin: from Claude Code's own setting for Git Bash,
// beside the git on the PATH, or where the installer puts it.
async function gitUsrBin($: EngineInterface): Promise<string> {
  const bash = await $.env.get('CLAUDE_CODE_GIT_BASH_PATH')
  const found = await $.process.run(['where.exe', 'git']).catch(() => null)
  const roots = [
    ...(bash ? [slash(bash).replace(/(\/usr)?\/bin\/bash\.exe$/i, '')] : []),
    ...(found?.stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(g => slash(g).replace(/\/(cmd|bin|mingw64\/bin)\/git\.exe$/i, '')),
    'C:/Program Files/Git',
  ]
  for (const root of roots) {
    if (await $.fs.exists(`${root}/usr/bin/sh.exe`).catch(() => false)) return `${root}/usr/bin`
  }

  return 'C:/Program Files/Git/usr/bin'
}

// ffmpeg and ffprobe on Windows: the first `where` finds, '' when missing.
async function whereIs($: EngineInterface, name: string): Promise<string> {
  const r = await $.process.run(['where.exe', name]).catch(() => null)

  return slash((r?.exitCode === 0 ? r.stdout : '').split(/\r?\n/)[0]?.trim() ?? '')
}

// A PNG's size from its header (bytes 16 to 24), without any tool.
export function pngDims(base64: string): { width: number; height: number } | null {
  const b = Uint8Array.from(atob(base64.slice(0, 44)), c => c.charCodeAt(0))
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null
  const at = (i: number) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0

  return { width: at(16), height: at(20) }
}

// Finds a pasted image's original file by name with Spotlight (macOS).
async function findPasted($: EngineInterface, name: string): Promise<string | null> {
  if (name.startsWith('/') || (isWin && /^[a-z]:[\\/]/i.test(name))) return slash(name)
  if (!isMac) return null
  const found = await $.process.run(['mdfind', '-name', name])

  return found.stdout.split('\n').find(line => line.endsWith(`/${name}`)) ?? null
}

async function pngSize($: EngineInterface, png: string) {
  if (!isMac) {
    const d = pngDims(String((await $.fs.read(png, { as: 'bytes' }) as unknown as { base64: string }).base64 ?? ''))
    if (!d || !d.width || !d.height) throw new Error(`not an image: ${png}`)
    return d
  }
  const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', png])
  const width = Number(/pixelWidth:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  const height = Number(/pixelHeight:\s*(\d+)/.exec(dims.stdout)?.[1] ?? 0)
  if (!width || !height) throw new Error(`not an image: ${png}`)

  return { width, height }
}

// Frames on disk are a cache: past 500 MB the oldest folders go, and a window
// that plays one again decodes it again (ensureChunk). The newest two stay.
const FRAMES_CAP_KB = 500_000
// Folders this session is playing are never trimmed.
function trimFrames($: EngineInterface) {
  const inUse = [...watching.keys()].map(d => d.split('/').pop()!).join(' ')
  return sh($, TRIM_SH, TMP, String(FRAMES_CAP_KB), inUse).catch(() => undefined)
}

// A recording often opens on a blank page while the browser loads: white,
// off-white, grey or dark, maybe with a small spinner or logo. Any frame that
// is nearly one flat tone counts as blank; the clip starts at the first real one.
async function whiteLead($: EngineInterface, real: string, duration: number): Promise<number> {
  const r = await $.process.run([ffmpeg, '-v', 'info', '-t', '8', '-i', real,
    '-vf', 'fps=10,scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YLOW:key=lavfi.signalstats.YHIGH',
    '-an', '-f', 'null', '-']).catch(() => null)
  return r ? leadFrom(r.stderr, duration) : 0
}

// The blank opening in that log: the time of the first frame whose 10th to
// 90th percentile brightness spreads wider than a flat page does, if that
// leaves something after it.
export function leadFrom(log: string, duration: number): number {
  let t = 0, low = -1
  for (const line of log.split('\n')) {
    const pts = line.match(/pts_time:([\d.]+)/)
    if (pts) { t = Number(pts[1]); low = -1; continue }
    const lo = line.match(/YLOW=([\d.]+)/)
    if (lo) { low = Number(lo[1]); continue }
    const hi = line.match(/YHIGH=([\d.]+)/)
    if (hi && low >= 0) {
      if (Number(hi[1]) - low > 24) {
        const lead = Math.round(t * 100) / 100
        return lead > 0 && (!(duration > 0) || lead < duration - 0.5) ? lead : 0
      }
      low = -1
    }
  }
  return 0
}

// Times given on the clip as it was, moved to the frames that start after
// its white opening.
export function shiftTimes<T extends { at?: number }>(list: T[] | undefined, lead: number): T[] | undefined {
  if (!list || !lead) return list
  return list.map(c => (c.at === undefined ? c : { ...c, at: Math.max(0, +(c.at - lead).toFixed(2)) }))
}

// Found once, then trusted for the session; while missing it is looked for
// again on each video, so installing it mid-session works.
let hasVideoTools = false

// What to tell Claude and the person when a video can't be cut into frames.
export const NO_FFMPEG =
  "videos need ffmpeg, and it isn't installed. Pictures still work. Install it with `brew install ffmpeg` " +
  '(Claude can run that for you), then restart Claude Code. No Homebrew? Install it first from https://brew.sh.'

// On Linux ffmpeg also turns pictures other than PNG into PNG.
export const NO_FFMPEG_LINUX =
  "videos and pictures other than PNG need ffmpeg, and it isn't installed. Install it with your package manager, " +
  'for example `sudo apt install ffmpeg` or `sudo dnf install ffmpeg` (Claude can run that for you), then restart Claude Code.'
// On Windows: winget instead of a package manager.
export const NO_FFMPEG_WINDOWS =
  "videos and pictures other than PNG need ffmpeg, and it isn't installed. Install it with `winget install Gyan.FFmpeg` " +
  '(Claude can run that for you), then restart Claude Code.'
export const FFMPEG_PROMPT_WINDOWS = 'Install ffmpeg for me with `winget install Gyan.FFmpeg`. Then show it again.'
export const noFfmpeg = (mac: boolean, win = isWin) => (win ? NO_FFMPEG_WINDOWS : mac ? NO_FFMPEG : NO_FFMPEG_LINUX)
export const FFMPEG_PROMPT_LINUX =
  "Install ffmpeg for me with this machine's package manager (for example `sudo apt install ffmpeg`). Then show it again."

// What the person pastes back so Claude installs ffmpeg and tries again.
export const FFMPEG_PROMPT =
  'Install ffmpeg for me with `brew install ffmpeg`. If Homebrew isn\'t installed, tell me how to install it first. Then show the video again.'

// A failure as the person and Claude see it: a box in place of the picture,
// one plain message for Claude, and a prompt to paste back. Never raw tool
// output, never the plugin's internal copy of a file.
export type NoticeKind = 'missing' | 'not_image' | 'broken_video' | 'no_picture' | 'no_ffmpeg' | 'other'
export type Notice = { kind: NoticeKind; title: string; text: string; message: string; prompt: string }

// How a failure reads, from whatever the tools said; `path` is the person's own.
export function noticeOf(err: unknown, path: string, homeDir = ''): Notice {
  const raw = String((err as Error)?.message ?? err)
  const shown = homeDir && path.startsWith(homeDir + '/') ? '~' + path.slice(homeDir.length) : path
  const name = path.split('/').pop() || path
  if (raw.includes(NO_FFMPEG_WINDOWS)) return {
    kind: 'no_ffmpeg', title: 'This needs ffmpeg', message: NO_FFMPEG_WINDOWS, prompt: FFMPEG_PROMPT_WINDOWS,
    text: "ffmpeg isn't installed, so videos and pictures other than PNG can't show here. Copy the prompt and paste it to Claude to install it, or run `winget install Gyan.FFmpeg` yourself.",
  }
  if (raw.includes(NO_FFMPEG_LINUX)) return {
    kind: 'no_ffmpeg', title: 'This needs ffmpeg', message: NO_FFMPEG_LINUX, prompt: FFMPEG_PROMPT_LINUX,
    text: "ffmpeg isn't installed, so videos and pictures other than PNG can't show here. Copy the prompt and paste it to Claude to install it, or install it yourself, for example `sudo apt install ffmpeg`.",
  }
  if (raw.includes(NO_FFMPEG)) return {
    kind: 'no_ffmpeg', title: 'Videos need ffmpeg', message: NO_FFMPEG, prompt: FFMPEG_PROMPT,
    text: "ffmpeg isn't installed, so this video can't play here. Pictures still work. Copy the prompt and paste it to Claude to install it, or run `brew install ffmpeg` yourself. No Homebrew? Get it from brew.sh first.",
  }
  if (/does not contain any stream|matches no streams|no frames in|Output file is empty/i.test(raw)) return {
    kind: 'no_picture', title: 'This video has no picture',
    text: `${name} has sound but no picture, so there's nothing to play.`,
    message: `${shown} has no video track (sound only), so there's nothing to play. Don't retry it; show a file with a picture instead.`,
    prompt: `${shown} has no picture, only sound. Find the right video and show it to me again.`,
  }
  if (/ffmpeg could not read|Invalid data|moov atom|could not find codec|Error opening input/i.test(raw)) return {
    kind: 'broken_video', title: "This video can't be read",
    text: `${name} couldn't be opened as a video. It may be cut off, still being written, or not really a video.`,
    message: `${shown} couldn't be read as a video: it's damaged, unfinished (still recording or cut off), or not a video. Re-export or re-record it, then show it again.`,
    prompt: `${shown} couldn't be read as a video. Check it, re-export or re-record it if it's broken, then show it to me again.`,
  }
  if (/could not convert|not an image|Cannot extract image|sips/i.test(raw)) return {
    kind: 'not_image', title: "This isn't a picture",
    text: `${name} isn't a picture, so it can't be shown. Pictures can be PNG, JPEG, WebP, GIF or TIFF.`,
    message: `${shown} isn't a picture (show_image opens PNG, JPEG, WebP, GIF and TIFF). Show an image file, or use show_video for a video.`,
    prompt: `${shown} isn't a picture. Show me the right file instead.`,
  }
  if (/ENOENT|no such file|not found/i.test(raw)) return {
    kind: 'missing', title: 'File not found',
    text: `There's no file at ${shown}.`,
    message: `There's no file at ${shown}. Check the path (it may have moved or not been saved yet), then show it again.`,
    prompt: `There's no file at ${shown}. Find the right file and show it to me again.`,
  }
  const detail = (raw.split('\n')[0] ?? '').replace(/\/(?:private\/)?tmp\/\S+|\S*\/\.show-your-work\/\S+/g, name).slice(0, 160)
  return {
    kind: 'other', title: "Couldn't show it",
    text: `${name} couldn't be shown: ${detail}`,
    message: `${shown} couldn't be shown: ${detail}`,
    prompt: `${shown} couldn't be shown (${detail}). Look into it and show it to me again.`,
  }
}

// The usage-stats reason for a failure, as a kind.
const REASONS: Record<NoticeKind, string> = {
  missing: 'missing_file', no_ffmpeg: 'video_tools', not_image: 'unreadable', broken_video: 'unreadable', no_picture: 'unreadable', other: 'other',
}

// Cuts a clip into PNG frames the terminal can swap through.
// A file as it is now: its path, size and modified time. The same unchanged
// file shown again maps to the same frames folder and skips the decode; a
// re-rendered one gets a new key and decodes fresh.
export function keyOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0') + text.length.toString(16)
}
async function identityOf($: EngineInterface, raw: string): Promise<string | undefined> {
  const st = await $.fs.stat(expand(raw, cwd, home), { resolve: true }).catch(() => null)
  return st ? keyOf(`${st.realPath ?? raw}|${st.size}|${st.mtimeMs}`) : undefined
}
async function readMeta<T>($: EngineInterface, dir: string): Promise<T | null> {
  const text = await readText($, `${dir}/meta.json`)
  if (text === null) return null
  try { return JSON.parse(text) as T } catch { return null }
}
const writeMeta = ($: EngineInterface, dir: string, meta: unknown) =>
  isWin
    ? $.fs.write(`${dir}/meta.json`, JSON.stringify(meta)).catch(() => undefined)
    : $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0/meta.json"', dir, JSON.stringify(meta)]).catch(() => undefined)

async function prepareVideo($: EngineInterface, real: string, title: string, key?: string): Promise<Shown> {
  if (!hasVideoTools) {
    if (isWin) {
      ffmpeg = (await whereIs($, 'ffmpeg')) || ffmpeg
      ffprobe = (await whereIs($, 'ffprobe')) || ffprobe
    }
    hasVideoTools = (await Promise.all([exists($, ffmpeg), exists($, ffprobe)])).every(Boolean)
    if (!hasVideoTools) throw new Error(noFfmpeg(isMac))
  }
  // The same file shown before: its folder, frames and size are already there.
  if (key) {
    const dir = `${TMP}/v-${key}`
    const meta = await readMeta<{ frames: Omit<Frames, 'dir'>; width: number; height: number }>($, dir)
    if (meta) {
      const frames = { ...meta.frames, dir }
      await $.process.run([unix('touch'), dir]).catch(() => undefined)
      await ensureChunk($, frames, real, 0)
      return { kind: 'video', path: frameFile(frames, 0), source: real, width: meta.width, height: meta.height, title, generation: ++generation, frames }
    }
  }
  const probe = await $.process.run([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', real])
  // Some recordings (MediaRecorder webm) carry no duration: sample those at the
  // top rate. The clip's length is then what the frames cover.
  const probed = Number(probe.stdout.trim())
  const fps = sampleRate(Number.isFinite(probed) && probed > 0 ? probed : 1)
  generation += 1
  const dir = key ? `${TMP}/v-${key}` : `${TMP}/v${generation}-${Math.floor(await $.clock.now())}`
  await $.process.run([unix('mkdir'), '-p', dir])
  const lead = await whiteLead($, real, probed)
  const known = Number.isFinite(probed) && probed > 0
  // A clip of known length is decoded as it plays, a chunk at a time (see
  // ensureChunk); one without (MediaRecorder webm) is cut whole, as before.
  const total = known ? Math.max(1, Math.min(MAX_FRAMES, Math.floor((probed - lead) * fps))) : 0
  const cut = await $.process.run([
    ffmpeg, '-v', 'error', ...(lead ? ['-ss', String(lead)] : []), '-i', real,
    '-vf', `fps=${fps},scale='min(960,iw)':-2`,
    '-frames:v', String(known ? Math.min(CHUNK, total) : MAX_FRAMES), '-compression_level', '1', `${dir}/f%05d.png`,
  ])
  if (cut.exitCode !== 0) throw new Error(`ffmpeg could not read ${real}: ${cut.stderr.trim().slice(0, 200)}`)
  const made = (await $.fs.list(dir)).filter(f => f.name.endsWith('.png')).length
  if (!made) throw new Error(`no frames in ${real}`)
  const count = known ? Math.max(made, total) : made
  const frames = { dir, count, fps, duration: count / fps, ...(lead ? { lead } : {}) }
  const poster = frameFile(frames, 0)

  const size = await pngSize($, poster)
  if (key) await writeMeta($, dir, { frames: { count, fps, duration: frames.duration, ...(lead ? { lead } : {}) }, ...size })
  void trimFrames($)
  return { kind: 'video', path: poster, source: real, ...size, title, generation, frames }
}

// Frames are decoded from the clip as it plays, two seconds at a time: the
// chunk on screen, the one before and the two after stay on disk, the rest
// go. A frame asked for again (a seek, a window scrolled back to) is decoded
// again. The poster, frame 1, always stays.
const CHUNK = 24
const decoding = new Map<string, Promise<void>>()
const exists = ($: EngineInterface, file: string) => $.fs.stat(file).then(() => true, () => false)
// Gone only when the disk says so; no answer at all (no fs here) is not gone.
const isGone = ($: EngineInterface, file: string) =>
  $.fs.stat(file).then(() => false, (e: unknown) => /ENOENT|not found|no such file/i.test(String((e as Error)?.message ?? e)))

function ensureChunk($: EngineInterface, f: Frames, source: string | undefined, i: number): Promise<void> {
  const c = Math.floor(Math.max(0, Math.min(i, f.count - 1)) / CHUNK)
  const key = `${f.dir}#${c}`
  const running = decoding.get(key)
  if (running) return running
  const job = (async () => {
    const first = c * CHUNK
    // The frame asked for, not the chunk's first: the poster outlives its chunk.
    if (await exists($, frameFile(f, Math.max(0, Math.min(i, f.count - 1))))) return
    if (!source) return
    await $.process.run([unix('mkdir'), '-p', f.dir])
    await $.process.run([
      ffmpeg, '-v', 'error', '-ss', String(+((f.lead ?? 0) + first / f.fps).toFixed(3)), '-i', source,
      '-vf', `fps=${f.fps},scale='min(960,iw)':-2`, '-frames:v', String(Math.min(CHUNK, f.count - first)),
      '-start_number', String(first + 1), '-compression_level', '1', `${f.dir}/f%05d.png`,
    ])
    await prune($, f.dir, c)
  })().catch(() => undefined).finally(() => decoding.delete(key))
  decoding.set(key, job)
  return job
}

// Where each player is in each frames folder, as a chunk number.
const watching = new Map<string, Map<string, number>>()
function watch(dir: string, site: string, i: number) {
  let at = watching.get(dir)
  if (!at) watching.set(dir, (at = new Map()))
  at.set(site, Math.floor(i / CHUNK))
}

// Keeps, in a frames folder, chunks c-1 to c+2 around the chunk just made
// and around every player on that folder, and the poster.
async function prune($: EngineInterface, dir: string, c: number) {
  const keep = [c, ...(watching.get(dir)?.values() ?? [])]
  const files = await $.fs.list(dir).catch(() => [])
  const gone = files.map(f => f.name).filter(name => {
    const m = /^f(\d+)\.png$/.exec(name)
    if (!m) return false
    const i = Number(m[1]) - 1
    return i > 0 && !keep.some(k => i >= (k - 1) * CHUNK && i < (k + 3) * CHUNK)
  })
  if (gone.length) await $.process.run([unix('rm'), '-f', ...gone.map(n => `${dir}/${n}`)]).catch(() => undefined)
}

// The frame a side shows, decoded if it has to be; past the middle of a
// chunk, the next one starts decoding so playback never waits.
async function frameReady($: EngineInterface, media: Shown, i: number, site?: string): Promise<void> {
  const f = media.frames
  if (!f) return
  if (site) watch(f.dir, site, i)
  await ensureChunk($, f, media.source, i)
  if (i % CHUNK >= CHUNK / 2 && i + CHUNK < f.count) void ensureChunk($, f, media.source, i + CHUNK)
}

// Moments both runs share (a check by the same name), as [updated, original]
// seconds, kept only while both clocks move forward.
export function anchors(updated: Check[] = [], original: Check[] = []): [number, number][] {
  const at = new Map(original.filter(c => c.at !== undefined).map(c => [c.name, c.at!]))
  const pairs = updated
    .filter(c => c.at !== undefined && at.has(c.name))
    .map(c => [c.at!, at.get(c.name)!] as [number, number])
    .sort((a, b) => a[0] - b[0])
  const kept: [number, number][] = []
  for (const p of pairs) {
    const last = kept.at(-1) ?? [0, 0]
    if (p[0] > last[0] + 0.05 && p[1] > last[1] + 0.05) kept.push(p)
  }

  return kept
}

// The original clip's moment that matches a moment of the updated clip.
export function mapTime(points: [number, number][], t: number, endA: number, endB: number): number {
  const all: [number, number][] = [[0, 0], ...points, [endA, endB]]
  for (let i = 1; i < all.length; i++) {
    const [a0, b0] = all[i - 1]!
    const [a1, b1] = all[i]!
    if (t <= a1 || i === all.length - 1) {
      const k = a1 > a0 ? (b1 - b0) / (a1 - a0) : 1
      return Math.max(0, Math.min(endB, b0 + (t - a0) * k))
    }
  }

  return t
}

// Every `stride`-th frame as a 32×18 grey thumbnail, for matching the two
// runs by eye. Small and sparse on purpose: matching costs frames × frames.
async function thumbs($: EngineInterface, media: Shown, stride: number): Promise<number[][]> {
  const f = media.frames!
  const r = await sh($,
    `"$0" -v error ${f.lead ? `-ss ${f.lead} ` : ''}-i "$1" -vf "fps=${f.fps},select=not(mod(n\\,${stride})),scale=32:18,format=gray" -fps_mode passthrough -frames:v ${Math.ceil(f.count / stride)} -f rawvideo - | od -An -tu1 -v`,
    ffmpeg, media.source ?? '',
  )
  const px = r.stdout.trim().split(/\s+/).map(Number)
  const out: number[][] = []
  for (let i = 0; i + 576 <= px.length; i += 576) out.push(px.slice(i, i + 576))
  return out
}

// How many frames apart to sample so neither run has more than 240.
export const strideFor = (a: number, b: number) => Math.max(1, Math.ceil(Math.max(a, b) / 240))

// A match made on sampled frames, spread back over every updated frame.
export function spreadMatch(sampled: number[], stride: number, count: number, last: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const k = Math.min(sampled.length - 1, Math.floor(i / stride))
    return Math.min(last, (sampled[k] ?? 0) * stride + (i % stride))
  })
}

// What moved since the previous frame: the cursor, a fade, a scroll. The two
// runs move the same way even where the designs differ.
const motion = (f: number[][]) => f.map((px, i) => (i ? px.map((v, k) => v - f[i - 1]![k]!) : px.map(() => 0)))

// The cheapest way to walk both runs in order, frame by frame (dynamic time
// warping), matching how frames look and how they move: [updated, original]
// frame pairs. Holding one side still costs a little, so it only holds where
// the runs really differ.
export function align(a: number[][], b: number[][], hold = 0.01): [number, number][] {
  const n = a.length, m = b.length
  if (!n || !m) return []
  // Typed rows: the inner loop runs n × m × pixels times.
  const ta = a.map(x => Int16Array.from(x)), tb = b.map(x => Int16Array.from(x))
  const ma = motion(a).map(x => Int16Array.from(x)), mb = motion(b).map(x => Int16Array.from(x))
  const diff = (i: number, j: number) => {
    let d = 0, e = 0
    const pa = ta[i]!, pb = tb[j]!, qa = ma[i]!, qb = mb[j]!
    for (let k = 0; k < pa.length; k++) {
      const x = pa[k]! - pb[k]!, y = qa[k]! - qb[k]!
      d += x < 0 ? -x : x
      e += y < 0 ? -y : y
    }
    return (d + 4 * e) / (pa.length * 255)
  }
  const cost = new Float64Array(n * m)
  const step = new Uint8Array(n * m) // 0 both, 1 updated only, 2 original only
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = diff(i, j)
      if (!i && !j) { cost[0] = d; continue }
      const both = i && j ? cost[(i - 1) * m + j - 1]! : Infinity
      const up = i ? cost[(i - 1) * m + j]! + hold : Infinity
      const on = j ? cost[i * m + j - 1]! + hold : Infinity
      const best = Math.min(both, up, on)
      cost[i * m + j] = best + d
      step[i * m + j] = best === both ? 0 : best === up ? 1 : 2
    }
  }
  const path: [number, number][] = []
  for (let i = n - 1, j = m - 1; ; ) {
    path.push([i, j])
    if (!i && !j) break
    const s = step[i * m + j]
    if (s === 0) { i--; j-- } else if (s === 1) i--
    else j--
  }
  return path.reverse()
}

// For each updated frame, the original frame shown beside it.
export function matchOf(path: [number, number][], count: number): number[] {
  const out = new Array<number>(count).fill(0)
  for (const [i, j] of path) if (i < count) out[i] = j
  for (let i = 1; i < count; i++) out[i] = Math.max(out[i]!, out[i - 1]!)
  return out
}

// The path cut to the few turns that matter, in seconds, to keep it small.
export function turns(match: number[], fpsA: number, fpsB: number): [number, number][] {
  const points: [number, number][] = []
  for (let i = 1; i < match.length - 1; i++) {
    const before = match[i]! - match[i - 1]!, after = match[i + 1]! - match[i]!
    if ((before === 0) !== (after === 0) || Math.abs(before - after) > 1) points.push([+(i / fpsA).toFixed(2), +(match[i]! / fpsB).toFixed(2)])
  }
  return points.length > 40 ? points.filter((_, k) => k % Math.ceil(points.length / 40) === 0) : points
}

// The narrowest the scrub and button rows get, in columns: room for the play
// button, both times, a usable bar and the action buttons on one line.
const CONTROLS_MIN = 64

// Pixels between Original and Updated in the merged clip.
const PAIR_GAP = 40

// Merges the original and updated recordings into one clip, side by side.
// The original's frames are matched to the updated clip's by how they look,
// so every step happens at the same moment on both sides.
async function preparePair($: EngineInterface, original: Shown, updated: Shown) {
  const f = updated.frames!, g = original.frames!
  generation += 1
  const dir = `${TMP}/p-${keyOf(f.dir + '|' + g.dir)}`
  type PairMeta = { pair: Omit<Frames, 'dir'>; pairWidth: number; pairHeight: number; sync: [number, number][] }
  const known = await readMeta<PairMeta>($, dir)
  if (known) {
    const pair = { ...known.pair, dir }
    await $.process.run([unix('touch'), dir]).catch(() => undefined)
    await pairChunk($, pair, updated, original, i => compareFrame({ ...updated, compare: original, sync: known.sync }, i), 0)
    return { pair, pairWidth: known.pairWidth, pairHeight: known.pairHeight, sync: known.sync }
  }
  const stride = strideFor(f.count, g.count)
  const [ta, tb] = await Promise.all([thumbs($, updated, stride), thumbs($, original, stride)])
  const match = ta.length && tb.length
    ? spreadMatch(matchOf(align(ta, tb), ta.length), stride, f.count, g.count - 1)
    : Array.from({ length: f.count }, (_, i) => Math.min(g.count - 1, Math.round(mapTime(anchors(updated.checks, original.checks), i / f.fps, f.duration, g.duration) * g.fps)))
  await $.process.run([unix('mkdir'), '-p', dir])
  const pair = { dir, count: f.count, fps: f.fps, duration: f.duration }
  await pairChunk($, pair, updated, original, i => match[i] ?? 0, 0)
  if (!(await exists($, frameFile(pair, 0)))) return null
  const size = await pngSize($, frameFile(pair, 0))
  const made = { pair, pairWidth: size.width, pairHeight: size.height, sync: turns(match, f.fps, g.fps) }
  await writeMeta($, dir, { ...made, pair: { count: pair.count, fps: pair.fps, duration: pair.duration } })

  return made
}

// One chunk of the merged clip, Original left and Updated right, made from
// the two sides' frames for that stretch (decoded first if they have to be).
function pairChunk($: EngineInterface, pair: Frames, updated: Shown, original: Shown, jOf: (i: number) => number, i: number): Promise<void> {
  const c = Math.floor(Math.max(0, Math.min(i, pair.count - 1)) / CHUNK)
  const key = `${pair.dir}#${c}`
  const running = decoding.get(key)
  if (running) return running
  const f = updated.frames!, g = original.frames!
  const job = (async () => {
    const first = c * CHUNK, n = Math.min(CHUNK, pair.count - first)
    if (await exists($, frameFile(pair, Math.max(0, Math.min(i, pair.count - 1))))) return
    const js = Array.from({ length: n }, (_, k) => Math.max(0, Math.min(g.count - 1, jOf(first + k))))
    await ensureChunk($, f, updated.source, first)
    for (const jc of new Set(js.map(j => Math.floor(j / CHUNK)))) await ensureChunk($, g, original.source, jc * CHUNK)
    const tmp = `${pair.dir}/c${c}`
    await $.process.run([unix('mkdir'), '-p', `${tmp}/o`, `${tmp}/u`])
    const links = js.map((j, k) => `ln -sf "${frameFile(g, j)}" "$0/o/f${String(k + 1).padStart(5, '0')}.png"; ln -sf "${frameFile(f, first + k)}" "$0/u/f${String(k + 1).padStart(5, '0')}.png"`).join('\n')
    await sh($, links, tmp)
    await $.process.run([
      ffmpeg, '-v', 'error', '-framerate', String(f.fps), '-i', `${tmp}/o/f%05d.png`, '-framerate', String(f.fps), '-i', `${tmp}/u/f%05d.png`,
      '-filter_complex', `[0:v]scale=-2:360,pad=iw+${PAIR_GAP}:ih:0:0:color=${SIDEBAR.replace('#', '0x')}[a];[1:v]scale=-2:360[b];[a][b]hstack=inputs=2`,
      '-frames:v', String(n), '-start_number', String(first + 1), '-compression_level', '1', `${pair.dir}/f%05d.png`,
    ])
    await $.process.run([unix('rm'), '-rf', tmp])
    await prune($, pair.dir, c)
  })().catch(() => undefined).finally(() => decoding.delete(key))
  decoding.set(key, job)
  return job
}

// The merged frame on screen, made if it has to be, the next chunk ahead.
async function pairReady($: EngineInterface, shown: Shown, i: number, site?: string): Promise<void> {
  const pair = shown.pair
  if (!pair || !shown.compare) return
  if (site) watch(pair.dir, site, i)
  const jOf = (k: number) => compareFrame(shown, k)
  await pairChunk($, pair, shown, shown.compare, jOf, i)
  if (i % CHUNK >= CHUNK / 2 && i + CHUNK < pair.count) void pairChunk($, pair, shown, shown.compare, jOf, i + CHUNK)
}

// Resolves a path to something the terminal can draw: a PNG (other image
// formats converted with macOS `sips`), or a video's frames.
async function prepare($: EngineInterface, raw: string, title?: string, key?: string): Promise<Shown> {
  const path = expand(raw, cwd, home)
  const stat = await $.fs.stat(path, { resolve: true })
  const real = slash(stat.realPath ?? path)
  const name = title ?? real.split('/').pop()!
  if (VIDEO.test(real)) return prepareVideo($, real, name, key ?? (await identityOf($, real)))
  let png = real
  if (!/\.png$/i.test(real)) {
    generation += 1
    png = `${TMP}/${real.split('/').pop()!.replace(/\.[^.]+$/, '')}-${generation}.png`
    await $.process.run([unix('mkdir'), '-p', TMP])
    if (isWin && !(await exists($, ffmpeg))) ffmpeg = (await whereIs($, 'ffmpeg')) || ffmpeg
    if (!isMac && !(await exists($, ffmpeg))) throw new Error(noFfmpeg(false))
    const conv = isMac
      ? await $.process.run(['sips', '-s', 'format', 'png', real, '--out', png])
      : await $.process.run([ffmpeg, '-v', 'error', '-y', '-i', real, '-frames:v', '1', png])
    if (conv.exitCode !== 0) throw new Error(`could not convert ${real}: ${conv.stderr.trim()}`)
  }
  // A picture travels as bytes, at most 2 MiB: shrink a big one.
  const size = await $.fs.stat(png)
  if ((size.size ?? 0) > 1_800_000) {
    generation += 1
    const small = `${TMP}/${png.split('/').pop()!.replace(/\.png$/i, '')}-${generation}-small.png`
    await $.process.run([unix('mkdir'), '-p', TMP])
    const shrunk = isMac
      ? await $.process.run(['sips', '-Z', '1800', png, '--out', small])
      : await $.process.run([ffmpeg, '-v', 'error', '-y', '-i', png, '-vf', "scale='if(gt(iw,ih),min(1800,iw),-2)':'if(gt(iw,ih),-2,min(1800,ih))'", small]).catch(() => ({ exitCode: 1 }))
    if (isMac || shrunk.exitCode === 0) png = small
  }
  generation += 1

  return { kind: 'image', path: png, source: real, ...(await pngSize($, png)), title: name, generation }
}

// A time is only worth a click when it points somewhere: a picture has no
// timeline, and a clip where every change sits at the same second isn't
// pointing anywhere either. Those rows are plain text.
export function timesThatMean(changes: KeyChange[] | undefined, isVideo: boolean): KeyChange[] | undefined {
  if (!changes) return changes
  const times = new Set(changes.filter(c => c.at !== undefined).map(c => c.at))
  const isPointing = isVideo && (times.size > 1 || (times.size === 1 && changes.length === 1))

  return isPointing ? changes : changes.map(({ at: _, ...c }) => c)
}

// The line a version is listed by: what changed in it.
export function noteOf(changes: KeyChange[] | undefined, change: string | undefined, title: string | undefined): string {
  const titles = (changes ?? []).map(c => c.title)
  return (titles.length ? titles.join(', ') : change ?? title ?? '').slice(0, 200)
}

// Earlier versions as given: paths or { path, note }, as an array or the
// same array sent as JSON text.
export function versionsOf(value: unknown): { path: string; note?: string }[] {
  if (typeof value === 'string') {
    const text = value
    try { value = JSON.parse(text) } catch { return text ? [{ path: text }] : [] }
  }
  if (!Array.isArray(value)) return []
  return value.flatMap(v =>
    typeof v === 'string' ? [{ path: v }]
      : v && typeof v === 'object' && typeof (v as { path?: unknown }).path === 'string'
        ? [{ path: (v as { path: string }).path, note: typeof (v as { note?: unknown }).note === 'string' ? (v as { note: string }).note : undefined }]
        : [])
}

// Every shown file is kept as a version, in .show-your-work/ inside the
// project (it ignores itself in git), so old rows keep their picture and the
// history survives restarts. Each version gets a short handle; a revision
// names its parent's handle as `previous`, so history is a chain of explicit
// links, like commits. No file names are matched: forget the link and there's
// no history, never a wrong one.
type Version = { id: string; parent?: string; note?: string; ext: string; title?: string; origin?: string }
export const handleOf = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/^#/, '').toLowerCase() : '') || undefined
let storeDir = ''
// The most a project's .show-your-work folder holds.
const STORE_CAP_KB = 200_000
async function storeOf($: EngineInterface): Promise<string> {
  if (storeDir) return storeDir
  for (const dir of [`${cwd || home}/.show-your-work`, `${TMP}/store`]) {
    const r = await sh($, 'mkdir -p "$0" && { [ -f "$0/.gitignore" ] || printf "*\\n" > "$0/.gitignore"; }', dir).catch(() => null)
    if (r && r.exitCode === 0) return (storeDir = dir)
  }
  return (storeDir = `${TMP}/store`)
}
async function readVersion($: EngineInterface, dir: string, id: string): Promise<Version | null> {
  if (!/^[0-9a-f]{4,12}$/.test(id)) return null
  const text = await readText($, `${dir}/${id}.json`)
  if (text === null) return null
  try { return JSON.parse(text) as Version } catch { return null }
}
async function storeVersion($: EngineInterface, raw: string, note: string, title: string | undefined, parent: string | undefined):
  Promise<{ real: string; copy: string; id: string; chain: { path: string; note?: string; id: string }[]; missing?: string }> {
  const real = slash((await $.fs.stat(expand(raw, cwd, home), { resolve: true })).realPath ?? expand(raw, cwd, home))
  const dir = await storeOf($)
  const ext = real.match(/\.[^./]+$/)?.[0] ?? ''
  generation += 1
  const id = keyOf(`${real}|${await $.clock.now()}|${generation}`).slice(0, 6)
  const meta: Version = { id, ...(parent ? { parent } : {}), note, ext, title, origin: real }
  const r = await sh($,
    'cp -c "$1" "$0/$2$3" 2>/dev/null || cp "$1" "$0/$2$3" || exit 1\n' +
    'printf "%s" "$4" > "$0/$2.json"\n' +
    // Pictures and videos alike: kept 7 days, at most the newest 50, and at
    // most 200 MB; the oldest go first, file and record together.
    'find "$0" -maxdepth 1 -name "*.json" -mtime +7 | while read f; do rm -f "${f%.json}".*; done\n' +
    'ls -t "$0"/*.json 2>/dev/null | tail -n +51 | while read f; do rm -f "${f%.json}".*; done\n' +
    'for f in $(ls -tr "$0"/*.json 2>/dev/null); do [ "$(du -sk "$0" | cut -f1)" -le "$5" ] && break; [ "$f" = "$0/$2.json" ] && break; rm -f "${f%.json}".*; done; true',
    dir, real, id, ext, JSON.stringify(meta), String(STORE_CAP_KB))
  if (r.exitCode !== 0) return { real, copy: real, id, chain: [] }
  // Follow the links back, oldest first.
  const chain: { path: string; note?: string; id: string }[] = []
  let at = parent, missing: string | undefined
  for (let n = 0; at && n < 30; n++) {
    const v = await readVersion($, dir, at)
    if (!v) { if (n === 0) missing = at; break }
    chain.unshift({ path: `${dir}/${v.id}${v.ext}`, note: v.note, id: v.id })
    at = v.parent
  }
  // A recording keeps only itself and the one before it: Original and
  // Updated, no deeper history, so re-recordings don't pile up.
  if (VIDEO.test(real) && chain.length > 1) {
    const older = chain.slice(0, -1)
    void $.process.run([unix('rm'), '-f', ...older.map(v => v.path)]).catch(() => undefined)
    chain.splice(0, chain.length - 1)
  }
  return { real, copy: `${dir}/${id}${ext}`, id, chain, missing }
}

// The tool's text result carries the shown item as `show-your-work:{json}`;
// the output may be that string or a list of text blocks.
// A tool result's text, whether it came as a string or as content blocks.
export function textOf(output: unknown): string {
  return typeof output === 'string'
    ? output
    : Array.isArray(output)
      ? output.map(b => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n')
      : ''
}
// What a show drew, kept out of Claude's context: the result carries only
// "show-your-work:#id", and the data waits here and in the store beside the copy.
const shownById = new Map<string, Shown>()
export const markOf = (output: unknown) => textOf(output).split('\n').find(l => l.startsWith(MARK))?.slice(MARK.length).trim()
async function shownOf($: EngineInterface, output: unknown): Promise<Shown | null> {
  const mark = markOf(output)
  if (!mark?.startsWith('#')) return parseShown(output)
  const id = mark.slice(1)
  if (!/^[0-9a-f]{4,12}$/.test(id)) return null
  const known = shownById.get(id)
  if (known) return known
  const text = await readText($, `${await storeOf($)}/${id}.shown`)
  if (text === null) return null
  try {
    const shown = JSON.parse(text) as Shown
    shownById.set(id, shown)
    return shown
  } catch {
    return null
  }
}
export function parseShown(output: unknown): Shown | null {
  const text = textOf(output)
  const line = text.split('\n').find(l => l.startsWith(MARK))
  if (!line) return null
  try {
    return JSON.parse(line.slice(line.indexOf(':') + 1)) as Shown
  } catch {
    return null
  }
}

// Fits the picture in a box of cells; a cell is about twice as tall as wide.
export function fit(width: number, height: number, maxCols: number, maxRows: number) {
  let columns = Math.max(1, Math.min(255, maxCols))
  let rows = Math.ceil((columns * height) / width / 2)
  if (rows > maxRows) {
    rows = maxRows
    columns = Math.max(1, Math.ceil((rows * 2 * width) / height))
  }

  return { columns: Math.min(255, columns), rows: Math.max(1, Math.min(255, rows)) }
}

// Sizes the picture to the room it has: between a minimum and a maximum
// width, never taller than its share of the screen, aspect kept.
export function sizeFor(width: number, height: number, room: number, rows: number, isPane: boolean) {
  const maxCols = Math.max(Math.min(room, 24), Math.min(room, isPane ? 220 : 120))
  const maxRows = isPane ? Math.max(6, rows - 12) : Math.max(8, Math.min(40, Math.floor(rows * 0.55)))

  return fit(width, height, maxCols, maxRows)
}

// Maps a frame of one clip to the frame at the same moment in another.
export function sameMoment(from: Frames | undefined, to: Frames | undefined, frame: number): number {
  if (!from || !to) return 0

  return Math.max(0, Math.min(to.count - 1, Math.round((frame / from.fps) * to.fps)))
}

// What a check did between the compared side and this one.
export function checkDiff(now: Check[] = [], before: Check[] = []) {
  const was = new Map(before.map(c => [c.name, c.ok]))
  const fixed = now.filter(c => c.ok && was.get(c.name) === false)
  const broken = now.filter(c => !c.ok && was.get(c.name) === true)

  return { fixed, broken }
}

// The play control's word for where the clip is.
export function playWord(isPlaying: boolean, frame: number, count: number) {
  if (isPlaying) return '❚❚ Pause'
  if (count > 1 && frame >= count - 1) return '↺ Replay'

  return frame > 0 ? '▶ Resume' : '▶ Play'
}

const sideOf = (shown: Shown, site: string): Shown =>
  player(site).isCompare && shown.compare ? shown.compare : shown

const plainAt = (media: Shown, frame: number) =>
  media.frames ? frameFile(media.frames, Math.min(frame, media.frames.count - 1)) : media.path


// The same moment on the other clip: updated → original seconds, and back.
const toOriginal = (shown: Shown, t: number) =>
  shown.frames && shown.compare?.frames
    ? mapTime(shown.sync ?? anchors(shown.checks, shown.compare.checks), t, shown.frames.duration, shown.compare.frames.duration)
    : t
const toUpdated = (shown: Shown, t: number) =>
  shown.frames && shown.compare?.frames
    ? mapTime((shown.sync ?? anchors(shown.checks, shown.compare.checks)).map(([a, b]) => [b, a] as [number, number]), t, shown.compare.frames.duration, shown.frames.duration)
    : t

// The compared side's frame at the moment the shown side is at.
const compareFrame = (shown: Shown, frame: number) => {
  const a = shown.frames, b = shown.compare?.frames
  if (!a || !b) return 0
  const t = mapTime(shown.sync ?? anchors(shown.checks, shown.compare?.checks), frame / a.fps, a.duration, b.duration)
  return Math.max(0, Math.min(b.count - 1, Math.round(t * b.fps)))
}

type Source = { png: string } | { file: string; format: 'png' }

// Bytes when the file reads; its path as a last resort.
// The terminal reads the file itself: a path crosses, not the picture. Sending
// bytes (b6b8b14) moved ~400 KB a frame and froze playback.
export function pngSource(_$: EngineInterface, file: string): Promise<Source> {
  return Promise.resolve({ file, format: 'png' as const })
}

// Whether the terminal draws pictures. Some sessions cannot (a background
// session's relay): the first blit says so, and from then on every player
// shows a warning with the way back instead. (Coloured half-block cells were
// tried as a fallback: unreadable.)
let canImage = true
let probed = false
let sessionId = ''

// What draws a picture: the Image's source.
type Pic = { src: Source }

async function picFor($: EngineInterface, file: string, _box: { columns: number; rows: number }): Promise<Pic> {
  return { src: await pngSource($, file) }
}

// After a first draw, asks whether the picture really drew; if the terminal
// can only show the alt text, switches every picture to cells.
function probe($: EngineInterface, site: string, key: string, pic: Pic) {
  if (!canImage || probed) return
  probed = true
  void $.clock.sleep(250).then(async () => {
    const r = await $.ui.blit({ requestId: site, key, source: pic.src })
    if (r.deny && /alt/i.test(r.deny)) {
      canImage = false
      drawCause = causeOf(inTmux, terminalName)
      track('cannot_draw', { cause: drawCause })
      $.ui.toast("Pictures can't show here: see the notice in the chat.")
      redraw($)
    }
  }, () => undefined)
}

async function blit($: EngineInterface, site: string, key: string, media: Shown, file: string, frame: number) {
  if (canImage) await $.ui.blit({ requestId: site, key, source: await pngSource($, file) })
}

function draw($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  if (one.isSplit && shown?.pair) {
    const at = Math.min(one.frame, shown.pair.count - 1), pair = shown.pair
    void pairReady($, shown, at, site).then(() => blit($, site, 'view-pair', shown, frameFile(pair, at), at)).catch(() => undefined)
    return
  }
  if (one.isSplit && shown?.compare) {
    const at = compareFrame(shown, one.frame), compare = shown.compare, frame = one.frame
    void frameReady($, compare, at, site).then(() => blit($, site, 'view-a', compare, plainAt(compare, at), at)).catch(() => undefined)
    void frameReady($, shown, frame, site).then(() => blit($, site, 'view-b', shown, plainAt(shown, frame), frame)).catch(() => undefined)
    return
  }
  const frame = one.frame
  void frameReady($, media, frame, site).then(() => blit($, site, 'view', media, plainAt(media, frame), frame)).catch(() => undefined)
}

// A side's checks in words: "4 checks fail" or "all 11 checks pass".
export function resultWords(checks: Check[] = []): string {
  const failing = checks.filter(c => !c.ok).length
  if (!checks.length) return ''
  return failing ? `${failing} ${failing === 1 ? 'check fails' : 'checks fail'}` : `all ${checks.length} checks pass`
}

// The latest check up to a moment whose result differs between the sides.
export function changeAt(shown: Shown, seconds: number): { check: Check; was: boolean } | null {
  const before = new Map((shown.compare?.checks ?? []).map(c => [c.name, c.ok]))
  const differing = (shown.checks ?? []).filter(c => c.at !== undefined && before.has(c.name) && before.get(c.name) !== c.ok && c.at <= seconds)
  const last = differing.at(-1)

  return last ? { check: last, was: before.get(last.name)! } : null
}

function stop($: EngineInterface, site: string) {
  const one = player(site)
  one.timer?.cancel()
  one.timer = undefined
  redraw($, site)
}

function play($: EngineInterface, site: string, media: Shown, shown?: Shown) {
  const one = player(site)
  const frames = media.frames
  if (one.timer || !frames) return
  // One video plays at a time: starting this one pauses the rest.
  for (const [other, p] of players) {
    if (other !== site && p.timer) {
      p.timer.cancel()
      p.timer = undefined
      versions.set(other, (versions.get(other) ?? 0) + 1)
    }
  }
  if (one.frame >= frames.count - 1) {
    one.frame = 0
    draw($, site, media, shown)
  }
  // The picture swaps every frame; the bar and the time redraw once a second,
  // or when the change on screen moves on. A redraw repaints every player
  // window in the chat, so it stays rare.
  const timed = inClipOrder(shown?.changes ?? [])
  const isOriginal = !!shown && media !== shown
  const marks = () => {
    const t = one.frame / frames.fps
    return `${Math.floor(t)}|${liveChange(timed, shown && isOriginal ? toUpdated(shown, t) : t, frames.fps)}`
  }
  let last = marks()
  one.timer = $.clock.every(Math.round(1000 / frames.fps), () => {
    if (one.frame >= frames.count - 1) return stop($, site)
    one.frame += 1
    draw($, site, media, shown)
    const now = marks()
    if (now !== last) {
      last = now
      redraw($, site)
    }
  })
  redraw($, site)
}

const toggle = ($: EngineInterface, site: string, media: Shown, shown?: Shown) =>
  player(site).timer ? stop($, site) : play($, site, media, shown)

function seek($: EngineInterface, site: string, media: Shown, seconds: number, shown?: Shown) {
  const frames = media.frames
  if (!frames) return
  player(site).frame = Math.max(0, Math.min(frames.count - 1, Math.round(seconds * frames.fps)))
  draw($, site, media, shown)
  redraw($, site)
}

function flip($: EngineInterface, site: string, shown: Shown, toCompare: boolean) {
  const one = player(site)
  if (!shown.compare || !!one.isCompare === toCompare) return
  const from = sideOf(shown, site)
  const wasPlaying = !!one.timer
  one.timer?.cancel()
  one.timer = undefined
  one.isCompare = toCompare
  const to = sideOf(shown, site)
  // Same moment on the other side, lined up on the steps both runs share.
  // Beside a still picture there's no moment to match: keep the video's place.
  if (toCompare) {
    one.updatedFrame = one.frame
    one.frame = compareFrame(shown, one.frame)
  } else if (from.frames && to.frames) {
    const t = toUpdated(shown, one.frame / from.frames.fps)
    one.frame = Math.max(0, Math.min(to.frames.count - 1, Math.round(t * to.frames.fps)))
  } else one.frame = one.updatedFrame ?? 0
  draw($, site, to)
  if (wasPlaying && to.frames) play($, site, to, shown)
  redraw($, site)
}

// Side by side: both sides at once, locked to the same moment, the shown
// side's clock driving both.
function split($: EngineInterface, site: string, shown: Shown, on: boolean) {
  const one = player(site)
  if (!shown.compare || (on && !shown.pair) || !!one.isSplit === on) return
  const wasPlaying = !!one.timer
  one.timer?.cancel()
  one.timer = undefined
  if (one.isCompare && shown.compare.frames && shown.frames)
    one.frame = Math.max(0, Math.min(shown.frames.count - 1, Math.round(toUpdated(shown, one.frame / shown.compare.frames.fps) * shown.frames.fps)))
  one.isCompare = false
  one.isSplit = on
  if (wasPlaying) play($, site, shown, shown)
  redraw($, site)
}

type Ui = any
type Box = { columns: number; rows: number }

// The picture.
function Picture(ui: Ui, $: EngineInterface, site: string, shown: Shown, media: Shown, box: Box, pic: Pic) {
  const { Text, Image } = ui
  if (!Image) return <Text dimColor>This surface cannot draw images.</Text>

  // The picture stands alone: no wrapper, nothing laid over it and no fill
  // behind it. Each of those kept the picture from drawing in Ghostty.
  return (
    <Image
      key="view"
      source={pic.src}
      columns={box.columns}
      rows={box.rows}
      alt={`[${media.kind ?? 'image'}: ${shown.title}]`}
    />
  )
}

// The scrub row: the play control, elapsed, a clickable bar, total — exactly
// as wide as the picture.
function Scrub(ui: Ui, $: EngineInterface, site: string, media: Shown, width: number, shown?: Shown) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const frames = media.frames!
  const word = playWord(!!one.timer, one.frame, frames.count)
  const elapsed = clock(one.frame >= frames.count - 1 ? frames.duration : one.frame / frames.fps)
  const total = clock(frames.duration)
  const segments = Math.max(6, width - (word.length + 4) - elapsed.length - total.length - 4)
  const playhead = Math.min(segments - 1, Math.round((one.frame / Math.max(1, frames.count - 1)) * (segments - 1)))
  one.segments = segments

  // ~20 wide buttons, each a stretch you can jump to, playing or paused: the
  // bar redraws once a second, so the buttons cost little.
  const chunks = barChunks(segments, playhead)

  return (
    <Box flexDirection="row" flexWrap="nowrap" width={width}>
      <Button key="play" variant="primary" label={word} onPress={() => { act(word.includes('Pause') ? 'pause' : 'play'); toggle($, site, media, shown) }} />
      <Text dimColor> {elapsed} </Text>
      {chunks.map((c, i) => (
        <Button
          key={`seek-${i}`}
          plain
          dimColor={c.isAhead}
          label={c.label}
          onPress={() => { act('scrub'); seek($, site, media, (Math.round((c.start / Math.max(1, segments - 1)) * (frames.count - 1)) + 0.5) / frames.fps, shown) }}
        />
      ))}
      <Text dimColor> {total}</Text>
    </Box>
  )
}

// Splits the bar's cells into ~20 stretches: played cells '━', the playhead
// '●', the rest '─'; a stretch is dim once it lies ahead.
export function barChunks(segments: number, playhead: number, count = 20) {
  const size = Math.max(1, Math.ceil(segments / count))
  const chunks: { start: number; label: string; isAhead: boolean }[] = []
  for (let start = 0; start < segments; start += size) {
    let label = ''
    for (let i = start; i < Math.min(segments, start + size); i++) {
      label += i === playhead ? '●' : i < playhead ? '━' : '─'
    }
    chunks.push({ start, label, isAhead: start > playhead })
  }

  return chunks
}

// Original / Updated / Compare (side by side): the view shown is the accent button.
// The compared side when it is one of several earlier versions: the one
// before by default, with ‹ › to step further back. Versions are numbered
// from the first one shown, so the updated side is the highest.
export function atStep(shown: Shown, site: string): Shown {
  const step = player(site).step
  const picked = step === undefined ? undefined : prepared.get(shown.history?.[step]?.path ?? '')
  return picked ? { ...shown, compare: picked } : shown
}

// Kept copies never change, so each is read once, when first stepped to.
const prepared = new Map<string, Shown>()
async function preparedOf($: EngineInterface, path: string): Promise<Shown> {
  const known = prepared.get(path)
  if (known) return known
  const made = await prepare($, path, 'Original')
  remember(path, made)
  return made
}
// Entries are a path and a size, not pixels; the oldest go past 200.
function remember(path: string, made: Shown) {
  prepared.set(path, made)
  if (prepared.size > 200) prepared.delete(prepared.keys().next().value!)
}

// Puts an earlier version on the original side, read the first time it is
// picked; the newest entry is the updated side itself.
function pickVersion($: EngineInterface, site: string, shown: Shown, to: number) {
  const history = shown.history!
  const one = player(site)
  if (one.isSplit) split($, site, shown, false)
  const picked = history[to]
  if (!picked) return flip($, site, shown, false)
  void preparedOf($, picked.path).then(version => {
    one.step = to
    if (!one.isCompare) flip($, site, { ...shown, compare: version }, true)
    else draw($, site, version)
    redraw($, site)
  }).catch(() => $.ui.toast('That version is gone'))
}

// With history, which version is on screen, in words: "viewing v1 of 3".
function viewingLabel(shown: Shown, site: string): string {
  const history = shown.history
  const one = player(site)
  if (!history || history.length < 2 || !one.isHistory) return ''
  const total = history.length + 1
  const at = one.isCompare ? (one.step ?? shown.historyAt ?? history.length - 1) + 1 : total
  return at === total ? `· latest, v${total}` : `· viewing v${at} of ${total}`
}

// A tab name short enough that every tab fits on one line and stays clickable.
export const tabLabel = (text: string, max = 12) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text)

function Tabs(ui: Ui, $: EngineInterface, site: string, shown: Shown) {
  const { Box, Button } = ui
  if (!shown.compare) return null
  const one = player(site)
  // Original, Updated, Compare and History are separate views: one is lit.
  const isHistory = !!one.isHistory
  const isBoth = !isHistory && !!one.isSplit
  const isCompare = !isHistory && !isBoth && !!one.isCompare
  const isUpdated = !isHistory && !isBoth && !isCompare
  const canBoth = !!(shown.frames && shown.pair)
  const hasSteps = (shown.history?.length ?? 0) > 1
  // Original is always the version before; leaving History puts it back.
  const restore = (toCompare: boolean) => {
    const wasStepped = one.step !== undefined && one.step !== shown.historyAt
    one.isHistory = false
    one.step = undefined
    if (one.isSplit) split($, site, shown, false)
    if (wasStepped && one.isCompare) {
      one.isCompare = false
      if (toCompare) flip($, site, shown, true)
      else draw($, site, shown)
    } else flip($, site, shown, toCompare)
    redraw($, site)
  }

  return (
    <Box flexDirection="row" gap={1}>
      <Button key="side-before" variant={isCompare ? 'primary' : 'secondary'} label={tabLabel(shown.compare.label ?? 'Original')} onPress={() => { act('original'); restore(true) }} />
      <Button key="side-after" variant={isUpdated ? 'primary' : 'secondary'} label={tabLabel(shown.label ?? 'Updated')} onPress={() => { act('updated'); restore(false) }} />
      {canBoth && <Button key="side-both" variant={isBoth ? 'primary' : 'secondary'} label="⧉ Compare" onPress={() => { act('compare'); restore(false); split($, site, shown, true) }} />}
      {hasSteps && (
        <Button key="history" variant={isHistory ? 'primary' : 'secondary'} label={`History · ${shown.history!.length + 1}`}
          onPress={() => { if (isHistory) return restore(false); act('history'); one.isHistory = true; one.changesPage = 0; redraw($, site) }} />
      )}
    </Box>
  )
}

// The QA report beside the picture: the change, its PR, the checks and what
// flipped against the compared side.
// What was fixed or broke; each row jumps to its moment.
function Changes(ui: Ui, $: EngineInterface, site: string, shown: Shown, fixed: Check[], broken: Check[]) {
  const { Box, Button } = ui
  const media = sideOf(shown, site)
  const row = (c: Check, word: string) => (
    <Button
      key={`${word}-${c.name}`}
      plain
      label={`${c.at !== undefined ? clock(c.at) + ' ' : ''}${word} · ${c.name}`}
      onPress={() => { if (c.at === undefined) return; act('check_jump'); seek($, site, media, c.at, shown) }}
    />
  )

  return (
    <Box flexDirection="column">
      {fixed.map(c => row(c, '✓ fixed'))}
      {broken.map(c => row(c, '✗ broke'))}
    </Box>
  )
}

// The QA line on top: how many checks passed, from the summary or the checks.
export function qaTotals(summary: Summary[] = [], checks: Check[] = []) {
  if (summary.some(s => s.total !== undefined)) {
    const total = summary.reduce((n, s) => n + (s.total ?? 0), 0)
    const passed = summary.reduce((n, s) => n + (s.passed ?? (s.ok ? s.total ?? 0 : 0)), 0)
    return { passed, total }
  }

  return { passed: checks.filter(c => c.ok).length, total: checks.length }
}

const PILL = '#30323b'
// The sidebar's top bar, a step lighter than the sidebar.
const TOPBAR = '#272930'
// Room for a change's title and a QA line, in a column this wide.
const titleWidth = (column: number) => column - 4 /* "12. " */ - 1 - 6 /* " 0:07 " */
const labelWidth = (column: number) => column - 4 /* card border + padding */ - 2 /* "✓ " */ - 5 /* " 11/11" */
// Under the player, what changed and the QA sit side by side from this width.
const TWO_COLUMNS = 72

// Rows the sidebar spends on everything but the change rows.
export function changesThatFit(height: number, summaryRows: number, hasPr: boolean, hasCompare: boolean) {
  const qa = summaryRows >= 0 ? 1 /* gap */ + 1 /* label */ + 2 /* card border */ + 1 /* verdict */ + summaryRows : 0
  const fixed = 2 /* padding */ + (hasCompare ? 3 : 0) /* top bar */ + 1 /* label */ + qa + (hasPr ? 2 : 0)
  return Math.max(1, height - fixed)
}

// The change on screen now: the last one whose moment has come, allowing for
// a seek landing up to half a frame early.
export function liveChange(changes: KeyChange[], now: number, fps: number): number {
  return changes.reduce((hit, c, i) => (c.at !== undefined && c.at <= now + 0.5 / fps ? i : hit), -1)
}

// Changes in the order they show in the clip; ones without a time keep
// their place after the timed ones.
export function inClipOrder(changes: KeyChange[]): KeyChange[] {
  return changes.map((c, i) => ({ c, i })).sort((a, b) => (a.c.at ?? Infinity) - (b.c.at ?? Infinity) || a.i - b.i).map(x => x.c)
}

// Words wrapped to lines of at most width, so the whole text is always shown.
export function wrapWords(text: string, width: number): string[] {
  width = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let w = word; w; ) {
      const piece = w.length > width ? w.slice(0, width) : w
      w = w.slice(piece.length)
      if (!line) line = piece
      else if (line.length + 1 + piece.length <= width) line += ' ' + piece
      else {
        lines.push(line)
        line = piece
      }
    }
  }
  return lines.length || line ? [...lines, line].filter(Boolean) : ['']
}

// Splits wrapped items into pages that each fit rows; an item never splits.
export function pagesOf<T>(items: { item: T; rows: number }[], rows: number): T[][] {
  const pages: T[][] = [[]]
  let used = 0
  for (const { item, rows: need } of items) {
    if (used + need > rows && pages.at(-1)!.length) {
      pages.push([])
      used = 0
    }
    pages.at(-1)!.push(item)
    used += need
  }
  return pages
}

// The report: the Original / Updated / Compare switch in a top bar, what changed
// (each one jumps to its moment; the one playing now is lit), the QA in a
// card, then the PR. Text wraps; nothing is cut. Beside the player it is a
// sidebar exactly as tall as the player, paging what doesn't fit; under it (a
// narrow window) it spans the player's width, in two columns when there's room.
function Report(ui: Ui, $: EngineInterface, site: string, shown: Shown, prLink: Ui, at: { width: number; height?: number }) {
  const { Box, Text, Button } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const { width, height } = at
  const isBeside = height !== undefined
  const isTwo = !isBeside && width - 4 >= TWO_COLUMNS
  const column = isTwo ? Math.floor((width - 4 - 3) / 2) : width - 4
  const TITLE = titleWidth(column), LABEL = labelWidth(column)
  const changes = inClipOrder(shown.changes?.length ? shown.changes : shown.change ? [{ title: shown.change }] : [])
  // The summary is the updated side's; on the original, its own checks count.
  const summary = (media === shown ? shown.summary ?? [] : []).slice(0, 3).map(s => ({ ...s, lines: wrapWords(s.label, LABEL) }))
  const { passed, total } = qaTotals(summary, media.checks)
  const allPass = total > 0 && passed === total
  const summaryRows = summary.reduce((n, s) => n + s.lines.length, 0)
  const room = isBeside ? changesThatFit(height, total > 0 ? summaryRows : -1, !!prLink, !!shown.compare) : Infinity
  const wrapped = changes.map((c, n) => ({ c, n, lines: wrapWords(c.title, TITLE) }))
  const pages = pagesOf(wrapped.map((w, i) => ({ item: w, rows: w.lines.length + (i ? 1 : 0) })), room)
  const page = Math.min(one.changesPage ?? 0, pages.length - 1)
  // Changes are timed on the updated clip; on the original, map the clock.
  const onOriginal = media !== shown
  const now = media.frames ? (onOriginal ? toUpdated(shown, one.frame / media.frames.fps) : one.frame / media.frames.fps) : -1
  const live = liveChange(changes, now, media.frames?.fps ?? 12)
  const label = (text: string, right?: Ui) => (
    <Box flexDirection="row" justifyContent="space-between">
      <Text dimColor bold>{text}</Text>
      {right}
    </Box>
  )

  const changed = (
    <Box flexDirection="column" width={column}>
      {label(
        `${(shown.changesTitle || 'What changed').toUpperCase()} · ${changes.length}`,
        pages.length > 1 ? (
          <Button
            key="changes-more"
            plain
            dimColor
            label={`${page + 1}/${pages.length} ${page === pages.length - 1 ? '↑' : '↓'}`}
            onPress={() => {
              one.changesPage = (page + 1) % pages.length
              redraw($, site)
            }}
          />
        ) : undefined,
      )}
      {(pages[page] ?? []).map(({ c, n, lines }, k) => {
        const isLive = n === live
        const jump = () => { if (c.at === undefined) return; act('change_jump'); seek($, site, media, onOriginal ? toOriginal(shown, c.at) : c.at, shown) }
        return (
          <Box key={`change-${n}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isLive ? 'suggestion' : undefined} dimColor={!isLive}>{`${n + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={TITLE}>
              {lines.map((line, i) =>
                c.at !== undefined
                  ? <Button key={`change-${n}-${i}`} plain label={line} hover={{ inverse: true }} onPress={jump} />
                  : <Text key={`change-${n}-${i}`}>{line}</Text>,
              )}
            </Box>
            {c.at !== undefined && (
              <Text backgroundColor={isLive ? 'suggestion' : PILL} color={isLive ? 'inverseText' : undefined}>
                {` ${clock(c.at)} `}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
  // The versions, newest first, each by what changed in it; the one on the
  // original side is lit, and a click puts another there.
  const history = one.isHistory ? shown.history : undefined
  const onSide = one.isCompare ? one.step ?? shown.historyAt ?? (history?.length ?? 1) - 1 : (history?.length ?? 0)
  const versions = history ? [...history, { path: '', note: shown.note }].map((v, i) => ({ v, i })).reverse() : []
  const listed = versions.map(({ v, i }) => ({ i, lines: wrapWords(v.note || (i === history!.length ? 'This version' : `Shown earlier`), TITLE) }))
  const versionPages = pagesOf(listed.map((w, k) => ({ item: w, rows: w.lines.length + (k ? 1 : 0) })), room)
  const versionPage = Math.min(one.changesPage ?? 0, versionPages.length - 1)
  const versionList = history && (
    <Box flexDirection="column" width={column}>
      {label(
        `VERSIONS · ${versions.length}`,
        versionPages.length > 1 ? (
          <Button key="versions-more" plain dimColor label={`${versionPage + 1}/${versionPages.length} ${versionPage === versionPages.length - 1 ? '↑' : '↓'}`}
            onPress={() => { one.changesPage = (versionPage + 1) % versionPages.length; redraw($, site) }} />
        ) : undefined,
      )}
      {(versionPages[versionPage] ?? []).map(({ i, lines }, k) => {
        const isOn = i === onSide
        const isLatest = i === history.length
        return (
          <Box key={`version-${i}`} flexDirection="row" gap={1} marginTop={k ? 1 : 0}>
            <Text color={isOn ? 'suggestion' : undefined} dimColor={!isOn}>{`${i + 1}.`.padStart(3)}</Text>
            <Box flexDirection="column" width={TITLE}>
              {lines.map((line, j) => (
                <Button key={`version-${i}-${j}`} plain label={line} hover={{ inverse: true }} onPress={() => { act('version_pick'); pickVersion($, site, shown, i) }} />
              ))}
            </Box>
            {(isOn || isLatest) && (
              <Text backgroundColor={isOn ? 'suggestion' : PILL} color={isOn ? 'inverseText' : undefined}>
                {isOn ? ' viewing ' : ' latest '}
              </Text>
            )}
          </Box>
        )
      })}
    </Box>
  )
  const qa = total > 0 && (
    <Box flexDirection="column" width={column} marginTop={isTwo ? 0 : 1}>
      {label('QA', <Text bold color={allPass ? 'success' : 'error'}>{passed}/{total}</Text>)}
      <Box flexDirection="column" borderStyle="round" borderColor={allPass ? 'success' : 'error'} borderDimColor paddingX={1}>
        <Text bold color={allPass ? 'success' : 'error'}>
          {allPass ? '✓ All checks passed' : `✗ ${total - passed} of ${total} checks failed`}
        </Text>
        {summary.map(s => (
          <Box key={`sum-${s.label}`} flexDirection="row" gap={1}>
            <Text color={s.ok ? 'success' : 'error'}>{s.ok ? '✓' : '✗'}</Text>
            <Box flexDirection="column" width={LABEL}>
              {s.lines.map((line, i) => <Text key={`sum-${s.label}-${i}`}>{line}</Text>)}
            </Box>
            {s.total !== undefined && <Text dimColor>{`${s.passed ?? (s.ok ? s.total : 0)}/${s.total}`.padStart(5)}</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" backgroundColor={SIDEBAR}>
      {shown.compare && (
        <Box width={width} backgroundColor={TOPBAR} paddingX={2} paddingY={1}>
          {Tabs(ui, $, site, shown)}
        </Box>
      )}
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {versionList || (
          <Box flexDirection="column">
            {changes.length > 0 && (isTwo ? <Box flexDirection="row" gap={3}>{changed}{qa}</Box> : changed)}
            {(!isTwo || !changes.length) && qa}
          </Box>
        )}
        {prLink && <Box flexDirection="row" gap={1} marginTop={1}><Text dimColor>PR</Text>{prLink}</Box>}
      </Box>
    </Box>
  )
}

// Scratch output lives in temp folders; finished work lives somewhere real.
export const isScratch = (path: string) => /^\/(private\/)?(tmp|var\/folders)\//.test(path)

// What you do with the file: watch it properly, keep it (or find it), or
// paste its path elsewhere.
function Actions(ui: Ui, $: EngineInterface, media: Shown, source: string, isNarrow: boolean) {
  const { Box, Button } = ui
  const done = (r: { exitCode: number; stderr: string }, note: string) =>
    $.ui.toast(r.exitCode === 0 ? note : `Could not: ${r.stderr.trim().slice(0, 120)}`)
  const name = source.split('/').pop()!
  const keep = async () => {
    // A free name: "clip.mp4", then "clip 2.mp4", "clip 3.mp4"…
    const dot = name.lastIndexOf('.')
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
    let out = `${home}/Downloads/${name}`
    for (let n = 2; await $.fs.stat(out).then(() => true, () => false); n++) out = `${home}/Downloads/${stem} ${n}${ext}`
    if (!isMac) await $.process.run([unix('mkdir'), '-p', `${home}/Downloads`])
    const r = await $.process.run([unix('cp'), source, out])
    if (r.exitCode === 0) await (isMac || isWin ? reveal($, out) : $.process.run(['xdg-open', `${home}/Downloads`])).catch(() => undefined)
    done(r, `Saved to Downloads/${out.split('/').pop()}`)
  }

  return (
    <Box flexDirection="row" gap={2}>
      {!source.startsWith(`${home}/Downloads/`) ? (
        <Button key="keep" plain dimColor label="Save to Downloads" onPress={() => { act('save'); void keep() }} />
      ) : (
        <Button key="reveal" plain dimColor label={isMac ? 'Show in Finder' : 'Show in folder'} onPress={() => act('reveal') || void reveal($, source).then(r => done(r, isMac ? 'Shown in Finder' : 'Opened the folder'))} />
      )}
      {!isNarrow && (
        <Button
          key="copy"
          plain
          dimColor
          label="Copy path"
          onPress={(press: { surface: 'terminal' }) =>
            act('copy_path') || void $.ui.copy({ text: source, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path'))
          }
        />
      )}
    </Box>
  )
}

// The page the moment shows: the latest check's url up to now, else the item's.
export function urlAt(shown: Shown, seconds: number): string | undefined {
  const hit = (shown.checks ?? []).filter(c => c.url && (c.at ?? 0) <= seconds).at(-1)

  return hit?.url ?? shown.url
}

// Shown while pictures are drawn as cells: why, and the way back to full quality.
// Resumes this chat outside the background service, so pictures draw again.
// PowerShell sets a variable for the command after it its own way.
export const resumeCommand = (id: string, win = isWin) =>
  `${win ? '$env:CLAUDE_CODE_DISABLE_AGENT_VIEW=1; ' : 'CLAUDE_CODE_DISABLE_AGENT_VIEW=1 '}claude --resume${id ? ' ' + id : ''}`

// Why pictures can't draw here, once a draw has failed: tmux blocking them,
// a terminal without picture support, or a background session.
export type DrawCause = 'tmux' | 'terminal' | 'background'
let drawCause: DrawCause = 'background'
let inTmux = false
let terminalName = ''
export const causeOf = (tmux: boolean, terminal: string): DrawCause =>
  tmux ? 'tmux' : /^(ghostty|kitty)$/.test(terminal) ? 'background' : 'terminal'

// The notice for a picture that couldn't draw, and the line Claude reads.
export function cantDraw(cause: DrawCause, name: string, kind: 'picture' | 'video', id: string) {
  const what = kind === 'video' ? 'videos' : 'pictures'
  if (cause === 'tmux') return {
    title: `tmux is blocking ${what}`,
    text: `"${name}" is ready, but tmux stops ${what} from reaching the terminal. Add this line to ~/.tmux.conf, reload tmux, and ask Claude to show it again. Or open this chat outside tmux.`,
    command: 'set -g allow-passthrough on', label: 'Copy setting', action: 'copy_tmux_setting',
    claude: `tmux is blocking pictures, so the person saw a notice instead of ${name}. They can add "set -g allow-passthrough on" to ~/.tmux.conf or open the chat outside tmux.`,
  }
  // On Windows the terminal that draws them is Rio, set up as the README says.
  const drawing = isWin ? 'Rio set up for pictures' : 'Ghostty'
  if (cause === 'terminal') return {
    title: `This terminal can't show ${what}`,
    text: `"${name}" is ready, but this terminal can't draw ${what}. Open this chat in ${drawing} to see it:`,
    command: `claude --resume${id ? ' ' + id : ''}`, label: 'Copy command', action: 'copy_resume_command',
    claude: `this terminal can't draw pictures, so the person saw a notice instead of ${name}. They need ${drawing} to see it.`,
  }
  return {
    title: `Can't show ${what} in a background session`,
    text: `"${name}" is ready, but this chat is running as a background session, and those can't draw ${what} in the terminal. Resume it in a normal ${isWin ? 'Rio' : 'Ghostty'} tab to see it:`,
    command: resumeCommand(id), label: 'Copy command', action: 'copy_resume_command',
    claude: `this chat runs as a background session, which can't draw pictures, so the person saw a notice instead of ${name}. They can resume the chat in a normal terminal tab to see it.`,
  }
}

function Warning(ui: Ui, $: EngineInterface, site: string, shown: Shown, width: number) {
  const n = cantDraw(drawCause, shown.title, shown.frames ? 'video' : 'picture', sessionId)
  return NoticeBox(ui, $, width, { ...n, copy: n.command })
}

// The file behind a preview is gone (temp cleared, cache trimmed, or the
// original moved): say so in place of a blank box, with a prompt to paste.
export function expiredPrompt(shown: Shown): string {
  const file = shown.origin ?? shown.source ?? shown.path
  const kind = shown.frames ? 'video' : 'image'
  return `The ${kind} preview "${shown.title}" expired (${file} is gone). Please regenerate it and show it to me again with show_${kind}` +
    (shown.compare ? ', with the same compare' : '') + (shown.changes?.length ? ' and the same list of changes' : '') + '.'
}
function Expired(ui: Ui, $: EngineInterface, shown: Shown, width: number) {
  return NoticeBox(ui, $, width, {
    title: 'This preview has expired',
    text: `"${shown.title}" was cleared from the preview cache, and its file is no longer there. Copy the prompt and paste it to Claude to send it again.`,
    copy: expiredPrompt(shown), label: 'Copy prompt', action: 'copy_expired_prompt',
  })
}

// A failure, drawn in place of the picture: what happened, in plain words,
// and one button that copies what to paste back (a prompt, or a command).
function NoticeBox(ui: Ui, $: EngineInterface, width: number, n: { title: string; text: string; command?: string; copy: string; label: string; action: string }) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={2} paddingY={1} width={Math.max(40, Math.min(width, 96))}>
      <Text bold color="warning">⚠ {n.title}</Text>
      <Text wrap="wrap">{'\n'}{n.text}</Text>
      {n.command ? <Box marginTop={1}><Text bold>{n.command}</Text></Box> : null}
      <Box flexDirection="row" gap={2} marginTop={1}>
        <Button
          key={n.action}
          variant="primary"
          label={n.label}
          onPress={(press: { surface: 'terminal' }) =>
            act(n.action) || void $.ui.copy({ text: n.copy, surface: press.surface }).then(r => $.ui.toast(r.isCopied ? (n.command ? 'Copied. Paste it in your terminal.' : 'Copied. Paste it to Claude.') : 'Could not copy'))
          }
        />
      </Box>
    </Box>
  )
}

// The player: concept A (picture, scrub row, controls) everywhere; concept B
// (A plus the QA report at its side) when there is a report and room for it.
async function Viewer(
  $: EngineInterface,
  e: Parameters<EngineInterface['ui']['resolve']>[0],
  shown: Shown,
  site: string,
  isPane: boolean,
  viewport: { columns: number; rows: number } | undefined,
) {
  const ui = $.ui.resolve(e) as Ui
  const { Box, Text, Button, Link } = ui
  const one = player(site)
  const media = sideOf(shown, site)
  const frames = media.frames
  const source = media.origin ?? media.source ?? media.path
  const columns = viewport?.columns ?? 100
  const hasReport = !!(shown.change || shown.changes?.length || shown.summary?.length || shown.checks?.length || (one.isHistory && shown.history))
  const isWide = hasReport && columns - 8 >= WIDE_ENOUGH
  const room = columns - (isPane ? 6 : 10) - (isWide ? SIDE + 3 : 0)
  const box = sizeFor(media.width, media.height, room, viewport?.rows ?? 40, isPane)
  const isNarrow = box.columns < 60
  // Under the player the report takes at least a readable width, even beside a tall, thin picture.
  const below = hasReport && !isWide ? Math.max(box.columns, Math.min(columns - (isPane ? 6 : 10), 72)) : box.columns
  const checks = media.checks ?? []
  const passed = checks.filter(c => c.ok).length
  const prNumber = shown.pr?.match(/\/pull\/(\d+)/)?.[1]
  const prLabel = prNumber ? `PR #${prNumber}` : shown.pr
  const prLink = shown.pr
    ? /^https?:\/\//.test(shown.pr)
      ? <Link href={shown.pr} label={prLabel} />
      : <Text color="suggestion">{prLabel}</Text>
    : null
  const run = (argv: string[], note: string) => () => {
    void $.process.run(argv).then(r => $.ui.toast(r.exitCode === 0 ? note : `Could not: ${r.stderr.trim()}`))
  }
  // A video the agent shows starts playing by itself, once.
  if (frames && !isPane && !one.hasAutoplayed && freshCalls.has(site)) {
    one.hasAutoplayed = true
    void $.clock.sleep(400).then(() => play($, site, media, shown), () => undefined)
  }

  // The single view with the QA sidebar is the default; side by side is a click away.
  if (!canImage) {
    one.timer?.cancel()
    one.timer = undefined
    return Warning(ui, $, site, shown, columns - 8)
  }
  one.box = { columns: box.columns, rows: box.rows }
  await frameReady($, media, one.frame, site)
  if (await isGone($, plainAt(media, one.frame))) {
    one.timer?.cancel()
    one.timer = undefined
    return Expired(ui, $, shown, columns - 8)
  }
  const pic = await picFor($, plainAt(media, one.frame), box)
  probe($, site, 'view', pic)
  if (one.isSplit && shown.pair && frames) return SplitView(ui, $, site, shown, columns, viewport?.rows ?? 40, isPane, prLink)

  const actions = Actions(ui, $, media, source, isNarrow)
  // The top corner opens it: the page it shows, else the file itself.
  const page = urlAt(media, frames ? one.frame / frames.fps : 0) ?? (/\.html?$/i.test(source) ? source : undefined)
  const opener = (
    <Button
      key="page"
      plain
      label={page ? '↗ Open page' : '↗ View'}
      onPress={() =>
        act(page ? 'open_page' : 'open_file') || void $.process.run(openArgv(page ?? source)).then(r =>
          $.ui.toast(r.exitCode === 0 ? `Opened ${(page ?? source.split('/').pop()!).slice(0, 60)}` : 'Could not open it'),
        )
      }
    />
  )

  // A tall, narrow picture still gets control rows wide enough to read on one
  // line each; the picture sits centred above them.
  // ...but never wider than the window has room for.
  const controlsMin = Math.min(CONTROLS_MIN, columns - 8)
  const rowWidth = Math.max(box.columns, controlsMin)
  const stage = (
    <Box flexDirection="column" width={rowWidth} alignItems="center">
      {Picture(ui, $, site, shown, media, box, pic)}
      {frames && Scrub(ui, $, site, media, rowWidth, shown)}
      <Box flexDirection="row" justifyContent="space-between" columnGap={2} flexWrap="wrap" width={rowWidth}>
        <Box flexDirection="row" columnGap={2}>
          {frames && <Button key="back" plain dimColor label="« 5s" onPress={() => act('skip_back') || seek($, site, media, one.frame / frames.fps - 5, shown)} />}
          {frames && <Button key="forward" plain dimColor label="5s »" onPress={() => act('skip_forward') || seek($, site, media, one.frame / frames.fps + 5, shown)} />}
          {!isWide && !hasReport && Tabs(ui, $, site, shown)}
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {opener}
          {actions}
        </Box>
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={(isWide ? Math.max(box.columns, controlsMin) + SIDE + 3 : Math.max(box.columns, controlsMin, below)) + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={2} flexShrink={1}>
          <Text bold wrap="truncate-end">{shown.title}</Text>
          {viewingLabel(shown, site) && <Text color="suggestion" wrap="truncate-end">{viewingLabel(shown, site)}</Text>}
          {checks.length > 0 && (
            <Text bold color={passed === checks.length ? 'success' : 'error'}>
              {passed === checks.length ? '✓' : '✗'} {passed}/{checks.length}
            </Text>
          )}
        </Box>
        <Text dimColor>{frames ? `${media.width}×${media.height} · ${clock(frames.duration)}` : `${media.width}×${media.height}`}</Text>
      </Box>
      {!hasReport && prLink && (
        <Box flexDirection="row" gap={2}>
          {prLink}
          {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
        </Box>
      )}
      <Box flexDirection="row" gap={3} marginTop={1}>
        {stage}
        {isWide && Report(ui, $, site, shown, prLink, { width: SIDE, height: box.rows + (frames ? 3 : 2) })}
      </Box>
      {!isWide && hasReport && <Box marginTop={1}>{Report(ui, $, site, shown, prLink, { width: below })}</Box>}
    </Box>
  )
}

// Both sides at once: names and scores over each, the change at this moment
// spelled out under them, one scrub row, and the list of changes.
async function SplitView(
  ui: Ui,
  $: EngineInterface,
  site: string,
  shown: Shown,
  columns: number,
  rows: number,
  isPane: boolean,
  prLink: Ui,
) {
  const { Box, Text, Image, Button } = ui
  const one = player(site)
  const before = shown.compare!
  const pair = shown.pair!
  // One merged clip, Original left and Updated right: one picture per frame.
  const box = sizeFor(shown.pairWidth ?? shown.width * 2, shown.pairHeight ?? shown.height, columns - (isPane ? 6 : 10), rows, isPane)
  const width = box.columns
  // The Updated side starts past the Original side and the gap between them.
  const pairPx = shown.pairWidth ?? shown.width * 2
  const half = Math.round((width * ((pairPx - PAIR_GAP) / 2 + PAIR_GAP)) / pairPx)
  const seconds = one.frame / shown.frames!.fps
  const change = changeAt(shown, seconds)
  const { fixed, broken } = checkDiff(shown.checks, before.checks)
  one.box = { columns: box.columns, rows: box.rows }
  await pairReady($, shown, Math.min(one.frame, pair.count - 1), site)
  const pic = await picFor($, frameFile(pair, Math.min(one.frame, pair.count - 1)), box)
  probe($, site, 'view-pair', pic)
  const head = (s: Shown, fallback: string, w: number) => {
    const words = resultWords(s.checks)
    const ok = (s.checks ?? []).every(c => c.ok)
    return (
      <Box width={w} flexDirection="row" gap={1}>
        <Text bold>{s.label ?? fallback}</Text>
        {words && <Text color={ok ? 'success' : 'error'}>· {words}</Text>}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} width={width + 4}>
      <Box flexDirection="row" justifyContent="space-between" gap={2} width={width}>
        <Text bold wrap="truncate-end">{shown.title}</Text>
        <Box flexDirection="row" gap={2}>
          {prLink}
          {Tabs(ui, $, site, shown)}
        </Box>
      </Box>
      {shown.change && <Text dimColor wrap="truncate-end">{shown.change}</Text>}
      <Box flexDirection="row" marginTop={1} width={width}>
        {head(before, 'Original', half)}
        {head(shown, 'Updated', width - half)}
      </Box>
      {Image ? (
        <Image key="view-pair" source={pic.src} columns={box.columns} rows={box.rows} alt="[original and updated, side by side]" />
      ) : (
        <Text dimColor>This surface cannot draw images.</Text>
      )}
      <Box width={width}>
        {change ? (
          <Text wrap="truncate-end">
            <Text dimColor>{clock(change.check.at ?? 0)} · </Text>
            {change.check.name}
            <Text dimColor> · </Text>
            <Text color={change.was ? 'success' : 'error'}>{before.label ?? 'Original'} {change.was ? '✓' : '✗'}</Text>
            <Text dimColor> → </Text>
            <Text color={change.check.ok ? 'success' : 'error'}>{shown.label ?? 'Updated'} {change.check.ok ? '✓' : '✗'}</Text>
          </Text>
        ) : (
          <Text dimColor>Same so far: both sides match up to {clock(seconds)}</Text>
        )}
      </Box>
      {Scrub(ui, $, site, shown, width, shown)}
      <Box width={width} justifyContent="flex-end">{Actions(ui, $, shown, shown.source ?? shown.path, width < 60)}</Box>
      {(fixed.length > 0 || broken.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{fixed.length} fixed · {broken.length} broke · click one to jump there</Text>
          {Changes(ui, $, site, shown, fixed, broken)}
        </Box>
      )}
    </Box>
  )
}

// The one line a show call's row reads: what it shows, and what with.
export function toolLine(tool: string, input: unknown, isRunning: boolean): string {
  const i = (input ?? {}) as { path?: string; title?: string; compare?: string; compare_label?: string; checks?: unknown[] }
  const nameOf = (path: string) => slash(path).split('/').pop()
  const what = i.title ?? (i.path === undefined ? undefined : nameOf(i.path)) ?? ''
  const extra = [
    i.compare ? `vs ${i.compare_label ?? nameOf(i.compare)}` : '',
    i.checks?.length ? `${i.checks.length} checks` : '',
  ].filter(Boolean)
  const verb = tool.endsWith('video') ? (isRunning ? 'Cutting video' : 'Video') : isRunning ? 'Loading image' : 'Image'

  return `${tool.endsWith('video') ? '▶' : '▣'} ${verb} · ${what}${extra.length ? ' · ' + extra.join(' · ') : ''}`
}

const CHECKS = {
  type: 'array',
  description: 'Checks run: { name, ok, at? (seconds), url? }',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, ok: { type: 'boolean' }, at: { type: 'number' }, url: { type: 'string' } },
    required: ['name', 'ok'],
  },
}

const TOOL_INPUT = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Absolute path' },
    title: { type: 'string', description: 'Short caption' },
    pr: { type: 'string', description: 'PR URL or number' },
    url: { type: 'string', description: 'The page shown; adds Open page' },
    changes: {
      type: 'array',
      description: 'What changed: { title, detail?, at? (seconds), url? }, in clip order',
      items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, at: { type: 'number' }, url: { type: 'string' } }, required: ['title'] },
    },
    summary: {
      type: 'array',
      description: 'QA in up to 3 lines: { label, ok, passed?, total? }',
      items: { type: 'object', properties: { label: { type: 'string' }, ok: { type: 'boolean' }, passed: { type: 'number' }, total: { type: 'number' } }, required: ['label', 'ok'] },
    },
    checks: CHECKS,
    compare: { type: 'string', description: 'Path to the before version' },
    compare_checks: { ...CHECKS, description: 'The same checks on the before side' },
    changes_title: { type: 'string', description: 'Heading for the changes list when not "What changed", e.g. "Video structure"' },
    previous: { type: 'string', description: '#id of the version this revises' },
    versions: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string' } }, required: ['path'] }, description: 'Earlier unshown versions of this work, oldest first: { path, note }' },
    label: { type: 'string', description: 'Name for this side if the user asks (default "Updated")' },
    compare_label: { type: 'string', description: 'Name for the before side if the user asks (default "Original")' },
  },
  required: ['path'],
}

// A picture needs no timed checks, play button or custom list heading.
const IMAGE_INPUT = {
  ...TOOL_INPUT,
  properties: Object.fromEntries(Object.entries(TOOL_INPUT.properties).filter(([k]) => !['checks', 'compare_checks', 'changes_title'].includes(k))),
}

// ── Usage stats ──────────────────────────────────────────────────────────

// Anonymous usage stats, sent to PostHog: what kind of thing happened and how
// often, under a random id made once per install. Never a file name, path,
// URL, title, prompt or anything typed. In this fork they are off unless
// SHOW_YOUR_WORK_TELEMETRY=1; DO_NOT_TRACK=1 still wins, and nothing is sent
// while POSTHOG_KEY is empty.
const POSTHOG_HOST = 'https://us.i.posthog.com'
// The project API key: it can only add events, never read them, so it ships.
const POSTHOG_KEY = 'phc_mLGFguVcH3Tei4txwqXFPU4xBgFDKThEZncahTv3LS3W'
// Events wait here and go out together, at most once a minute and at exit.
const FLUSH_MS = 60_000
const MAX_QUEUED = 500

type Props = Record<string, string | number | boolean | null | undefined | Record<string, string | number | boolean | undefined>>
type Event = { event: string; properties: Props; timestamp: string }

let isOn = false
let installId = ''
let base: Props = {}
let queue: Event[] = []
let isFlushing = false

// A made-up name for an install, the same every time for one id, so profiles
// read as "Swift Otter" rather than a UUID. Nothing in it comes from the person.
const ADJECTIVES = ['Swift', 'Quiet', 'Brave', 'Clever', 'Sunny', 'Lucky', 'Bold', 'Calm', 'Eager', 'Gentle', 'Happy', 'Jolly', 'Keen', 'Lively', 'Mellow', 'Nimble', 'Plucky', 'Rapid', 'Snappy', 'Tidy', 'Witty', 'Zesty', 'Cosmic', 'Fuzzy']
const ANIMALS = ['Otter', 'Falcon', 'Panda', 'Fox', 'Koala', 'Lynx', 'Heron', 'Badger', 'Gecko', 'Owl', 'Puffin', 'Raccoon', 'Seal', 'Tiger', 'Wombat', 'Yak', 'Bison', 'Crane', 'Dolphin', 'Ferret', 'Hedgehog', 'Lemur', 'Moose', 'Quokka']
export function nicknameOf(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const n = Math.floor(h / ADJECTIVES.length) % 1000

  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[Math.floor(h / 1000) % ANIMALS.length]} ${n}`
}

async function startTelemetry($: EngineInterface, context: Props) {
  if (!POSTHOG_KEY) return
  const optIn = await $.env.get('SHOW_YOUR_WORK_TELEMETRY')
  const dnt = await $.env.get('DO_NOT_TRACK')
  const quiet = await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
  if (!/^(1|true|on|yes)$/i.test(optIn ?? '') || /^(1|true)$/i.test(dnt ?? '') || quiet) return
  installId = String((await $.store.get('installId')) ?? '')
  const isNew = !installId
  if (isNew) {
    installId = crypto.randomUUID()
    await $.store.set('installId', installId)
  }
  isOn = true
  // Each install is one anonymous person, keyed by its random id: the profile
  // holds the setup it runs on, never anything about who uses it.
  // No location, ever: no IP is sent, and PostHog is told not to look one up.
  base = { ...context, $ip: null, $geoip_disable: true }
  const profile = { $set: { ...context, name: nicknameOf(installId) }, $set_once: { first_plugin_version: String(context.plugin_version ?? "") } }
  if (isNew) track('installed', profile)
  track('session_started', profile)
  $.clock.every(FLUSH_MS, () => void flush($))
}

// Counts and kinds only: callers pass no names, paths or text.
function track(event: string, properties: Props = {}) {
  if (!isOn) return
  if (queue.length >= MAX_QUEUED) queue.shift()
  queue.push({ event, properties: { ...base, ...properties }, timestamp: new Date().toISOString() })
}

async function flush($: EngineInterface) {
  if (!isOn || isFlushing || !queue.length) return
  isFlushing = true
  const batch = queue
  queue = []
  try {
    const r = await $.http.fetch(`${POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: POSTHOG_KEY, batch: batch.map(e => ({ ...e, distinct_id: installId })) }),
    })
    // A refused batch is dropped, not retried: stats are never worth a backlog.
    if (!r.ok && r.status >= 500) queue = [...batch, ...queue].slice(-MAX_QUEUED)
  } catch {
    queue = [...batch, ...queue].slice(-MAX_QUEUED)
  } finally {
    isFlushing = false
  }
}

// ── Updates ──────────────────────────────────────────────────────────────

// Keeps the plugin current without the user turning on marketplace
// auto-update: once a day it asks GitHub for the latest version and, when it
// is newer, updates through Claude Code's own plugin commands. The new
// version runs from the next session. In this fork it is off unless
// SHOW_YOUR_WORK_AUTO_UPDATE=1, and it follows the fork, not upstream.
const REPO = 'vascc124/claude-show-your-work'
const MARKETPLACE = 'vascc124'
const PLUGIN = 'show-your-work'
const LATEST = `https://raw.githubusercontent.com/${REPO}/main/.claude-plugin/plugin.json`
const DAY_MS = 24 * 60 * 60 * 1000

// 1.10.0 is newer than 1.9.3; anything after a dash is ignored.
export function isNewer(latest: string, current: string): boolean {
  const parts = (v: string) => (v.split('-')[0] ?? '').split('.').map(n => Number(n) || 0)
  const a = parts(latest), b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }

  return false
}

// Where Claude Code's CLI usually is, when it isn't on the session's PATH.
const CLAUDE_BINARIES = ['claude', '.local/bin/claude', '.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
let claudeBinary = ''

// Runs Claude Code's CLI with the session's own environment (its PATH and
// CLAUDE_CONFIG_DIR), so it changes this install and no other.
async function claude($: EngineInterface, args: string[]) {
  const known = CLAUDE_BINARIES.map(b => (b.startsWith('.') ? `${home}/${b}` : b))
  const candidates = [...new Set([claudeBinary, ...known].filter(Boolean))]
  for (const bin of candidates) {
    const r = await $.process.run([bin, ...args], { timeoutMs: 120_000 }).catch(() => undefined)
    if (r) {
      claudeBinary = bin
      return r
    }
  }
  return undefined
}

function jsonOf<T>(text: string | undefined, fallback: T): T {
  try { return text ? (JSON.parse(text) as T) : fallback } catch { return fallback }
}

let pluginVersion = '0.0.0'
let statsContext: Props = {}

export async function checkForUpdate($: EngineInterface, current: string) {
  const on = await $.env.get('SHOW_YOUR_WORK_AUTO_UPDATE')
  if (!/^(1|true|on|yes)$/i.test(on ?? '')) return
  const now = await $.clock.now()
  if (now - Number((await $.store.get('updateCheckedAt')) ?? 0) < DAY_MS) return
  await $.store.set('updateCheckedAt', now)

  const r = await $.http.fetch(LATEST)
  if (!r.ok) return
  const latest = String(jsonOf<{ version?: string }>(r.text, {}).version ?? '')
  if (!latest || !isNewer(latest, current)) return

  // A marketplace read from a folder is someone working on the plugin: leave it.
  const markets = jsonOf<{ name: string; source: string }[]>((await claude($, ['plugin', 'marketplace', 'list', '--json']))?.stdout, [])
  const market = markets.find(m => m.name === MARKETPLACE)
  if (!market || market.source === 'directory') return
  const plugins = jsonOf<{ id: string; scope?: string; version?: string }[]>((await claude($, ['plugin', 'list', '--json']))?.stdout, [])
  const installed = plugins.find(p => p.id === `${PLUGIN}@${MARKETPLACE}`)
  if (!installed) return
  // Already fetched by an earlier check; only a restart is missing.
  if (installed.version && !isNewer(latest, installed.version)) {
    $.ui.toast(`show-your-work ${latest} is installed. Restart Claude Code to use it.`)
    return
  }

  await claude($, ['plugin', 'marketplace', 'update', MARKETPLACE])
  const done = await claude($, ['plugin', 'update', `${PLUGIN}@${MARKETPLACE}`, '--scope', installed.scope ?? 'user'])
  if (done?.exitCode !== 0) {
    track('update_failed', { from: current, to: latest })
    return
  }
  track('update_installed', { from: current, to: latest })
  $.ui.toast(`show-your-work updated to ${latest}. Restart Claude Code to use it.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isWin = (await $.env.get('OS')) === 'Windows_NT'
    cwd = slash(started.cwd)
    sessionId = await $.session.id().catch(() => '')
    let ff = '', fp = ''
    if (isWin) {
      // The user's own temp folder is private already; Git's tools do the
      // scripts' work, and `where` finds ffmpeg (winget puts it on the PATH).
      isMac = false
      usrBin = await gitUsrBin($)
      home = slash((await $.env.get('USERPROFILE')) ?? '')
      TMP = `${slash((await $.env.get('TEMP')) ?? `${home}/AppData/Local/Temp`)}/claude-show-your-work`
      await $.fs.write(`${TMP}/.keep`, '').catch(() => undefined)
      ;[ff, fp] = await Promise.all([whereIs($, 'ffmpeg'), whereIs($, 'ffprobe')])
      ffmpeg = ff || 'ffmpeg'
      ffprobe = fp || 'ffprobe'
      // Claude Code draws pictures on Windows only where it was told the
      // terminal can (Rio, set up for it) or in a Ghostty build: anywhere else
      // it is known before the first one, so Claude isn't told it can show them.
      const forced = await $.env.get('CLAUDE_CODE_FORCE_TERMINAL_IMAGES')
      const where = `${(await $.env.get('TERM_PROGRAM')) ?? ''} ${(await $.env.get('TERM')) ?? ''}`
      if (!/^(1|true|on|yes)$/i.test(forced ?? '') && !/ghostty|kitty/i.test(where)) {
        canImage = false
        probed = true
        drawCause = 'terminal'
      }
    } else {
      const picked = await $.process.run(['sh', '-c', PICK_TMP]).catch(() => null)
      if (picked && picked.exitCode === 0 && picked.stdout.trim().startsWith('/')) TMP = picked.stdout.trim()
      const env = await $.process.run(['sh', '-lc', 'echo "home=$HOME"; echo "ff=$(command -v ffmpeg)"; echo "fp=$(command -v ffprobe)"; echo "os=$(uname -s)"'])
      const got = (key: string) => env.stdout.split('\n').find(l => l.startsWith(`${key}=`))?.slice(key.length + 1).trim() ?? ''
      ff = got('ff')
      fp = got('fp')
      home = got('home')
      isMac = got('os') !== 'Linux'
      ffmpeg = ff || (isMac ? '/opt/homebrew/bin/ffmpeg' : '/usr/bin/ffmpeg')
      ffprobe = fp || (isMac ? '/opt/homebrew/bin/ffprobe' : '/usr/bin/ffprobe')
    }
    hasVideoTools = false
    void (async () => {
      const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
      pluginVersion = manifest.version ?? '0.0.0'
      const program = (await $.env.get('TERM_PROGRAM')) ?? ''
      const term = (await $.env.get('TERM')) ?? ''
      const terminal = /ghostty/i.test(program + term) ? 'ghostty' : /kitty/i.test(term) ? 'kitty' : program.toLowerCase() || 'other'
      terminalName = terminal
      inTmux = !!(await $.env.get('TMUX')) || /^tmux/i.test(term)
      // tmux with passthrough off never lets a picture through: known before the first one.
      if (inTmux) {
        const pass = await $.process.run(['tmux', 'show', '-gv', 'allow-passthrough']).catch(() => null)
        if (pass && pass.exitCode === 0 && /^off$/i.test(pass.stdout.trim())) {
          canImage = false
          probed = true
          drawCause = 'tmux'
        }
      }
      statsContext = {
        plugin_version: pluginVersion,
        claude_code_version: (await $.session.version().catch(() => ({ base: '' }))).base ?? '',
        terminal,
        has_ffmpeg: !!ff,
        os: isWin ? 'windows' : isMac ? 'macos' : 'linux',
      }
      await startTelemetry($, statsContext)
      await checkForUpdate($, pluginVersion)
    })().catch(() => undefined)
    // Frames and converted pictures a week old go; a window that scrolls back
    // into view cuts its frames again from the source.
    void sh($, CLEAN_SH, TMP).then(() => trimFrames($), () => undefined)
    await $.command.register({
      name: 'img',
      description: 'Show an image or video in a pane: /img <path>',
      argumentHint: '<path>',
    })
    await $.tool.register({
      name: 'show_image',
      description:
        "Shows an image file to the user, inline in their terminal. Accepts PNG, JPEG, WebP, GIF and TIFF.\n\n" +
        'Use it without being asked whenever you have made or changed something visual, before you say the work is done: screenshot a page or component with headless Playwright, or show a design concept, chart, slide or generated image. ' +
        "Do this instead of asking the user to open a file or a localhost URL. Don't use it when nothing visual changed.\n\n" +
        'When the image shows work you changed, also pass `changes` (what you changed, a few words each) and `compare` (an image of the same view from before the change), so the user can switch between Original, Updated and Compare. ' +
        'Pass `summary` only for checks you actually ran. When you show a new version of something you showed earlier, pass `previous` with its #id so both stay in the same history.\n\n' +
        "The image goes to the user's screen, not to you. Read the file yourself only if you need to check it.",
      inputSchema: IMAGE_INPUT,
      isDeferred: false,
    })
    await $.tool.register({
      name: 'show_video',
      description:
        "Plays a video file to the user, inline in their terminal, in a player that starts on its own. Accepts MP4, MOV, WebM and GIF.\n\n" +
        'Use it without being asked to show recordings: after building or fixing an interactive feature, record a headless Playwright run that clicks through it and play that, rather than asking the user to try it themselves. Also use it for animations and for ad or film cuts you have made.\n\n' +
        'When the video shows work you changed, pass `changes`, each with `at` (the second it appears), and `checks` for what you tested, also with `at`. ' +
        'For a fix, record the same steps on the old version and pass that file as `compare` with its own `compare_checks`; the two play side by side, in sync. ' +
        'Pass `summary` only for checks you actually ran, and `previous` with an earlier #id when this is a new version of something you showed.\n\n' +
        'Keep clips short: they are played as frames, at most 900 at up to 12 per second. You do not see the video.',
      inputSchema: TOOL_INPUT,
      isDeferred: false,
    })

    return started
  })

  // While pictures draw, Claude is told up front that it can show its work,
  // so it does so without being asked. Once a draw has failed, every later
  // turn knows instead: what was "shown" was a notice, not the picture.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.some(t => TOOLS.includes(t))) return composed
    if (canImage) {
      return {
        sections: [...composed.sections, {
          id: 'show-your-work:show-visual-work', scope: 'session',
          text: "This terminal shows pictures and videos inline. After visual work, screenshot or record it and show it with show_image or show_video before you say you're done, instead of telling the user to open a file or localhost. For a UI fix, show before and after.",
        }],
      }
    }
    const why = cantDraw(drawCause, 'it', 'picture', sessionId).claude.replace(/, so the person saw a notice instead of it\./, '.')
    return {
      sections: [...composed.sections, {
        id: 'show-your-work:cannot-draw', scope: 'session',
        text: `show-your-work: pictures and videos can't draw in this session (${why}) Anything shown with show_image or show_video was not seen: the person saw a notice instead. Don't say they saw it.`,
      }],
    }
  })

  on('session.end', async ($, e, next) => {
    await flush($).catch(() => undefined)

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    pastedNames = (e.attachments ?? []).filter(a => a.type === 'image' && a.filename).map(a => a.filename!)

    return next(e)
  })

  on('command.run', { command: 'img' }, async ($, e) => {
    let arg = e.args.trim()
    if (/^\[Image #\d+\]$/.test(arg) || (!arg && pastedNames.length > 0)) {
      const name = pastedNames.at(-1)
      const found = name ? await findPasted($, name) : null
      if (!found) {
        return {
          text: 'Pasted images reach Claude, not mods, so /img cannot read one. Drag the file into the prompt (that types its path) or type the path: /img ~/path/to/file.png',
        }
      }
      arg = found
    }
    if (!arg) return { text: 'Usage: /img <path>' }
    try {
      const shown = await prepare($, arg)
      stop($, PANE)
      Object.assign(player(PANE), { frame: 0, isCompare: false, hasAutoplayed: true })
      await update($, current, () => shown)
      await $.ui.open({ id: PANE, title: shown.title })

      track('img_command', { kind: shown.frames ? 'video' : 'image' })
      return { text: `Showing ${shown.title} (${shown.width}×${shown.height}).` }
    } catch (err) {
      const n = noticeOf(err, expand(arg, cwd, home), home)
      track('show_failed', { from: 'img_command', reason: REASONS[n.kind] })
      return { text: n.message }
    }
  })

  on('tool.call', { tool: /^mcp__show-your-work__show_(image|video)$/ }, async ($, e) => {
    freshCalls.add(e.tool_use_id)
    const input = { ...e } as unknown as {
      path?: string; title?: string; change?: string; pr?: string; changes?: KeyChange[]; summary?: Summary[]; url?: string; checks?: Check[]
      compare?: string; compare_checks?: Check[]; label?: string; compare_label?: string; overlay?: Overlay; versions?: unknown; previous?: string; changes_title?: string
    }
    if (!input.path) return { deny: 'A path is needed.' }
    try {
      input.path = await locate($, input.path)
      if (input.compare) input.compare = await locate($, input.compare)
      const note = noteOf(input.changes, input.change, input.title)
      const parent = handleOf(input.previous)
      const kept = await storeVersion($, input.path, note, input.title, parent)
        .catch(() => ({ real: input.path!, copy: input.path!, id: '', chain: [] as { path: string; note?: string; id: string }[], missing: undefined as string | undefined }))
      // Every earlier version: the ones handed in, then the ones shown before.
      const given = await Promise.all(versionsOf(input.versions).map(async v => ({ ...v, path: await locate($, v.path) })))
      const earlier = [...given, ...kept.chain.filter(k => !given.some(g => g.path === k.path))]
      const compare = input.compare ?? earlier.at(-1)?.path
      const shown: Shown = {
        ...(await prepare($, kept.copy, input.title ?? input.path.split('/').pop(), await identityOf($, input.path))),
        origin: kept.real,
        change: input.change,
        pr: input.pr,
        url: input.url,
        checks: input.checks,
        changes: timesThatMean(input.changes, VIDEO.test(input.path)),
        summary: input.summary,
        label: input.label,
        overlay: input.overlay,
        note,
        ...(input.changes_title ? { changesTitle: String(input.changes_title).slice(0, 28) } : {}),
      }
      const lead = shown.frames?.lead ?? 0
      shown.checks = shiftTimes(shown.checks, lead)
      shown.changes = shiftTimes(shown.changes, lead)
      if (compare) {
        const label = input.compare_label
        shown.compare = {
          ...(input.compare ? await prepare($, compare, label ?? 'Original') : await preparedOf($, compare)),
          label,
          checks: input.compare_checks,
        }
        shown.compare.checks = shiftTimes(shown.compare.checks, shown.compare.frames?.lead ?? 0)
        // Pictures step back through every earlier version; a clip has only
        // Original and Updated.
        if (!shown.frames && earlier.length > 1) {
          shown.history = input.compare && !earlier.some(v => v.path === compare) ? [{ path: compare }, ...earlier] : earlier
          shown.historyAt = shown.history.findIndex(v => v.path === compare)
          remember(compare, shown.compare)
        }
        if (shown.frames && shown.compare.frames) Object.assign(shown, (await preparePair($, shown.compare, shown)) ?? {})
      }
      if (!shown.frames && kept.copy !== kept.real)
        remember(kept.copy, { kind: shown.kind, path: shown.path, source: shown.source, width: shown.width, height: shown.height, title: 'Original', generation: shown.generation })
      const what = shown.frames ? `video, ${clock(shown.frames.duration)}` : `${shown.width}×${shown.height}`
      const checks = [...(shown.checks ?? []), ...(shown.compare?.checks ?? [])]
      track(shown.frames ? 'video_shown' : 'image_shown', {
        format: (input.path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'none').toLowerCase().slice(0, 5),
        ...(shown.frames ? { duration: Math.round(shown.frames.duration * 10) / 10, frames: shown.frames.count } : {}),
        has_compare: !!shown.compare,
        is_side_by_side: !!shown.pair,
        is_revision: !!input.previous,
        versions: shown.history?.length ?? 0,
        changes: shown.changes?.length ?? 0,
        has_custom_changes_title: !!input.changes_title,
        summary_lines: shown.summary?.length ?? 0,
        summary_ok: shown.summary ? shown.summary.every(l => l.ok) : undefined,
        checks: checks.length,
        checks_failed: checks.filter(c => !c.ok).length,
        has_url: !!input.url,
        has_pr: !!input.pr,
      })

      const handle = kept.id ? ` #${kept.id}${kept.chain.length ? `, version ${kept.chain.length + 1} after #${kept.chain.at(-1)!.id}` : ''}.` : ''
      const hint = (kept.missing ? ` #${kept.missing} wasn't found, so this has no history.` : '') + handle
      const opening = canImage
        ? `Shown: ${shown.title} (${what}).`
        : `Not shown: ${cantDraw(drawCause, shown.title, shown.frames ? 'video' : 'picture', sessionId).claude} Don't say it was shown.`
      // Claude gets one short line; the drawing data stays out of its context.
      let mark = JSON.stringify(shown)
      if (kept.id) {
        const file = `${await storeOf($)}/${kept.id}.shown`
        const saved = isWin
          ? await $.fs.write(file, mark).then(() => ({ exitCode: 0 }), () => null)
          : await $.process.run(['sh', '-c', 'printf "%s" "$1" > "$0"', file, mark]).catch(() => null)
        if (saved && saved.exitCode === 0) {
          shownById.set(kept.id, shown)
          mark = `#${kept.id}`
        }
      }
      return { result: `${opening}${hint}\n${MARK}${mark}` }
    } catch (err) {
      const n = noticeOf(err, expand(input.path ?? '', cwd, home), home)
      notices.set(e.tool_use_id, n)
      track('show_failed', { from: String((e as { tool?: string }).tool ?? '').endsWith('video') ? 'show_video' : 'show_image', reason: REASONS[n.kind] })
      return { deny: `show-your-work: ${n.message}` }
    }
  }).catch(() => ({ deny: 'show-your-work: it could not be shown.' }))

  // The call's own row: one short line, not the whole input.
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    const props = e.props as { tool: string; input: unknown; isRunning: boolean }
    if (!TOOLS.includes(props.tool)) return next(e)
    const { Text } = $.ui.resolve(e) as Ui

    return <Text>{toolLine(props.tool, props.input, props.isRunning)}</Text>
  })

  // Inline in the transcript: the player is the tool's result row.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const props = e.props as { tool: string; output: unknown; isErrored: boolean; onScreen?: unknown }
    if (!TOOLS.includes(props.tool)) return next(e)
    if (props.isErrored) {
      const n = notices.get((props as { tool_use_id?: string }).tool_use_id ?? '') ??
        (textOf(props.output).includes(NO_FFMPEG) ? noticeOf(new Error(NO_FFMPEG), '') : undefined)
      if (!n) return next(e)
      return NoticeBox($.ui.resolve(e) as Ui, $, (e.viewport?.columns ?? 100) - 8, { ...n, copy: n.prompt, label: 'Copy prompt', action: `copy_${n.kind}_prompt` })
    }
    // Scrolled out of view: stop playing, and don't start there.
    const one = player(e.requestId)
    if (props.onScreen === null) {
      if (one.timer) stop($, e.requestId)
      one.hasAutoplayed = true
      one.wasAway = true
    } else if (one.wasAway && props.onScreen) {
      // Back in view: draw it fresh. The terminal may have dropped the picture
      // and the cache its frame; the redraw decodes the frame again if needed.
      one.wasAway = false
      versions.set(e.requestId, (versions.get(e.requestId) ?? 0) + 1)
      one.resend = true
    }
    const key = `${version}|${versions.get(e.requestId) ?? 0}|${e.viewport?.columns ?? 0}|${e.viewport?.rows ?? 0}`
    const kept = drawn.get(e.requestId)
    if (kept?.key === key) return kept.tree as Awaited<ReturnType<typeof Viewer>>
    const shown = await shownOf($, props.output)
    if (!shown) return next(e)
    const view = atStep(shown, e.requestId)
    const tree = await Viewer($, e, view, e.requestId, false, e.viewport)
    drawn.set(e.requestId, { key, tree })
    // As the play button does: send the frame on screen to the terminal again.
    if (one.resend) {
      one.resend = false
      void $.clock.sleep(120).then(() => draw($, e.requestId, sideOf(view, e.requestId), view)).catch(() => undefined)
    }

    return tree
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    const shown = await read($, current)
    if (!shown) return <Text dimColor>Nothing to show yet. Run /img path/to/file</Text>

    return Viewer($, e, atStep(shown, PANE), PANE, true, e.viewport)
  })
}
