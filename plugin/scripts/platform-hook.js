#!/usr/bin/env node
// Agent platform, the Claude Code side. One script behind the hooks of an enrolled repository (.claude/settings.json, written by
// enroll.js, which also copies this file to .claude/hooks/platform-hook.js there) and, as the fallback, behind the user-level
// hooks that install.js writes into ~/.claude/settings.json:
//   session-start   resolve the project, replay spooled outcomes, register the session, print the brief (startup, clear, compact)
//   session-resume  a resumed or forked session: register it again and print only the news since its cursor, if any
//   subagent-start  give a subagent the decisions in scope and its parent's intent, with a protocol that leaves the outcome to the parent
//   prompt          (UserPromptSubmit) tell the platform of the prompt, and carry the unseen news; the second and later re-open an intent an outcome closed (decision #791);
//                   a prompt that is another session's message also tells it who sent it, never what it said (agent-platform #45)
//   inject-session  attach the Claude session id, and the project, to every mcp__platform__* tool call
//   ask-guidance    deny AskUserQuestion and send the model to ask_guidance, which files the question on the page; the model asks it in the chat too
//   guidance-wait   (async, wakes the session) after ask_guidance in an interactive session, hold a long poll for the answer and wake the session when the page answers
//   pre-write       (retired 2026-11-07, decision #3226) a no-op, so an older hooks.json that still names it does nothing
//   batch           (asyncRewake, PostToolBatch) once per batch of tool calls: note the files edited and read, send them with the heartbeat, at most once a
//                   minute (decision #791; since decision #3226 it asks for no news); when no waiter is alive for the session, hold one long
//                   poll for a signal addressed to it (its branch's merge request verdict), and wake the session when one lands (decisions #1157, #3226);
//                   a SendMessage to another session is told at once, with the sender's one-line summary and never the message (agent-platform #45)
//   heartbeat       (async) the heartbeat alone, from the PostToolUse hook of an older hooks.json
//   stop            refuse to end until an outcome is recorded; when the platform is unreachable, spool the outcome instead
//   tests           (Stop) run the repository's STEERLINE_TEST_COMMAND when the tree changed since its last green run (decision #1104);
//                   it needs no platform project and runs wherever the command is set
//   session-end     (SessionEnd) tell the platform the session ended, so its open intent closes (decision #791)
//   replay          (manual) send the spooled outcomes now;   version  (manual) print this script's version
// The project is the one of the folder the session started in (CLAUDE_PROJECT_DIR): the nearest platform.json walking up, else the
// user-level map in ~/.claude/platform.json, else PLATFORM_PROJECT in the environment. Outside a platform project every event is a no-op.
// Claude Code loads a repository's hooks only when the session starts at its root; when the repository's copy of this script is
// loaded, the user-level copy yields, so nothing fires twice, and a session started in a subfolder still has the user-level copy.
// Everything fails open (decided 2026-10-15): when the platform is unreachable the session goes on without it.
// As the Steerline plugin (decision #477, 2026-10-18; CLAUDE_PLUGIN_ROOT is set): the platform's address and token are the plugin's options
// (CLAUDE_PLUGIN_OPTION_URL, CLAUDE_PLUGIN_OPTION_TOKEN; the token sits in the OS's secure store), the MCP tools are
// mcp__plugin_steerline_platform__*, and with no platform.json the project is resolved by the platform from the repository's git remote
// and the folder inside it (#482), cached per session; a folder that resolves to nothing gets one line naming steerline enroll and nothing
// else (#494); register_session with a project id sets it explicitly (/steerline:project, #495). The spool lives under ~/.steerline (#487).
'use strict';
// 2026-10-19.1: the question-tool redirect also asks for the standing rule each option becomes (rules, #9).
// 2026-10-19.2: the heartbeat after every tool call, so a session that only reads or runs commands stays under Working now.
// 2026-10-20.1: the bearer token goes only over https or to this machine, never to a plain-http address elsewhere.
// 2026-10-20.3: a page answer that is none of the options also carries the platform's note to restate it as a wider rule (#17).
// 2026-10-20.4: the readback names the file it is about to write, so the platform adds the decisions naming it the session has not had in full (#772).
// 2026-10-20.5 (decision #791): the heartbeat moves to PostToolBatch and carries the files the batch edited and read; a prompt re-opens a
//   closed intent and the session's end closes it; the wait on a chat question is one long poll; read_decisions and get_brief keep an
//   explicit other project; the question-tool redirect asks for rules or one_off.
// 2026-10-21.1 (agent-platform #25): the brief is built under 9,000 characters by the platform, and this script cuts anything over 9,500 at a
//   line as a backstop (Claude Code caps a hook's output at 10,000 and shows the model only a path and 2,000 characters past it); the full
//   brief is for startup, clear and compact only, and a resumed or forked session gets the news since its cursor (session-resume).
// 2026-10-21.2: the session's git branch goes with its registration and its heartbeat, so the platform ties its intent to the issue and merge
//   request of that branch (Richard, 2026-10-21: which agents work on which tickets).
// 2026-10-22 (agent-platform #33): a prompt that reads like a standing preference ("from now on", "always", "never", "I want you to") gets a
//   one-line reminder to record it as a decision, quoting the person; a rule the person states is a decision even when worded as a request.
// 2026-10-22.3 (decision #1104, agent-platform #34): at a stop, the repository's own tests (STEERLINE_TEST_COMMAND) when the tree changed
//   since their last green run; a failure blocks the stop with the end of the output.
// 2026-10-22.4 (agent-platform #35): news reaches a session that only runs commands or sits idle. The prompt hook carries the unseen news; the
//   batch hook delivers it with the heartbeat (exit 2: Claude Code shows the message to the model, in or between turns) and leaves one long
//   poll per session behind, which the platform completes when a decision or a session's notice for this session lands (decisions #1151, #1157).
// 2026-10-25.1 (plugin 0.2.13): releases the changes from the review of agent-platform #35: the batch heartbeat and the prompt ask for the
//   news with news=1, the news waiter backs off as guidance-wait does and stops when a later hook supersedes its wait.
// 2026-11-03.1 (plugin 0.2.14): guidance-wait wakes its session when the question was withdrawn (agent-platform #40), and /steerline:project can set the project
//   again, so a name the platform refused is corrected by running the command once more (agent-platform #46).
// 2026-11-03.2 (plugin 0.2.15, agent-platform #45): work passed between sessions. The batch hook reports a SendMessage to another session (to, and the sender's
//   summary, else the message's first 80 characters; never the message), and the prompt hook reports a prompt wrapped as <cross-session-message>
//   (the sender's name; never its text).
const VERSION = '2026-11-07.1';
// 2026-11-07.1 (decision #3226): the pre-write readback is a no-op; a session that never declared an intent ends without an outcome.
const PREFERENCE = /\b(from now on|going forward|always|never|preferences?|i want you to|i['\u2019]d rather you|stop doing|don['\u2019]t ever|do not ever|every time you)\b/i;
const PREFERENCE_REMINDER = 'Steerline: this prompt may state a standing rule or preference. If it should hold beyond this task, record it with record_decision, attributed to the person and quoting their words (or ask_guidance if its scope is unclear); writing it into a file is not enough.';
// Claude Code caps each hook's additionalContext, systemMessage and stdout at 10,000 characters (since 2.1.89, no setting): longer output is
// saved to a file and the model gets its path and a 2,000-character preview, with no word to read it. The platform builds the brief under
// 9,000; this is the most the hook lets through, the rest of the 10,000 being room for what the hook adds and a platform that does not cap yet.
const MAX_CONTEXT = 9500;
// The heartbeat is sent at most this often per session; the platform counts a session working while heard in the last 10 minutes.
const HEARTBEAT_MS = 60000;
// An edit the hook saw goes to the platform within this, ahead of the minute, so a collision shows while it happens (decision #791).
const EDIT_SEND_MS = 10000;
// Most files kept per kind per session; past it a folder stands for its files (the platform matches names by prefix).
const MAX_PATHS = 200;
// How long the platform holds one long poll on a chat question before the hook asks again (decision #791); the platform's own cap is 55 s.
const WAIT_SECONDS = 50;
const fs = require('fs');
const path = require('path');

const event = process.argv[2] || '';
const home = process.env.USERPROFILE || process.env.HOME || '';
const userConfigPath = path.join(home, '.claude', 'platform.json');
const pluginMode = !!process.env.CLAUDE_PLUGIN_ROOT;
const spoolDir = pluginMode ? path.join(home, '.steerline', 'spool') : path.join(home, '.claude', 'platform-spool');
const sessionCacheDir = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(home, '.steerline', 'cache'), 'sessions');
const DEFAULT_URL = 'http://localhost:5311';
const TIMEOUT_MS = 8000;
// How long guidance-wait waits on an answer, and the news waiter for news; the hook's timeout in the settings is a little longer (WAIT_HOURS * 3600 + 300 seconds).
const WAIT_HOURS = 24;
// How many failed tries in a row the news waiter gives a platform that stopped answering (a restart, a deploy) before it gives up and leaves the
// next batch to start a waiter again; the backoff is guidance-wait's, 5 s a failure up to a minute, so this is about ten minutes.
const NEWS_WAIT_FAILURES = 12;
const logFile = process.env.PLATFORM_HOOK_LOG;
// Tools whose `project` is the session's project; the hook fills it in so an agent cannot file work under the wrong one.
const PROJECT_TOOLS = new Set(['declare_intent', 'ask_guidance', 'answer_guidance', 'read_decisions', 'get_brief', 'record_outcome', 'record_signal']);
// Reading tools keep a project the agent named (decision #791): the brief says "read_decisions <other project>" for the rest of another
// project's decisions, which the override made impossible; the writing tools are always the session's own project.
const OWN_PROJECT_OPTIONAL = new Set(['read_decisions', 'get_brief']);
// The platform's tool by its bare name, whether the repository's .mcp.json (mcp__platform__) or the plugin (mcp__plugin_steerline_platform__) provides it.
function bare(tool) { const m = /^mcp__(?:plugin_steerline_)?platform__(.+)$/.exec(tool || ''); return m ? m[1] : null; }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function norm(p) { return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }
const copy = norm(__filename).includes('/.claude/hooks/') ? 'repo' : 'user';
function log(parts) { if (!logFile) return; try { fs.appendFileSync(logFile, [copy].concat(parts).join(' ') + '\n'); } catch (e) { /* ignore */ } }
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
function enc(s) { return encodeURIComponent(s); }
function unlinkQuietly(p) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

// As the plugin, the user-level map of install.js is not read (it would claim folders and point at another platform), and the address
// falls back to the plugin's own declared default, which Claude Code does not export to hooks (seen 2026-10-18).
const userConfig = pluginMode ? {} : (readJson(userConfigPath) || {});
const pluginOptions = pluginMode ? ((readJson(path.join(process.env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json')) || {}).userConfig || {}) : {};
const pluginDefaultUrl = (pluginOptions.url || {}).default || null;
// A runner writes its job's short-lived token there in its per-run copy of the plugin (decision #517).
const pluginDefaultToken = (pluginOptions.token || {}).default || null;
const baseUrl = () => (process.env.CLAUDE_PLUGIN_OPTION_URL || process.env.PLATFORM_URL || pluginDefaultUrl || userConfig.url || DEFAULT_URL).replace(/\/$/, '');

// Which project a folder belongs to: the environment, then the nearest platform.json walking up (root is the folder that holds it),
// then the user-level map in ~/.claude/platform.json (longest matching root wins). Null means not a platform project.
function resolveProject(startDir) {
  const url = baseUrl();
  if (process.env.PLATFORM_PROJECT) return { project: process.env.PLATFORM_PROJECT, url, root: null };
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const local = readJson(path.join(dir, 'platform.json'));
    // As the plugin, the address is only the plugin's own (2026-10-18.3): a cloned repository's platform.json must not send the token elsewhere.
    if (local && local.project) return { project: local.project, url: (process.env.PLATFORM_URL || (pluginMode ? null : local.url) || url).replace(/\/$/, ''), root: dir };
    // A repository's root ends the search (2026-10-18.2): a repository nested in an enrolled one's folder is another repository.
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const here = norm(startDir || process.cwd()) + '/';
  let best = null;
  for (const [project, roots] of Object.entries(userConfig.projects || {})) {
    for (const root of [].concat(roots)) {
      const r = norm(root) + '/';
      if (here.startsWith(r) && (!best || r.length > best.r.length)) best = { project, r, root };
    }
  }
  return best ? { project: best.project, url, root: path.resolve(best.root) } : null;
}

// The plugin's way to a project (#482): the repository's git remote and the folder inside it, resolved by the platform; the answer is
// cached for the session, and register_session with a project id (the /steerline:project command, #495) writes the cache directly.
const { spawnSync } = require('child_process');
// A remote's user and password (https://oauth2:<token>@host/...) never leave the machine; scp-like git@host:path names no secret.
function bareRemote(remote) { return String(remote || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@\/]*@/i, '$1'); }
function git(dir, args) { const r = spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }
// A session id as a file name: it comes from the hook's input, so a / or .. in it never reaches a folder outside ours.
// The branch checked out in a folder, read from .git/HEAD with no git process (a worktree's .git is a file naming its git folder); null when
// detached or not in a repository.
function gitBranch(dir) {
  try {
    let d = path.resolve(dir);
    for (;;) {
      const dot = path.join(d, '.git');
      if (fs.existsSync(dot)) {
        let gitDir = dot;
        if (fs.statSync(dot).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dot, 'utf8'));
          if (!m) return null;
          gitDir = path.resolve(d, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
      }
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  } catch (e) { return null; }
}
function sidFile(sid) { return String(sid).replace(/[^A-Za-z0-9_-]/g, '_'); }
function cacheFile(sid) { return path.join(sessionCacheDir, sidFile(sid) + '.json'); }
function readCache(sid) { return readJson(cacheFile(sid)); }
function writeCache(sid, entry) { try { fs.mkdirSync(sessionCacheDir, { recursive: true }); fs.writeFileSync(cacheFile(sid), JSON.stringify(entry)); } catch (e) { /* ignore */ } }
async function resolveByRemote(startDir, sid) {
  const url = baseUrl();
  const cached = readCache(sid);
  if (cached && cached.project) return { project: cached.project, url: cached.url || url, root: null };
  if (cached && cached.unresolved) return null;
  // The platform could not be asked a minute ago: ask again only after a minute, so a platform that is down does not slow every hook.
  if (cached && cached.unreachable && Date.now() - (cached.at || 0) < 60000) return null;
  const top = git(startDir, ['rev-parse', '--show-toplevel']);
  const remote = top ? bareRemote(git(top, ['remote', 'get-url', 'origin'])) : '';
  if (!remote) { writeCache(sid, { unresolved: true, why: 'no git remote' }); return null; }
  const rel = path.relative(top, path.resolve(startDir)).replace(/\\/g, '/');
  try {
    const r = JSON.parse(await callAt(url, 'GET', '/api/resolve?remote=' + enc(remote) + '&path=' + enc(rel)));
    writeCache(sid, { project: r.project, url, why: r.why });
    return { project: r.project, url, root: null };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // Not attached (404) is an answer; anything else (down, a wrong or missing token, a timeout) is not, and says so (2026-10-18.3).
    if (/HTTP 404/.test(msg)) writeCache(sid, { unresolved: true, why: remote + ' is not attached' });
    else writeCache(sid, { unreachable: true, at: Date.now(), why: /HTTP 40[13]/.test(msg) ? 'the platform at ' + url + ' refused the token' : 'the platform at ' + url + ' could not be reached' });
    return null;
  }
}

// Two copies of this script can be installed: a repository's own (.claude/hooks/platform-hook.js, loaded by Claude Code only when
// the session starts at the repository root) and the user-level one (install.js). When the repository's copy is loaded it does the
// work and the user-level copy yields; a session started in a subfolder loads only the user-level copy, which then does the work.
function yieldsToRepoCopy(target) {
  if (!target || !target.root) return false;
  const vendored = path.join(target.root, '.claude', 'hooks', 'platform-hook.js');
  if (norm(__filename) === norm(vendored)) return false;                       // this is the repository's copy
  if (!fs.existsSync(vendored)) return false;                                   // the repository has no copy of its own
  const settings = readJson(path.join(target.root, '.claude', 'settings.json'));
  if (!settings || !JSON.stringify(settings.hooks || {}).includes('platform-hook.js')) return false; // the copy is not wired
  return !!process.env.CLAUDE_PROJECT_DIR && norm(process.env.CLAUDE_PROJECT_DIR) === norm(target.root);
}

const token = process.env.CLAUDE_PLUGIN_OPTION_TOKEN || pluginDefaultToken || process.env.PLATFORM_TOKEN;
const plainHeaders = { 'Content-Type': 'application/json' };
const headers = Object.assign({}, plainHeaders, token ? { Authorization: 'Bearer ' + token } : {});

// The token goes only over https or to this machine (a local platform), as the runner's GitLocation.SafeForSecrets.
function safeForToken(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

async function callAt(url, method, p, body, timeoutMs) {
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      // The address is the platform's, from the plugin's or the user's own settings, never from a request.
      const r = await fetch(url + p, { method, headers: safeForToken(url) ? headers : plainHeaders, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs || TIMEOUT_MS) }); // nosemgrep
      const text = await r.text();
      log([new Date(t0).toISOString(), event, method, p, r.status, (Date.now() - t0) + 'ms']);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + text.slice(0, 80));
      return text;
    } catch (e) {
      const detail = String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || e);
      log([new Date(t0).toISOString(), event, method, p, 'FAIL', (Date.now() - t0) + 'ms', detail.slice(0, 80)]);
      // A name that does not resolve right after a reconnect is the one failure worth a second try (seen in the Docker proof).
      if (attempt < 2 && /ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(detail)) { await sleep(300); continue; }
      throw e;
    }
  }
}

// The last thing the agent said, from the transcript: the best outcome text available when the platform cannot be reached.
function lastAssistantText(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let j; try { j = JSON.parse(lines[i]); } catch (e) { continue; }
      if (j.type !== 'assistant' || !j.message) continue;
      const c = j.message.content;
      const text = Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : String(c || '');
      if (text.trim()) return text.trim().slice(0, 4000);
    }
  } catch (e) { /* no transcript */ }
  return '';
}

// A file the session touched, as the platform names it: relative to the folder the session started in, with forward slashes; a file
// outside that folder is nobody's resource and is dropped (2026-10-20.4).
function relPath(startDir, cwd, p) {
  if (!p) return null;
  const rel = path.relative(startDir, path.resolve(cwd, String(p))).replace(/\\/g, '/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

// The files the session's batches edited and read (decision #791), per session, with whether each was sent: {edits: {rel: sent}, reads: {rel: sent}, sentAt}.
const pathsFile = (sid) => path.join(sessionCacheDir, sidFile(sid) + '.paths.json');
function readPaths(sid) { const p = readJson(pathsFile(sid)); return p && p.edits && p.reads ? p : { edits: {}, reads: {}, sentAt: 0 }; }
function writePaths(sid, seen) { try { fs.mkdirSync(sessionCacheDir, { recursive: true }); fs.writeFileSync(pathsFile(sid), JSON.stringify(seen)); } catch (e) { /* ignore */ } }
// A path into a set: as itself while the set is small, else as its folder, which covers its files on the platform. True when new.
function noteOne(set, rel) {
  if (rel in set) return false;
  const dir = path.posix.dirname(rel);
  const key = Object.keys(set).length < MAX_PATHS || dir === '.' ? rel : dir;
  if (key in set) return false;
  set[key] = false;
  return true;
}
// What a batch of tool calls edited and read (PostToolBatch gives every call with its input), into the session's sets; true when something is new.
function noteBatch(seen, calls, startDir, cwd) {
  let fresh = false;
  for (const t of calls || []) {
    const ti = (t && t.tool_input) || {};
    const rel = relPath(startDir, cwd, ti.file_path || ti.notebook_path);
    if (!rel) continue;
    const kind = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(t.tool_name) ? 'edits' : t.tool_name === 'Read' ? 'reads' : null;
    if (kind && noteOne(seen[kind], rel)) fresh = true;
  }
  return fresh;
}

// Work a session passes to another session (agent-platform #45). Claude Code's SendMessage tool sends it; Steerline sees none of it unless
// the hooks say so. Read off the transcripts of 2026-11-02: the model's input is {to, message, summary, notify_when_idle} (the harness
// adds content, recipient, recipient_kind and type to its copy), `to` is a session's name, optionally followed by " [ref]", or the address
// of a session on this machine ("uds:..."), and the receiving session gets the message as its prompt, wrapped as
// `Another Claude session sent a message:` and then <cross-session-message from="<sender's address>" name="<sender's name>" mode="prompting">.
// Only the one line goes to the platform (the sender's summary, else the start of the message): never the message itself.
const AGENT_ID = /^a[0-9a-f]{8,}$/i;            // a raw agent id: an in-process subagent talking to its parent
const SUMMARY_MAX = 120;                        // the platform cuts to the same
const SUMMARY_FALLBACK_CHARS = 80;              // a message sent with no summary: its first 80 characters
const CROSS_SESSION = /^\s*(?:[^<\n]{0,80}:[ \t]*\r?\n\s*)?<cross-session-message\b([^>]*)>/; // the wrapper at the start of a prompt, after at most the harness's own lead-in line (one line ending in a colon) and blank space
const ADDRESS = /^uds:|\\\\\.\\pipe\\|:\/\//i;  // a session's address on this machine, which names no one
function collapse(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }
// At most `max` characters, never ending on half an emoji; with `mark`, an ellipsis stands for what was cut (and counts in the max).
function cut(text, max, mark) {
  if (text.length <= max) return text;
  let n = mark ? max - 1 : max;
  if (/[\ud800-\udbff]/.test(text[n - 1] || '')) n--;
  return text.slice(0, n).trimEnd() + (mark ? String.fromCharCode(0x2026) : '');
}
// Whether SendMessage's reply shows the message went to an in-process subagent: Claude Code answers such a send with the agent's id
// (`resumedAgentId`, or `pin.id`, an "a" and hex). A reply that is missing or says neither is taken as a send to another session.
function toSubagent(response) {
  let r = response;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return /"resumedAgentId"\s*:/.test(r); } }
  if (Array.isArray(r)) r = r.map(x => (x && typeof x.text === 'string') ? x.text : '').join('');
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return false; } }
  if (!r || typeof r !== 'object') return false;
  return Boolean(r.resumedAgentId) || Boolean(r.pin && typeof r.pin.id === 'string' && AGENT_ID.test(r.pin.id));
}
// The handoffs among a batch's tool calls: {to, summary} each. A subscription (notify_when_idle with no message), a message to `main` or to
// an agent id (an in-process subagent), and a broadcast are no handoff.
function handoffsIn(calls) {
  const found = [];
  for (const t of calls || []) {
    if (!t || t.tool_name !== 'SendMessage') continue;
    const ti = t.tool_input || {};
    const to = collapse(ti.to != null ? ti.to : ti.recipient);
    const message = typeof ti.message === 'string' ? collapse(ti.message) : '';
    if (!to || !message) continue;
    if (to === 'main' || to === '*' || AGENT_ID.test(to) || ti.recipient_kind === 'agent' || ti.recipient_kind === 'main') continue;
    // A named subagent is addressed by its name, not its id, but the reply says it was one: it resumed an agent, or pinned an agent id.
    if (toSubagent(t.tool_response)) continue;
    const summary = cut(collapse(ti.summary), SUMMARY_MAX, true) || cut(message, SUMMARY_FALLBACK_CHARS, false);
    found.push({ to: cut(to, SUMMARY_MAX, true), summary });
  }
  return found;
}
// Who a prompt came from when it is another session's message: the sender's name from the wrapper (its `name`, else a `from` that is not an
// address), '' when the wrapper names no one; null when the prompt is not a cross-session message.
function handoffFrom(prompt) {
  const m = CROSS_SESSION.exec(String(prompt == null ? '' : prompt).slice(0, 2000));
  if (!m) return null;
  const attrs = {};
  for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return [attrs.name, attrs.from].map(collapse).find(s => s && !ADDRESS.test(s)) || '';
}
// Text for the model, cut at a line to MAX_CONTEXT with one line saying so; text within it is returned as it is.
function capContext(text) {
  if (text.length <= MAX_CONTEXT) return text;
  const note = '\n(Steerline: the rest was cut by the hook to fit Claude Code\'s 10,000-character limit for hook output; the get_brief tool gives the whole brief.)';
  const room = MAX_CONTEXT - note.length;
  let cut = text.lastIndexOf('\n', room);
  if (cut <= 0) cut = room; // one line longer than the room
  if (/[\ud800-\udbff]/.test(text[cut - 1] || '')) cut--; // never end on half an emoji
  return text.slice(0, cut).trimEnd() + note;
}
const unsent = (set) => Object.keys(set).filter(k => set[k] === false);

// The news waiter (decision #1157): one hook process per session stays behind after a batch and holds a long poll on the platform, which
// completes it when a decision or a session's notice that reaches this session lands; the process then wakes the session with the news
// (exit 2) and ends. A lock file names the waiter's pid, so a later batch starts no second one while it lives; session-end removes it.
const newsWaitFile = (sid) => path.join(sessionCacheDir, sidFile(sid) + '.news-wait.json');
function waiterAlive(lock) {
  const l = readJson(lock);
  if (!l || !l.pid || Date.now() - (l.at || 0) > WAIT_HOURS * 3600 * 1000) return false;
  try { process.kill(l.pid, 0); return true; } catch (e) { return false; }
}
// Wakes the model with text: with asyncRewake, Claude Code shows a background hook's stderr to the model when it exits 2, at once when
// the session is idle, and as a system reminder when it is working.
function wake(text) { process.stderr.write(capContext(text)); process.exitCode = 2; }
async function waitForNews(sid, call) {
  const lock = newsWaitFile(sid);
  if (waiterAlive(lock)) return;
  try { fs.mkdirSync(sessionCacheDir, { recursive: true }); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch (e) { return; }
  const until = Date.now() + WAIT_HOURS * 3600 * 1000;
  let peeked = 0, failures = 0, answered = false;
  try {
    while (Date.now() < until) {
      const mine = readJson(lock);
      if (!mine || mine.pid !== process.pid) return; // the session ended (session-end removes the lock), or another waiter took over
      if (failures) await sleep(Math.min(60000, 5000 * failures)); // guidance-wait's backoff
      let text;
      try { text = await call('GET', '/api/sessions/' + enc(sid) + '/news/wait?wait=' + WAIT_SECONDS + '&peeked=' + peeked, undefined, (WAIT_SECONDS + 15) * 1000); failures = 0; }
      catch (e) {
        if (/HTTP 404/.test(String(e && e.message))) return;          // an older platform has no wait: nothing to hold
        if (!answered || ++failures > NEWS_WAIT_FAILURES) return;      // never reached, or down for long: the next batch tries again
        continue;
      }
      let w;
      try { w = JSON.parse(text); } catch (e) { return; }                 // not the wait's answer: an older platform
      if (!w || typeof w !== 'object') return;
      answered = true;
      if (w.ended || w.superseded) return;                                // the session is over, or a later hook holds its wait now
      if (w.news) { wake('Steerline news, landed while this session was between steps (a signal addressed to it, with what else it has not seen): ' + w.news); return; }
      peeked = Number(w.peeked) || peeked;
    }
  } finally {
    const mine = readJson(lock);
    if (mine && mine.pid === process.pid) unlinkQuietly(lock);
  }
}

// The spool: one JSON file per session whose outcome could not be recorded, sent by the next session that starts.
// A marker file remembers a session that started while the platform was unreachable, so its end is spooled too.
const spoolFile = (sid) => path.join(spoolDir, sidFile(sid) + '.json');
const markerFile = (sid) => path.join(spoolDir, sidFile(sid) + '.unconnected');
function spool(entry) {
  try { fs.mkdirSync(spoolDir, { recursive: true }); fs.writeFileSync(spoolFile(entry.session), JSON.stringify(entry, null, 2)); } catch (e) { /* ignore */ }
}
function mark(sid, target, cwd) {
  try { fs.mkdirSync(spoolDir, { recursive: true }); fs.writeFileSync(markerFile(sid), JSON.stringify({ project: target.project, url: target.url, cwd, at: new Date().toISOString() })); } catch (e) { /* ignore */ }
}

async function replay() {
  let files = [];
  try { files = fs.readdirSync(spoolDir).filter(f => f.endsWith('.json')); } catch (e) { return 0; }
  let sent = 0;
  for (const f of files) {
    const p = path.join(spoolDir, f);
    const claimed = p + '.' + process.pid + '.sending';
    try { fs.renameSync(p, claimed); } catch (e) { continue; } // another session is sending it
    const e = readJson(claimed);
    if (!e || !e.session) { unlinkQuietly(claimed); continue; }
    try {
      await callAt(e.url || DEFAULT_URL, 'POST', '/api/sessions/' + enc(e.session) + '/outcomes', { what: e.what, project: e.project, cwd: e.cwd, at: e.at });
      unlinkQuietly(claimed);
      sent++;
    } catch (x) {
      try { fs.renameSync(claimed, p); } catch (y) { /* ignore */ } // still unreachable: put it back for next time
      break;
    }
  }
  return sent;
}

// The repository's own tests at the end of a turn (decision #1104): the command is STEERLINE_TEST_COMMAND, which a repository sets in the
// env of its committed .claude/settings.json; without it this does nothing. It needs no platform. The tree's state (HEAD, status, the diff
// of tracked files, the contents of untracked ones) is fingerprinted, and the tests run only when it differs from the last green run; a
// failure blocks the stop with the tail of the output, once per state, so a session that cannot fix them is not held in a loop. A clean
// tree with no run on record whose HEAD is on a remote branch is taken as green (that branch's pipeline tested it), so a session that only
// reads never pays for the suite; a clean tree on local commits is tested. The test timeout stays under the hook's own (hooks.json, 900 s).
const TEST_TIMEOUT_S = 600;
const TEST_TIMEOUT_MAX_S = 870;
const TEST_OUTPUT_CHARS = 3000;
const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
function treeState(root) {
  const run = (args) => { const r = spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
  const head = run(['rev-parse', 'HEAD']), status = run(['status', '--porcelain', '-uall']), diff = run(['diff', 'HEAD', '--binary']);
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']);
  if (head === null || status === null || diff === null || untracked === null) return null;
  // git diff leaves untracked files out, so an edit to a new file would not change the state without their contents.
  const added = untracked.split('\0').filter(Boolean).map(f => { try { return f + '\0' + sha256(fs.readFileSync(path.join(root, f))); } catch (e) { return f; } }).join('\0');
  return { clean: status.trim() === '', print: sha256(head + '\0' + status + '\0' + diff + '\0' + added) };
}
function runTests(startDir) {
  const command = (process.env.STEERLINE_TEST_COMMAND || '').trim();
  if (!command) return;
  const root = git(startDir, ['rev-parse', '--show-toplevel']);
  if (!root) return;
  const state = treeState(root);
  if (!state) return;
  const stateFile = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(home, '.steerline', 'cache'), 'tests', sha256(norm(root)).slice(0, 16) + '.json');
  const last = readJson(stateFile);
  const save = (s) => { try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(Object.assign({ root }, s))); } catch (e) { /* ignore */ } };
  if (!last && state.clean && git(root, ['for-each-ref', '--contains', 'HEAD', '--count=1', 'refs/remotes'])) { save({ green: state.print }); return; }
  if (last && (last.green === state.print || last.failed === state.print)) return;
  const timeout = Math.min(Number(process.env.STEERLINE_TEST_TIMEOUT) || TEST_TIMEOUT_S, TEST_TIMEOUT_MAX_S) * 1000;
  const r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  // Green is the state after the run, so files the suite itself leaves in the tree do not make the next stop run it again.
  if (r.status === 0) { save({ green: (treeState(root) || state).print }); return; }
  save({ green: last && last.green, failed: state.print });
  // stderr first: the failures a runner reports are on stdout, and they are what the tail must keep.
  const outText = ((r.stderr || '') + (r.stdout || '')).trim();
  const tail = outText.length > TEST_OUTPUT_CHARS ? '...' + outText.slice(-TEST_OUTPUT_CHARS) : outText;
  const how = r.error && r.error.code === 'ETIMEDOUT' ? 'did not finish in ' + timeout / 1000 + ' s' : r.signal ? 'was stopped (' + r.signal + ')' : 'exited ' + r.status;
  out({ decision: 'block', reason: 'The repository\'s tests fail: `' + command + '` (STEERLINE_TEST_COMMAND) ' + how + '. Fix what broke and end again, or, if they cannot pass here, say why in your final message; ' +
    'this state of the tree is not tested twice. The end of the output:\n' + tail });
}

async function main() {
  if (event === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (event === 'replay') { const n = await replay(); process.stdout.write(n + ' spooled outcome(s) sent\n'); return; }

  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) { input = {}; }
  const sid = input.session_id || 'unknown';
  // The session's project is that of the folder it started in; input.cwd follows the agent's cd and may be elsewhere.
  const startDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const cwd = input.cwd || startDir;
  if (event === 'tests') { runTests(startDir); return; }
  const beatFile = path.join(sessionCacheDir, sidFile(sid) + '.beat');
  let beat = null; // the heartbeat to send, when one is due
  let handoffs = []; // work the batch's SendMessage calls passed to other sessions (agent-platform #45): sent at once, not with the minute's heartbeat
  if (event === 'batch' || event === 'heartbeat') {
    // Once per batch of tool calls (decision #791): what the batch edited and read goes into the session's sets, and a heartbeat goes out
    // when a minute has passed, or sooner while an edit is unsent; otherwise this costs one stat and, with a new file, one small write.
    const seen = readPaths(sid);
    // PostToolBatch gives the batch's calls; the PostToolUse heartbeat of an older hooks.json gives the one call it followed.
    const calls = input.tool_calls || (input.tool_name ? [input] : []);
    if (noteBatch(seen, calls, startDir, cwd)) writePaths(sid, seen);
    handoffs = handoffsIn(calls);
    let beatDue = true;
    try { beatDue = Date.now() - fs.statSync(beatFile).mtimeMs >= HEARTBEAT_MS; } catch (e) { /* no beat yet */ }
    const edits = unsent(seen.edits), reads = unsent(seen.reads);
    if (beatDue || (edits.length > 0 && Date.now() - (seen.sentAt || 0) >= EDIT_SEND_MS)) {
      // The beat is counted now, sent or not, so a platform that is down is not asked on every batch.
      try { fs.mkdirSync(sessionCacheDir, { recursive: true }); fs.writeFileSync(beatFile, ''); } catch (e) { /* ignore */ }
      beat = { seen, edits, reads };
    }
    // Nothing to send, and a waiter already holds this session's long poll (decision #1157): done, at the cost of one stat and one read.
    else if ((event !== 'batch' || waiterAlive(newsWaitFile(sid))) && handoffs.length === 0) return;
  }
  let target = resolveProject(startDir);
  if (yieldsToRepoCopy(target)) return;
  // In plugin mode with nothing found the old way, ask the platform (the session-start hook does it first; later events read the cache).
  if (!target && pluginMode && event !== 'inject-session') target = await resolveByRemote(startDir, sid);

  if (event === 'inject-session') {
    const ti = input.tool_input || {};
    const extra = { session: sid };
    const tool = bare(input.tool_name);
    const cached = !target && pluginMode ? readCache(sid) : null;
    const project = target ? target.project : cached && cached.project;
    // The session's own project, except where a reading tool names another one on purpose (decision #791).
    if (project && PROJECT_TOOLS.has(tool) && !(OWN_PROJECT_OPTIONAL.has(tool) && ti.project)) extra.project = project;
    // The /steerline:project command (#495): register_session with a project id names this session's project from now on.
    // Only for a session with no project yet, or one the command set: one resolved from its remote or platform.json is not redirected by an
    // agent, while a name the platform refused (agent-platform #46) can be corrected by running the command again.
    if (tool === 'register_session' && ti.project && pluginMode && !target && !(cached && cached.project && cached.why !== 'set by /steerline:project')) writeCache(sid, { project: ti.project, url: baseUrl(), why: 'set by /steerline:project' });
    // An interactive session (the CLI, attended or in the background; a -p run is sdk-cli) asks in its chat and waits: the
    // guidance-wait hook wakes it when the page answers first (2026-10-18). A headless run goes ahead on the verdict as before.
    if (tool === 'ask_guidance' && process.env.CLAUDE_CODE_ENTRYPOINT === 'cli') extra.waits = true;
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'platform tool; session id and project attached by hook', updatedInput: Object.assign({}, ti, extra) } });
    return;
  }

  if (!target) {
    // A folder the platform cannot place (#494): one line at session start, nothing else, so an unrelated repository never lands in a ledger.
    if (pluginMode && event === 'session-start') {
      const c = readCache(sid) || {};
      const why = c.why || 'it resolves to no project';
      if (c.unreachable) { process.stdout.write('Steerline: ' + why + ', so this session is not on the record; it works without it. steerline doctor explains.'); return; }
      process.stdout.write('Steerline: this folder is not attached to a project (' + why + '). Run steerline enroll to attach it, or /steerline:project <id> for this session; steerline doctor explains.');
    }
    return;
  }
  const { project, url } = target;
  const call = (method, p, body, timeoutMs) => callAt(url, method, p, body, timeoutMs);

  if (event === 'session-start') {
    try {
      const replayed = await replay();
      // PLATFORM_TASK is set by the platform when it starts a session for a task from the page, so the two are linked.
      const task = /^\d+$/.test(process.env.PLATFORM_TASK || '') ? Number(process.env.PLATFORM_TASK) : undefined;
      await call('POST', '/api/sessions', { id: sid, project, cwd, via: 'hook', task, branch: gitBranch(cwd) });
      unlinkQuietly(markerFile(sid));
      let brief = await call('GET', '/api/projects/' + enc(project) + '/brief?session=' + enc(sid));
      if (replayed) brief = '(' + replayed + ' outcome(s) spooled by earlier sessions were sent to the platform.)\n' + brief;
      process.stdout.write(capContext(brief));
    } catch (e) {
      mark(sid, target, cwd);
      process.stdout.write('The agent platform at ' + url + ' is unreachable (' + String(e && e.message || e).slice(0, 80) + '). This session works without it: ask the user directly if you must, and put the decisions you took in your final message; the platform will receive this session\'s outcome later.');
    }
    return;
  }

  if (event === 'session-resume') {
    // A resumed or forked session already has the brief it was given, replayed from its transcript (and a changed brief would cost the prompt
    // cache), so it gets only what the platform has to tell it since its cursor: the same news a write's readback reads, on a channel of
    // its own so that it is not held to what may change a write. The session is registered again (the record is kept on a resume; a fork is
    // a new id), and spooled outcomes go out as at start. Nothing to tell, or the platform unreachable: nothing is printed.
    try {
      await replay();
      await call('POST', '/api/sessions', { id: sid, project, cwd, via: 'hook', branch: gitBranch(cwd) });
      unlinkQuietly(markerFile(sid));
      const news = (await call('GET', '/api/sessions/' + enc(sid) + '/news?channel=resume')).trim();
      if (news) process.stdout.write(capContext('Steerline news since this session last looked (the brief it was given at start is in its history): ' + news));
    } catch (e) {
      mark(sid, target, cwd);
    }
    return;
  }

  if (event === 'batch' || event === 'heartbeat') {
    // The line about each handoff, never the message (agent-platform #45); fail open, like every call here.
    for (const h of handoffs) {
      try { await call('POST', '/api/sessions/' + enc(sid) + '/handoffs', { kind: 'sent', to: h.to, summary: h.summary }); } catch (e) { /* unreachable, or an older platform: the handoff is not on the record */ }
    }
    if (beat) {
      // The heartbeat, with what the session's batches edited and read since the last one (decision #791); marked sent only once the platform has it.
      // It does not ask for news (no news=1, decision #3226): the platform answers news only when asked, so a heartbeat can never wake a session;
      // news reaches a working session on its tool replies and prompts.
      try {
        await call('POST', '/api/sessions/' + enc(sid) + '/heartbeat', { edits: beat.edits, reads: beat.reads, branch: gitBranch(cwd) });
        for (const k of beat.edits) beat.seen.edits[k] = true;
        for (const k of beat.reads) beat.seen.reads[k] = true;
        beat.seen.sentAt = Date.now();
        writePaths(sid, beat.seen);
      } catch (e) { return; /* unreachable, or an older platform: the next heartbeat carries them; the tools still refresh the heartbeat */ }
    }
    // Stay behind as the session's one waiter for a signal addressed to it, such as its branch's merge request verdict (decisions #1157, #3226).
    if (event !== 'batch') return; // the PostToolUse heartbeat of an older hooks.json is not an async hook: it holds no waiter
    await waitForNews(sid, call);
    return;
  }

  if (event === 'prompt') {
    // A prompt from the person (decision #791): the second and later re-open the intent an outcome closed, so the session stays declared while
    // it works on; the reply says so, so the model records an outcome when this work is done, or declares other work as a new intent.
    const notes = [];
    // Another session's message arrives as this session's prompt (agent-platform #45): the platform is told who it came from, never what it said,
    // alongside the prompt's own call rather than after it, since the person waits on this hook; and a peer's wording is not a person's standing
    // preference, so the reminder below is left out.
    const from = handoffFrom(input.prompt);
    const received = from === null ? null : call('POST', '/api/sessions/' + enc(sid) + '/handoffs', { kind: 'received', from }).catch(() => { /* fail open */ });
    try {
      const r = JSON.parse(await call('POST', '/api/sessions/' + enc(sid) + '/prompts?news=1', {}));
      if (r && r.continued) notes.push('Steerline: your intent #' + r.continued + (r.what ? ' ("' + String(r.what).slice(0, 120) + '")' : '') + ' is open again for this prompt. If this is other work, declare a new intent first; record an outcome when it is done.');
      // The unseen news rides back with the answer (decision #1151): what landed while the session sat idle, before it starts on this.
      if (r && r.news) notes.push(String(r.news).trim());
    } catch (e) { /* fail open */ }
    if (received) await received;
    else if (PREFERENCE.test(String(input.prompt || ''))) notes.push(PREFERENCE_REMINDER);
    if (notes.length) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: capContext(notes.join(' ')) } });
    return;
  }

  if (event === 'session-end') {
    // The session ended (decision #791): its open intent closes, with an outcome from its last message where work followed the last one, and
    // its news waiter, if one is held, sees the lock gone and ends (decision #1157).
    unlinkQuietly(newsWaitFile(sid));
    try { await call('POST', '/api/sessions/' + enc(sid) + '/end', { reason: input.reason || 'other', lastMessage: lastAssistantText(input.transcript_path) }); }
    catch (e) { /* fail open: the intent expires as before */ }
    return;
  }

  if (event === 'subagent-start') {
    try {
      const brief = await call('GET', '/api/projects/' + enc(project) + '/brief?session=' + enc(sid) + '&subagent=true&agent=' + enc(input.agent_type || ''));
      out({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: capContext(brief) } });
    } catch (e) { /* unreachable: the subagent works without the brief */ }
    return;
  }

  if (event === 'ask-guidance') {
    const qs = (input.tool_input && input.tool_input.questions) || [];
    if (!qs.length) return;
    // The platform's own tool asks in both places at once (the card on the project page, and the chat here since 2026-10-18; the first
    // answer wins), so the question tool is denied and the model asks through ask_guidance, whose reply says how to ask here.
    try { await call('GET', '/health'); } catch (e) { return; } // platform unreachable: the question goes to the user
    const summary = qs.map(q => '"' + q.question + '" (options: ' + (q.options || []).map(o => o.label).join(' / ') + ')').join('; ');
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason:
      'The user is not asked with this tool on this project. Ask the same question with the platform\'s ask_guidance tool, one call per question (question, options, the one you recommend, the resources it is about, and either the standing rule each option becomes (rules) or one_off: true when the answer settles only this work; checkpoint when work must stop): it files the question on the project page and its reply tells you how to ask it here as well; the first answer wins. Your question(s): ' + summary } });
    return;
  }

  if (event === 'guidance-wait') {
    // Both places at once (2026-10-18): the session asked in its chat and ended its turn; this runs in the background (asyncRewake)
    // and waits on the question until it is answered. A page answer wakes the session with it (exit 2, the message on stderr); an
    // answer given in the chat was recorded by answer_guidance, so there is nothing to say. Since decision #791 each request is a long
    // poll the platform holds up to WAIT_SECONDS and releases the moment the answer lands, instead of a request every 3 s for up to a day.
    const m = /Guidance request #(\d+) filed on \S+ and shown on the project page/.exec(JSON.stringify(input.tool_response || ''));
    if (!m) return; // a headless verdict or a dialog: nothing to wait for
    const id = m[1];
    const until = Date.now() + WAIT_HOURS * 3600 * 1000;
    let failures = 0;
    while (Date.now() < until) {
      if (failures) await sleep(Math.min(60000, 5000 * failures));
      let g;
      const t0 = Date.now();
      try { g = JSON.parse(await call('GET', '/api/sessions/' + enc(sid) + '/guidance/' + id + '?project=' + enc(project) + '&wait=' + WAIT_SECONDS, undefined, (WAIT_SECONDS + 15) * 1000)); failures = 0; }
      catch (e) { failures++; continue; } // unreachable or restarting: keep waiting
      // Withdrawn (agent-platform #40): nobody will answer it, so this hook, which holds the session's wait on it, is the one to say so; no
      // news waiter wakes a session for a withdrawal.
      if (g.status === 'withdrawn') {
        if (g.withdrawnBySession === sid) return; // this session withdrew it itself and has the reply already (GitLab Duo on !74)
        wake('Guidance #' + id + ' was withdrawn by ' + g.withdrawnBy + ': ' + g.withdrawnReason + '. There is no answer and no decision: go on with your own judgment and do not ask it again.');
        return;
      }
      if (g.status !== 'answered') {
        // A platform from before the long poll answers at once: then poll every 3 s as before.
        if (Date.now() - t0 < 1000) await sleep(3000);
        continue;
      }
      if (/, in Claude Code$/.test(g.answeredBy || '')) return; // answered here and recorded already
      const became = g.decisionId ? '(decision #' + g.decisionId + ')' : '(the answer to #' + id + ', not a standing rule)';
      wake('Guidance #' + id + ' was answered on the project page by ' + g.answeredBy + ': "' + g.answer + '" ' + became + '. ' +
        'Proceed on that answer and do not ask again; tell the user it was answered on the page, so they need not answer it here.' + (g.restate ? ' ' + g.restate : '') + (g.answerOnly ? ' ' + g.answerOnly : ''));
      return;
    }
    return;
  }

  if (event === 'pre-write') return; // retired 2026-11-07 (decision #3226): the news reaches a working session on the tool replies and the prompt, not before every write

  if (event === 'stop') {
    if (input.stop_hook_active) return;
    const lastText = () => (input.last_assistant_message ? String(input.last_assistant_message).trim().slice(0, 4000) : '') || lastAssistantText(input.transcript_path);
    const spoolNow = (why) => {
      spool({ session: sid, project, cwd, url, at: new Date().toISOString(), what: '(' + why + ') ' + (lastText() || 'no outcome text was captured') });
      unlinkQuietly(markerFile(sid));
    };
    let s;
    // stopping=true: a session that ends stopped on its own checkpoint gets a waiting outcome written by the platform, and the answer resumes it.
    try { s = JSON.parse(await call('GET', '/api/sessions/' + enc(sid) + '?stopping=true')); }
    catch (e) { spoolNow('recorded from the session\'s last message: the platform was unreachable when it ended'); return; }
    if (s.hasOutcome) return;
    if (s.declaredIntent === false && !(s.openIntents && s.openIntents.length)) return; // a quick session that never declared an intent needs no outcome (decision #3226)
    if (s.askingInChat) return; // the turn ends to wait for the answer to the question asked in the chat; guidance-wait wakes it
    if (!s.registered) {
      // Never connected: either the platform was down when it started (marker), or it started before the hooks existed (nothing to do).
      if (fs.existsSync(markerFile(sid))) spoolNow('recorded from the session\'s last message: the platform was unreachable when it started');
      return;
    }
    const intent = s.openIntents && s.openIntents.length ? ' Intent #' + s.openIntents[0].id + ' is still open.' : '';
    out({ decision: 'block', reason: 'This session has not recorded an outcome on the platform.' + intent + ' Call the platform\'s record_outcome tool with what you did and what is left (or that nothing changed), then end.' });
  }
}

main().catch(() => { /* fail open */ });
