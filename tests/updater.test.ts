import { expect, test } from 'claude-code/testing'

import { checkForUpdate } from '../hooks/register'

// A stand-in for the engine: GitHub says `latest`, the CLI reports `installed`
// from a marketplace of `source`, and every command run is recorded.
function engine(o: { latest?: string; installed?: string; source?: string; env?: Record<string, string>; checkedAt?: number; updateExit?: number; missingBinaries?: string[] } = {}) {
  const runs: string[][] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>(o.checkedAt ? [['updateCheckedAt', o.checkedAt]] : [])
  const $ = {
    env: { get: async (name: string) => ({ SHOW_YOUR_WORK_AUTO_UPDATE: '1', ...o.env })[name] },
    clock: { now: async () => 10 * 24 * 60 * 60 * 1000 },
    store: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void store.set(k, v) },
    http: { fetch: async () => ({ ok: true, status: 200, headers: {}, text: JSON.stringify({ version: o.latest ?? '0.6.0' }) }) },
    ui: { toast: (t: string) => void toasts.push(t) },
    process: {
      run: async (argv: string[]) => {
        if (o.missingBinaries?.includes(argv[0]!)) throw new Error('ENOENT')
        runs.push(argv)
        const args = argv.slice(1).join(' ')
        if (args === 'plugin marketplace list --json') return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ name: 'vascc124', source: o.source ?? 'github' }]) }
        if (args === 'plugin list --json') return { exitCode: 0, stderr: '', stdout: JSON.stringify([{ id: 'show-your-work@vascc124', scope: 'user', version: o.installed ?? '0.5.0' }]) }
        if (args.startsWith('plugin update')) return { exitCode: o.updateExit ?? 0, stderr: '', stdout: '' }
        return { exitCode: 0, stderr: '', stdout: '' }
      },
    },
  }

  return { $: $ as never, runs, toasts, store }
}
const args = (runs: string[][]) => runs.map(r => r.slice(1).join(' '))

test('a newer version on GitHub gets installed, then a restart is asked for', async () => {
  const e = engine()
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual([
    'plugin marketplace list --json',
    'plugin list --json',
    'plugin marketplace update vascc124',
    'plugin update show-your-work@vascc124 --scope user',
  ])
  expect(e.toasts).toEqual(['show-your-work updated to 0.6.0. Restart Claude Code to use it.'])
})

test('nothing runs when GitHub has the same version', async () => {
  const e = engine({ latest: '0.5.0' })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('it checks at most once a day', async () => {
  const e = engine({ checkedAt: 10 * 24 * 60 * 60 * 1000 - 60_000 })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('in this fork nothing updates unless SHOW_YOUR_WORK_AUTO_UPDATE=1', async () => {
  const e = engine({ env: { SHOW_YOUR_WORK_AUTO_UPDATE: '' } })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('SHOW_YOUR_WORK_AUTO_UPDATE=0 turns it off', async () => {
  const e = engine({ env: { SHOW_YOUR_WORK_AUTO_UPDATE: '0' } })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs.length).toBe(0)
})

test('a plugin loaded from a folder is never updated', async () => {
  const e = engine({ source: 'directory' })
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual(['plugin marketplace list --json'])
})

test('already fetched but not restarted: it only asks for the restart', async () => {
  const e = engine({ installed: '0.6.0' })
  await checkForUpdate(e.$, '0.5.0')
  expect(args(e.runs)).toEqual(['plugin marketplace list --json', 'plugin list --json'])
  expect(e.toasts).toEqual(['show-your-work 0.6.0 is installed. Restart Claude Code to use it.'])
})

test('a failed update says nothing to the user', async () => {
  const e = engine({ updateExit: 1 })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.toasts.length).toBe(0)
})

test('when claude is not on the PATH it is found where it is usually installed', async () => {
  const e = engine({ missingBinaries: ['claude'] })
  await checkForUpdate(e.$, '0.5.0')
  expect(e.runs[0]![0]!.endsWith('/claude')).toBe(true)
  expect(e.toasts.length).toBe(1)
})
