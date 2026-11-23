// The Steerline mod (hooks/mod.tsx), run by `claude plugin test plugin`. Each `on` here stands for the engine: a call on `$` is answered
// `{ value }`, and the platform is a stub of http.fetch that answers the two routes the mod reads, with the field names of the platform's
// SessionStatus and its /open answer (PluginModContractTests in tests/AgentPlatform.Tests holds the server to them).
import { expect, mock, test } from 'claude-code/testing'

import { addressKey, pairedToken, safeForToken, statusLine, toasts, troubleLine } from '../hooks/mod'
import { cases } from './address-cases'

const OPTS = { options: { url: 'https://steerline.example', token: 'tok' } }
const BAND = {
  plugin: 'steerline',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Platform = { registered: boolean; project?: string; askingInChat?: number | null; open: number; checkpoints: number; status?: number; standDown?: boolean; questions?: unknown[]; paneOpen?: boolean; answer?: { status: number; body: unknown }; answerHeld?: Promise<void> }

// The engine beneath the mod: a session id, the manifest, the platform, and a record of what it fetched, showed and toasted. It starts an
// interactive session (or the one given) and lets the first read run.
async function started($: any, on: any, platform: Platform, more: { env?: Record<string, string>; files?: Record<string, string>; interactive?: boolean; wait?: number } = {}) {
  const clock = mock.clock(on)
  const seen = { fetched: [] as { url: string; auth?: string; plugin?: string; method?: string; body?: string }[], status: [] as (string | undefined)[], toasts: [] as string[] }
  mock.env(on, more.env ?? {})
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('fs.read', (_: any, e: any) => {
    const path = String(e.path).split(String.fromCharCode(92)).join('/') // the engine hands the path on in the system's own separators
    // A file is named by the end of its path: the engine resolves one against the system's own root (S:/home/me on Windows, /home/me on Linux).
    const file = Object.keys(more.files ?? {}).find(k => path.endsWith(k))
    if (file !== undefined) return { value: more.files![file] }
    if (path.endsWith('/.claude-plugin/plugin.json')) return { value: JSON.stringify({ version: '9.9.9' }) }
    throw new Error('no such file')
  })
  on('http.fetch', (_: any, e: any) => {
    seen.fetched.push({ url: e.url, auth: e.init?.headers?.Authorization, plugin: e.init?.headers?.['X-Steerline-Plugin'], method: e.init?.method, body: e.init?.body })
    const headers = platform.standDown ? { 'x-steerline-stand-down': '1' } : {}
    if (e.url.endsWith('/answer')) {
      // Held: the platform answers only once the test lets it, so an answer is on its way meanwhile.
      if (platform.answerHeld) return platform.answerHeld.then(() => ({ value: { status: 200, ok: true, headers, text: JSON.stringify({ message: 'Answered.' }) } }))
      const a = platform.answer ?? { status: 200, body: { message: 'Answered.' } }
      return { value: { status: a.status, ok: a.status < 300, headers, text: JSON.stringify(a.body) } }
    }
    const status = platform.status ?? 200
    if (status !== 200) return { value: { status, ok: false, headers, text: '' } }
    const body = e.url.endsWith('/questions') ? { questions: platform.questions ?? [] }
      : e.url.includes('/api/sessions/')
      ? { registered: platform.registered, project: platform.project, askingInChat: platform.askingInChat ?? null }
      : { open: platform.open, checkpoints: platform.checkpoints, pulse: 'x' }
    return { value: { status: 200, ok: true, headers, text: JSON.stringify(body) } }
  })
  on('ui.status', (_: any, e: any) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.toast', (_: any, e: any) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'questions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: platform.paneOpen ? [{ id: 'steerline-questions', title: 'Steerline questions' }] : [] }))
  const interactive = more.interactive ?? true
  await $.session.start({ cwd: '/', surface: interactive ? 'terminal' : null, isInteractive: interactive })
  await clock.advance(more.wait ?? 5_000)
  return { clock, seen }
}

test('the status line names the project and its open questions', OPTS, async ($, on) => {
  const { seen } = await started($, on, { registered: true, project: 'agent-platform', open: 2, checkpoints: 1 })
  expect(seen.fetched.map(f => f.url)).toEqual(['https://steerline.example/api/sessions/sid-1', 'https://steerline.example/api/projects/agent-platform/open'])
  expect(seen.fetched[0]?.auth).toBe('Bearer tok')
  expect(seen.fetched[0]?.plugin).toBe('9.9.9')
  expect(seen.status.at(-1)).toBe('Steerline: agent-platform, 2 open questions (1 checkpoint)')
})

test('the band shows while this session waits on its question, and a toast says when it is answered', OPTS, async ($, on) => {
  const platform: Platform = { registered: true, project: 'agent-platform', askingInChat: 42, open: 1, checkpoints: 0 }
  const { clock, seen } = await started($, on, platform)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /question #42/ }))?.text).toBe('Steerline is waiting on your answer to question #42: answer here, or at https://steerline.example/q/42')
  await ui.unmount()

  platform.askingInChat = null
  platform.open = 0
  await clock.advance(60_000)
  expect(seen.toasts).toEqual(['Steerline: question #42 was answered or withdrawn'])
  expect(seen.status.at(-1)).toBe('Steerline: agent-platform, no open questions')
})

test('an unchanged read redraws nothing, and a later read asks both routes at once', OPTS, async ($, on) => {
  const { clock, seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 })
  await clock.advance(60_000)
  expect(seen.status).toEqual(['Steerline: p, 1 open question'])
  expect(seen.fetched.map(f => f.url.replace('https://steerline.example', ''))).toEqual(['/api/sessions/sid-1', '/api/projects/p/open', '/api/sessions/sid-1', '/api/projects/p/open'])
})

test('a session not on the record shows nothing', OPTS, async ($, on) => {
  const { seen } = await started($, on, { registered: false, open: 0, checkpoints: 0 })
  expect(seen.fetched).toHaveLength(1)
  expect(seen.status).toEqual([])
})

test('with no token nothing is called', async ($, on) => {
  const { clock, seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 })
  await clock.advance(120_000)
  expect(seen.fetched).toHaveLength(0)
})

test('an address set on purpose to this machine needs no token, as for the hook', async ($, on) => {
  const { seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 }, { env: { PLATFORM_URL: 'http://localhost:5312' } })
  expect(seen.fetched[0]?.url).toBe('http://localhost:5312/api/sessions/sid-1')
  expect(seen.fetched[0]?.auth).toBeUndefined()
})

test('so does this machine set as the plugin option, as for the hook', { options: { url: 'http://localhost:5311' } }, async ($, on) => {
  const { seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 })
  expect(seen.fetched[0]?.url).toBe('http://localhost:5311/api/sessions/sid-1')
  expect(seen.fetched[0]?.auth).toBeUndefined()
})

test('a token never goes over http to another machine', async ($, on) => {
  const { clock, seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 }, { env: { PLATFORM_URL: 'http://steerline.example', PLATFORM_TOKEN: 'tok' } })
  await clock.advance(120_000)
  expect(seen.fetched).toHaveLength(0)
})

test('a token goes over http to this machine', async ($, on) => {
  const { seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 }, { env: { PLATFORM_URL: 'http://localhost:5311', PLATFORM_TOKEN: 'tok' } })
  expect(seen.fetched[0]?.url).toBe('http://localhost:5311/api/sessions/sid-1')
})

test('a paired token is read for the address it was paired with, and its refusal says to pair again', { options: { url: 'https://steerline.example' } }, async ($, on) => {
  const paired = JSON.stringify({ 'https://steerline.example': { token: 'paired' }, 'https://other.example': { token: 'other' } })
  const { seen } = await started($, on, { registered: true, project: 'p', open: 0, checkpoints: 0, status: 401 }, { env: { HOME: '/home/me' }, files: { '/home/me/.steerline/paired.json': paired } })
  expect(seen.fetched[0]?.auth).toBe('Bearer paired')
  expect(seen.status.at(-1)).toBe(troubleLine(401, true))
})

test('a run with nobody at the prompt calls nothing', OPTS, async ($, on) => {
  const { clock, seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0 }, { interactive: false })
  await clock.advance(120_000)
  expect(seen.fetched).toHaveLength(0)
})

test('an unreachable platform says so on the status line, and a refusal slows the reads to one in ten minutes', OPTS, async ($, on) => {
  const platform: Platform = { registered: true, project: 'p', open: 0, checkpoints: 0, status: 503 }
  const { clock, seen } = await started($, on, platform)
  expect(seen.status.at(-1)).toBe('Steerline is unreachable')

  platform.status = 403
  await clock.advance(60_000)
  const refusedAt = seen.fetched.length
  await clock.advance(5 * 60_000)
  expect(seen.fetched.length).toBe(refusedAt)
  await clock.advance(5 * 60_000)
  expect(seen.fetched.length).toBeGreaterThan(refusedAt)
})

test('a stand-down shows nothing', OPTS, async ($, on) => {
  const { seen } = await started($, on, { registered: true, project: 'p', open: 1, checkpoints: 0, standDown: true })
  expect(seen.status).toEqual([])
})

test('after a /clear the mod reads on for the new session', OPTS, async ($, on) => {
  const { clock, seen } = await started($, on, { registered: true, project: 'agent-platform', open: 1, checkpoints: 0 })
  await $.session.end({ reason: 'clear', sessionId: 'sid-1', resume: { id: 'sid-1' } })
  const before = seen.fetched.length
  await clock.advance(60_000)
  expect(seen.fetched.length).toBeGreaterThan(before) // no session.start fires after a /clear, so the poll must outlive its session.end
  expect(seen.status.at(-1)).toBe('Steerline: agent-platform, 1 open question')
})

test('the address rules agree with pair.js (address-cases.ts, which hooks/test runs against pair.js too)', async () => {
  for (const c of cases) {
    expect([c.url, addressKey(c.url)]).toEqual([c.url, c.key])
    expect([c.url, safeForToken(c.url)]).toEqual([c.url, c.safe])
  }
})

test('the pure rules', async () => {
  expect(pairedToken('{"https://a.example":{"token":"t"}}', 'https://a.example')).toBe('t')
  expect(pairedToken('{"https://a.example":{"token":""}}', 'https://a.example')).toBeNull()
  expect(pairedToken('not json', 'https://a.example')).toBeNull()
  expect(troubleLine(429)).toBeNull()
  expect(troubleLine(401)).toBe('Steerline refused this machine\'s token (401)')
  expect(statusLine({ project: 'p', open: 1, checkpoints: 0, asking: null })).toBe('Steerline: p, 1 open question')
  const was = { project: 'p', open: 1, checkpoints: 0, asking: null }
  expect(toasts(was, { ...was, open: 3 })).toEqual(['Steerline: 2 new questions on p'])
  expect(toasts(was, { ...was, open: 2, asking: 7 })).toEqual([]) // this session's own question is no news to it
  expect(toasts(null, { ...was, open: 3 })).toEqual([])
  const own = { project: 'p', open: 2, checkpoints: 0, asking: 5 }
  expect(toasts(own, { ...own, asking: null })).toEqual(['Steerline: question #5 was answered or withdrawn', 'Steerline: 1 new question on p'])
  expect(toasts(own, { ...own, open: 1, asking: null })).toEqual(['Steerline: question #5 was answered or withdrawn'])
})

// The questions as GET /api/projects/{p}/questions answers them: open only, checkpoints first.
const QUESTIONS = [
  { id: 9, question: 'Spend $50?', options: ['Go', 'Hold'], recommended: 'Hold', checkpoint: true, role: 'owner', assignedTo: null },
  { id: 7, question: 'Ship it?', options: ['Yes', 'No'], recommended: 'Yes', checkpoint: false, role: 'owner', assignedTo: null },
]
const PANE = (surface: 'terminal' | 'desktop') => ({ plugin: 'steerline', surface, component: 'Pane', requestId: 'steerline-questions', props: { title: 'Steerline questions', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } }) as const

async function paneOpened($: any, on: any, more: Partial<Platform> = {}, wait?: number) {
  const run = await started($, on, { registered: true, project: 'agent-platform', open: 2, checkpoints: 1, questions: QUESTIONS, paneOpen: true, ...more }, { wait })
  const ran: any = await $.command.run({ command: 'questions', args: '', origin: { kind: 'user' }, presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(ran.text).toMatch(/Opened/)
  await run.clock.advance(0)
  return run
}

test('the questions pane lists the open questions with a button per option and a line for your own words', OPTS, async ($, on) => {
  await paneOpened($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect((await ui.find({ type: 'Text', text: /^#/ }))?.text).toBe('#9  checkpoint  for owner')
    expect((await ui.find({ type: 'Button', key: 'q9-o1' }))?.props.label).toBe('Hold  (recommended)')
    expect(await ui.find({ type: 'Input', key: 'q7-own' })).toBeDefined()
    await ui.unmount()
  }
})

test('a pane opened before the first status read finds the project itself', OPTS, async ($, on) => {
  await paneOpened($, on, {}, 0) // /questions typed as the session's first prompt
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Text', text: /^#/ }))?.text).toBe('#9  checkpoint  for owner')
  await ui.unmount()
})

test('pressing an option answers as the person of this machine and shows what the platform said', OPTS, async ($, on) => {
  const { clock, seen } = await paneOpened($, on, { answer: { status: 200, body: { message: 'Answered #9: Hold.' } } })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.press({ key: 'q9-o1' })
  await ui.unmount()
  const asked = await $.ui.mount(PANE('terminal')) // the test engine takes the invalidate, so a new mount draws the pane as it now is
  expect((await asked.find({ type: 'Text', text: /^Send/ }))?.text).toBe('Send "Hold" as the answer to #9?')
  await asked.press({ key: 'send' })
  await clock.advance(0)
  await asked.unmount()
  const sent = seen.fetched.find(f => f.url.endsWith('/answer'))
  expect(sent?.url).toBe('https://steerline.example/api/projects/agent-platform/guidance/9/answer')
  expect(sent?.method).toBe('POST')
  expect(JSON.parse(sent?.body ?? '{}')).toEqual({ answer: 'Hold' })
  expect(sent?.auth).toBe('Bearer tok')
  const after = await $.ui.mount(PANE('terminal'))
  expect((await after.find({ type: 'Text', text: /Answered #9/ }))?.text).toBe('Answered #9: Hold.')
  await after.unmount()
})

test('one press or one Enter sends nothing: the answer waits for Send, focus starts on Refresh and then on Cancel', OPTS, async ($, on) => {
  const { clock, seen } = await paneOpened($, on)
  const ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.props.autoFocus).toBe(true)
  await ui.press({ key: 'q9-o1' })
  await ui.input({ key: 'q7-own', text: 'Yes' })
  await clock.advance(0)
  await ui.unmount()
  expect(seen.fetched.filter(f => f.url.endsWith('/answer'))).toHaveLength(0)
  const asked = await $.ui.mount(PANE('terminal'))
  expect((await asked.find({ type: 'Button', key: 'cancel' }))?.props.autoFocus).toBe(true)
  await asked.press({ key: 'cancel' })
  await clock.advance(0)
  await asked.unmount()
  expect(seen.fetched.filter(f => f.url.endsWith('/answer'))).toHaveLength(0)
  const after = await $.ui.mount(PANE('terminal'))
  expect(await after.find({ type: 'Text', text: /^Send/ })).toBeUndefined()
  await after.unmount()
})

test('your own words go as the answer, and a refusal is shown as the platform words it', OPTS, async ($, on) => {
  const refusal = "Only a person answers a question: pair this machine with /steerline:pair to answer from your session, or answer on the question's page."
  const { clock, seen } = await paneOpened($, on, { answer: { status: 403, body: { error: refusal } } })
  const ui = await $.ui.mount(PANE('terminal'))
  await ui.input({ key: 'q7-own', text: '  Not this week  ' })
  await ui.unmount()
  const asked = await $.ui.mount(PANE('terminal'))
  await asked.press({ key: 'send' })
  await clock.advance(0)
  await asked.unmount()
  expect(JSON.parse(seen.fetched.find(f => f.url.endsWith('/answer'))?.body ?? '{}')).toEqual({ answer: 'Not this week' })
  const after = await $.ui.mount(PANE('terminal'))
  expect((await after.find({ type: 'Text', text: /Only a person/ }))?.text).toBe(refusal)
  await after.unmount()
})

test('a second Send while the first answer is on its way keeps that answer waiting, never drops it', OPTS, async ($, on) => {
  let release = () => {}
  const answerHeld = new Promise<void>(r => { release = r })
  const { clock, seen } = await paneOpened($, on, { answerHeld })
  const press = async (key: string) => { const ui = await $.ui.mount(PANE('terminal')); await ui.press({ key }); await clock.advance(0); await ui.unmount() }
  await press('q9-o1')
  await press('send') // on its way: the platform has not answered yet
  await press('q7-o0')
  await press('send')
  expect(seen.fetched.filter(f => f.url.endsWith('/answer'))).toHaveLength(1)
  const waiting = await $.ui.mount(PANE('terminal'))
  expect((await waiting.find({ type: 'Text', text: /^Send/ }))?.text).toBe('Send "Yes" as the answer to #7?')
  expect(await waiting.find({ type: 'Text', text: /still being sent/ })).toBeDefined()
  await waiting.unmount()
  release()
  await clock.advance(0)
  await press('send')
  const sent = seen.fetched.filter(f => f.url.endsWith('/answer'))
  expect(sent.map(f => f.url.split('/').at(-2))).toEqual(['9', '7'])
  expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({ answer: 'Yes' })
})
