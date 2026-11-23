// Steerline's mod (Claude Code 2.1.286 and later; see docs/plugin-support.md, The mod), which grows into the main client with the Node hook
// script kept as the fallback where mods do not load (decision #3929). A status line names the project and its open questions, a band above
// the prompt says while this session waits on its own question, a toast says when that question is answered or new questions arrive, and
// /questions opens a pane where the person answers the project's open questions (issue 161). Recording and gating are still in the command
// hooks (scripts/platform-hook.js).
//
// The status reads two routes the hooks already use, both read-only: GET /api/sessions/{id} (registered, project, the question it asks in
// its chat) and GET /api/projects/{p}/open (the open questions and checkpoints). It never reads /news, so it moves no session's news cursor.
// The pane reads GET /api/projects/{p}/questions and posts only a person's own answer, to POST /api/projects/{p}/guidance/{id}/answer. It
// reads once a minute and a few seconds after a turn, at most once in ten seconds (ten minutes while the platform refuses
// it or stands the plugin down), only in an interactive session (a -p run or a runner draws nothing). Its address and token are the plugin's
// own: the options, then PLATFORM_URL and PLATFORM_TOKEN, then the machine's paired token for that address (~/.steerline/paired.json, as the
// hook reads it). The token goes only over https or to this machine. With no token it calls nothing, except an address set on purpose to
// this machine, as the hook.
import type { Register } from 'claude-code'

const DEFAULT_URL = 'https://steerline.pigraven.com'
const POLL_MS = 60_000
const AFTER_START_MS = 5_000 // the session-start hook registers the session first
const AFTER_TURN_MS = 3_000
const MIN_GAP_MS = 10_000
const SLOW_GAP_MS = 10 * 60_000 // after a refusal or a stand-down, which another read a minute later would only repeat

const PANE = 'steerline-questions'

// An open question as the pane lists it, from GET /api/projects/{p}/questions (issue 161), which lists the open ones, checkpoints first.
export type Question = { id: number; question: string; options: string[]; recommended: string | null; checkpoint: boolean; role: string; assignedTo: string | null }
// The questions of that answer, kept in its order; anything malformed is left out.
export function openQuestions(body: any): Question[] {
  const list: any[] = Array.isArray(body?.questions) ? body.questions : []
  return list
    .filter(g => g && typeof g.id === 'number')
    .map(g => ({
      id: g.id,
      question: String(g.question ?? ''),
      options: Array.isArray(g.options) ? g.options.map(String) : [],
      recommended: typeof g.recommended === 'string' ? g.recommended : null,
      checkpoint: g.checkpoint === true,
      role: String(g.role ?? 'owner'),
      assignedTo: typeof g.assignedTo === 'string' ? g.assignedTo : null,
    }))
}
// What the pane says after an answer: the platform's own sentence, else the reason it could not be sent.
export function answerNotice(id: number, status: number, body: any, paired: boolean): string {
  if (status >= 200 && status < 300) return typeof body?.message === 'string' ? body.message : 'Answered #' + id + '.'
  if (typeof body?.error === 'string' && body.error) return body.error
  return troubleLine(status, paired) ?? 'Steerline asked this machine to slow down; nothing was recorded. Try again in a moment.'
}

// A good read: what the status line, the band and the toasts show.
export type Read = { project: string; open: number; checkpoints: number; asking: number | null }
type Got = { ok: true; body: any } | { ok: false; status: number; standDown?: boolean; body?: any }

// An address read as the URL class reads one (the module has none; plugin/tests/address-cases.json holds it to pair.js's URL-based rules):
// the authority ends at the first /, \, ? or #, a userinfo before its last @ is dropped, so http://localhost@other.example is other.example,
// the host is lower-case, and a \ in the path is a /. Null for anything but http or https.
function parts(url: string): { scheme: string; host: string; port: string; path: string } | null {
  const m = /^(https?):\/\/([^/\\?#]*)([^?#]*)/i.exec(url)
  if (!m) return null
  const authority = (m[2] ?? '').slice((m[2] ?? '').lastIndexOf('@') + 1).toLowerCase()
  const h = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(authority)
  if (!h || !h[1]) return null
  return { scheme: (m[1] ?? '').toLowerCase(), host: h[1], port: h[2] ?? '', path: (m[3] ?? '').replace(/\\/g, '/') }
}
// The key pair.js files a paired token under (scheme, lower-case host and port, path without a trailing slash); a default port is dropped
// by hand as URL.origin drops it.
export function addressKey(url: string): string | null {
  const p = parts(url)
  if (!p) return null
  const port = p.port && p.port !== (p.scheme === 'https' ? '443' : '80') ? ':' + p.port : ''
  return (p.scheme + '://' + p.host + port + p.path).replace(/\/+$/, '')
}
// Whether an address is this machine, as the hook's isLoopback.
export function isThisMachine(url: string): boolean {
  const p = parts(url)
  return !!p && ['localhost', '127.0.0.1', '[::1]'].includes(p.host)
}
// The token goes only over https or to this machine, as pair.js's and the hook's safeForToken.
export function safeForToken(url: string): boolean {
  const p = parts(url)
  return !!p && (p.scheme === 'https' || isThisMachine(url))
}
// The token paired.json holds for an address key, or null.
export function pairedToken(json: string, key: string): string | null {
  try {
    const entry = JSON.parse(json)[key]
    return entry && typeof entry.token === 'string' && entry.token ? entry.token : null
  } catch {
    return null
  }
}

// What is drawn: the status line's text and the question the band names.
const drawKey = (text: string | undefined, asking: number | null) => (text ?? '') + '|' + asking
const plural = (n: number, one: string) => n + ' ' + one + (n === 1 ? '' : 's')

// The status line's words for a good read.
export function statusLine(r: Read): string {
  const open = r.open === 0 ? 'no open questions' : plural(r.open, 'open question') + (r.checkpoints ? ' (' + plural(r.checkpoints, 'checkpoint') + ')' : '')
  return 'Steerline: ' + r.project + ', ' + open
}
// The one line for a failed read (docs/troubleshooting.md, What the status line says); null keeps what was shown (a 429 only asks to slow
// down). A refused paired token is cured by pairing again, as the hook says.
export function troubleLine(status: number, paired = false): string | null {
  if (status === 429) return null
  if (status === 401) return paired ? 'Steerline refused this machine\'s paired token (401): pair again with /steerline:pair <code>, then restart' : 'Steerline refused this machine\'s token (401)'
  if (status === 402) return 'Steerline: the company\'s plan has lapsed'
  if (status === 403) return 'Steerline: you may not use this company (403)'
  return 'Steerline is unreachable'
}
// The toasts for a change between two good reads of one project: this session's question answered or withdrawn, new questions. This
// session's own questions are no news to it: a new one of its own is taken off the count, and one of its own that closed is put back.
export function toasts(was: Read | null, now: Read): string[] {
  if (!was || was.project !== now.project) return []
  const out: string[] = []
  if (was.asking !== null && now.asking !== was.asking) out.push('Steerline: question #' + was.asking + ' was answered or withdrawn')
  const own = now.asking === was.asking ? 0 : (now.asking !== null ? 1 : 0) - (was.asking !== null ? 1 : 0)
  const added = now.open - was.open - own
  if (added > 0) out.push('Steerline: ' + plural(added, 'new question') + ' on ' + now.project)
  return out
}

export const register: Register = (on, options) => {
  let last: Read | null = null // the last good read: the band and the toasts compare against it, so a failed read in between loses nothing
  let trouble: string | null = null // the line for a failed read, shown in place of the last good one
  const NOTHING = drawKey(undefined, null)
  let drawn = NOTHING // what the status line and the band last showed, so an unchanged read redraws nothing
  let url = DEFAULT_URL
  let refresh: ((force: boolean) => void) | null = null // set by session.start once there is a token
  let timer: { cancel: () => void } | null = null
  // The questions pane: the open questions on the session's project, read when it opens, every minute while it is open, and on Refresh.
  let paneUsed = false // the minute's check of whether the pane is open is made only once /questions has opened it
  let questions: Question[] | null = null // null until the first read
  let questionsLine: string | null = null // why the list could not be read
  let loadQuestions: (() => void) | null = null
  let answerQuestion: ((id: number, answer: string) => boolean) | null = null // false when nothing was sent (one answer at a time)
  let notice: string | null = null // what the last answer from the pane did
  // An answer chosen but not sent: a press or an Enter only proposes it, and Send sends it, so one stray key never answers a question (a
  // focused pane takes the keys, and keys not meant for it press what has focus).
  let pending: { id: number; answer: string } | null = null
  const propose = (id: number, answer: string) => {
    const text = answer.trim()
    if (text) { pending = { id, answer: text }; notice = null }
  }
  const asking = () => (trouble === null && last ? last.asking : null)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!e.isInteractive) return r
    // The command exists whether or not Steerline can be reached, so the pane can say why it shows nothing.
    await $.command.register({ name: 'questions', description: 'Show the open Steerline questions on this project in a pane' })
    questionsLine = 'Steerline is not connected in this session: no token for this address (pair with /steerline:pair, or set the token in /plugin).'

    const optUrl = typeof options.url === 'string' && options.url.trim() ? options.url.trim() : DEFAULT_URL
    const envUrl = await $.env.get('PLATFORM_URL')
    url = (optUrl === DEFAULT_URL && envUrl ? envUrl : optUrl).replace(/\/+$/, '')
    let token: string | null = (typeof options.token === 'string' && options.token) || (await $.env.get('PLATFORM_TOKEN')) || null
    let paired = false
    const home = token ? undefined : (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    const key = addressKey(url)
    if (home && key) {
      token = await $.fs.read(home.replace(/\\/g, '/') + '/.steerline/paired.json').then(json => pairedToken(json, key), () => null)
      paired = !!token
    }
    // No token, no call, as the hook: except an address set on purpose to this machine (local development), which needs none. Never a token
    // over http to another machine.
    const local = !token && (optUrl !== DEFAULT_URL || !!envUrl) && isThisMachine(url)
    if ((!token && !local) || !safeForToken(url)) return r
    const version = await $.fs.read($.plugin.root + '/.claude-plugin/plugin.json').then(m => String(JSON.parse(m).version || 'unknown'), () => 'unknown')
    const headers: Record<string, string> = { 'X-Steerline-Plugin': version, 'X-Steerline-Hook': 'mod', ...(token ? { Authorization: 'Bearer ' + token } : {}) }

    // One call to the platform: a GET, or a JSON post. A refusal keeps its body, so its sentence ({ error }) can be shown.
    const call = async (path: string, post?: unknown): Promise<Got> => {
      try {
        const res = await $.http.fetch(url + path, post === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(post) })
        if (res.headers['x-steerline-stand-down'] === '1') return { ok: false, status: 0, standDown: true }
        let body: any = null
        try { body = JSON.parse(res.text) } catch { /* a plain-text answer */ }
        return res.ok ? { ok: true, body } : { ok: false, status: res.status, body }
      } catch {
        return { ok: false, status: 0 }
      }
    }
    const get = (path: string) => call(path)
    const openOf = (project: string) => get('/api/projects/' + encodeURIComponent(project) + '/open')
    let known: { session: string; project: string } | null = null // the session's project, so later reads ask both routes at once
    // A good read, null when not on the record (an unresolved folder, a capped plan: say nothing, decision #494) or stood down, or a failure.
    const read = async (): Promise<{ read: Read | null; standDown?: boolean } | { failed: Got & { ok: false } }> => {
      const session = await $.session.id()
      const guess = known && known.session === session ? known.project : null
      const [s, early] = await Promise.all([get('/api/sessions/' + encodeURIComponent(session)), guess ? openOf(guess) : null])
      if (!s.ok) return s.standDown ? { read: null, standDown: true } : { failed: s }
      if (!s.body || !s.body.registered || typeof s.body.project !== 'string') return { read: null }
      const project: string = s.body.project
      known = { session, project }
      const o = early && guess === project ? early : await openOf(project)
      if (!o.ok) return o.standDown ? { read: null, standDown: true } : { failed: o }
      return { read: { project, open: Number(o.body.open) || 0, checkpoints: Number(o.body.checkpoints) || 0, asking: typeof s.body.askingInChat === 'number' ? s.body.askingInChat : null } }
    }
    let lastAt = 0
    let slow = false
    const run = async (force: boolean) => {
      const at = await $.clock.now()
      if (!force && at - lastAt < (slow ? SLOW_GAP_MS : MIN_GAP_MS)) return
      lastAt = at
      const got = await read()
      if ('failed' in got) {
        const line = troubleLine(got.failed.status, paired)
        if (line === null) return
        trouble = line
        slow = got.failed.status !== 0 // no answer may be a blip; a refusal stays until something changes
      } else {
        if (got.read) for (const t of toasts(last, got.read)) $.ui.toast(t)
        slow = !!got.standDown
        last = got.read
        trouble = null
      }
      const text = trouble ?? (last ? statusLine(last) : undefined)
      const now = drawKey(text, asking())
      if (now === drawn) return
      drawn = now
      $.ui.status(text)
      $.ui.invalidate('ui.render')
    }
    let inflight: Promise<void> | null = null
    refresh = force => { inflight ??= run(force).finally(() => { inflight = null }) }

    const load = async () => {
      // Opened before the first status read (a /questions typed at once): ask the platform for the session's project first.
      if (!last && !known) await read()
      const project = last?.project ?? known?.project
      const before = JSON.stringify([questions, questionsLine])
      if (!project) {
        questionsLine = 'This session is not on a Steerline project.'
      } else {
        const g = await get('/api/projects/' + encodeURIComponent(project) + '/questions')
        if (g.ok) { questions = openQuestions(g.body); questionsLine = null }
        else questionsLine = g.standDown ? 'Steerline is standing this plugin down.'
          : g.status === 404 ? 'This session is not on a Steerline project.'
          // A 429 keeps a list already shown; with none yet, the pane says why it shows nothing rather than reading forever.
          : troubleLine(g.status, paired) ?? (questions === null ? 'Steerline asked this machine to slow down; press r in a moment.' : questionsLine)
      }
      // An unchanged list draws nothing, so a minute's read does not redraw the pane under words half typed into it.
      if (JSON.stringify([questions, questionsLine]) !== before) $.ui.invalidate('ui.render')
    }
    let loading: Promise<void> | null = null
    loadQuestions = () => { loading ??= load().finally(() => { loading = null }) }
    // An answer from the pane (issue 161): the person's own press, sent as them with this machine's token; a company token is refused by the
    // platform with a sentence that says to pair, which the pane shows.
    let sending = false
    answerQuestion = (id, text) => {
      const project = last?.project ?? known?.project
      const answer = text.trim()
      if (!answer) return false
      if (!project) { notice = 'This session is not on a Steerline project.'; return false }
      if (sending) { notice = 'The last answer is still being sent; press Send again in a moment.'; return false }
      sending = true
      notice = 'Sending the answer to #' + id + '…'
      $.ui.invalidate('ui.render')
      void call('/api/projects/' + encodeURIComponent(project) + '/guidance/' + id + '/answer', { answer }).then(g => {
        notice = g.ok ? answerNotice(id, 200, g.body, paired)
          : g.standDown ? 'Steerline is standing this plugin down, so nothing was recorded; answer on the question\'s page.'
          : answerNotice(id, g.status, g.body, paired)
        sending = false
        $.ui.invalidate('ui.render')
        loadQuestions?.()
      })
      return true
    }
    questionsLine = null // connected: the pane's first read says the rest

    timer?.cancel()
    timer = $.clock.every(POLL_MS, () => {
      refresh?.(false)
      if (paneUsed) void $.ui.panes().then(open => { if (open.some(p => p.id === PANE)) loadQuestions?.() }, () => undefined) // re-read only while open
    })
    $.clock.after(AFTER_START_MS, () => refresh?.(true))
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (refresh) $.clock.after(AFTER_TURN_MS, () => refresh?.(false))
    return r
  })

  on('session.end', async ($, e, next) => {
    last = null
    trouble = null
    drawn = NOTHING
    $.ui.status(undefined)
    $.ui.invalidate('ui.render')
    // A /clear or a resume goes on in this process under another session id, and no session.start fires for it: keep reading, for that
    // session (read asks $.session.id() each time), once the session-start hook has registered it.
    if (refresh && (e.reason === 'clear' || e.reason === 'resume')) $.clock.after(AFTER_START_MS, () => refresh?.(true))
    else {
      timer?.cancel()
      timer = null
      refresh = null
    }
    return next(e)
  })

  on('command.run', { command: 'questions' }, async $ => {
    paneUsed = true
    questions = null
    pending = null // an answer left waiting when the pane was last closed is not asked again
    notice = null
    await $.ui.open({ id: PANE, title: 'Steerline questions', focus: true, closeOnEscape: true })
    loadQuestions?.() // with no connection the pane shows questionsLine, the reason
    return { text: 'Opened the Steerline questions pane (Escape closes it, r refreshes).', isTextDisplayOnly: true }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Link } = $.ui.resolve(e)
    const redrawn = (change: () => void) => () => { change(); $.ui.invalidate('ui.render') } // every press changes what the pane shows
    // Each option is a button (the recommended one marked), the line under them takes the person's own words, and the link opens the page.
    const body =
      questionsLine !== null ? <Text color="red">{questionsLine}</Text>
      : questions === null ? <Text dimColor>Reading the questions…</Text>
      : questions.length === 0 ? <Text dimColor>No open questions on {last?.project ?? 'this project'}.</Text>
      : (
        <Box flexDirection="column" gap={1}>
          {questions.map(q => (
            <Box flexDirection="column">
              <Text weight="bold">#{q.id}{q.checkpoint ? '  checkpoint' : ''}  for {q.assignedTo ? 'one person' : q.role}</Text>
              <Text>{q.question}</Text>
              {q.options.map((o, i) => (
                <Button key={'q' + q.id + '-o' + i} label={o + (o === q.recommended ? '  (recommended)' : '')} variant={o === q.recommended ? 'primary' : undefined} onPress={redrawn(() => propose(q.id, o))} />
              ))}
              <Input key={'q' + q.id + '-own'} placeholder="Or answer in your own words, then Enter" onSubmit={value => redrawn(() => propose(q.id, value))()} />
              <Link href={url + '/q/' + q.id} label={'Open #' + q.id + ' on Steerline'} />
            </Box>
          ))}
        </Box>
      )
    return (
      <Box flexDirection="column" gap={1}>
        {notice !== null && <Text weight="bold">{notice}</Text>}
        {pending !== null && (
          <Box flexDirection="column">
            <Text weight="bold">Send "{pending.answer}" as the answer to #{pending.id}?</Text>
            <Box gap={2}>
              {/* An answer still on its way keeps this one waiting, so a second press never drops it unsaid. */}
              <Button key="send" label="Send" onPress={redrawn(() => { const p = pending; if (p && answerQuestion?.(p.id, p.answer)) pending = null })} />
              <Button key="cancel" label="Cancel" autoFocus onPress={redrawn(() => { pending = null })} />
            </Box>
          </Box>
        )}
        {body}
        <Button key="refresh" label="Refresh" hotkey="r" {...(pending === null ? { autoFocus: true as const } : {})} onPress={() => loadQuestions?.()} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = asking()
    if (id === null || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>Steerline is waiting on your answer to question #{id}: answer here, or at {url}/q/{id}</Text>
      </Box>
    )
  })
}
