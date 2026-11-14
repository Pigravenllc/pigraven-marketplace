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
//   tool-failed     (PostToolUseFailure) a platform tool's call failed after inject-session let it through: classify the failure, remember an unusable
//                   platform, and give the model the same words (skip a recording call; ask a question in the chat, or stop when unattended)
//   guidance-wait   (async, wakes the session) after ask_guidance in an interactive session, hold a long poll for the answer and wake the session when the page answers
//   pre-write       (retired 2026-11-07, decision #3226) a no-op, so an older hooks.json that still names it does nothing
//   batch           (asyncRewake, PostToolBatch) once per batch of tool calls: note the files edited and read, send them with the heartbeat, at most once a
//                   minute (decision #791; since decision #3226 it asks for no news); when no waiter is alive for the session, hold one long
//                   poll for a signal addressed to it (its branch's merge request verdict), and wake the session when one lands (decisions #1157, #3226);
//                   a SendMessage to another session is told at once, with the sender's one-line summary (or the fixed words "(no summary)") and never any of the message (agent-platform #45)
//   heartbeat       (async) the heartbeat alone, from the PostToolUse hook of an older hooks.json
//   stop            refuse to end until an outcome is recorded; when the platform is unreachable, spool the outcome instead
//   tests           (Stop) run the repository's STEERLINE_TEST_COMMAND when the tree changed since its last green run (decision #1104), but only a command
//                   the user approved for this repository with trust-tests (plugin 0.2.21: a repository's settings are not the user's word; an unapproved
//                   or changed command is not run, does not block, and is announced once a day); it needs no platform project
//   session-end     (SessionEnd) tell the platform the session ended, so its open intent closes (decision #791)
//   replay          (manual) send the spooled outcomes now;   version  (manual) print this script's version
//   trust-tests     (manual, run in a repository) approve its STEERLINE_TEST_COMMAND for the tests hook: --command "<cmd>" names it, --forget withdraws the approval
// The project is the one of the folder the session started in (CLAUDE_PROJECT_DIR): the nearest platform.json walking up, else the
// user-level map in ~/.claude/platform.json, else PLATFORM_PROJECT in the environment. Outside a platform project every event is a no-op.
// Claude Code loads a repository's hooks only when the session starts at its root; when the repository's copy of this script is
// loaded, the user-level copy yields, so nothing fires twice, and a session started in a subfolder still has the user-level copy.
// Recording fails open (decided 2026-10-15, narrowed in 0.2.18, issue 91): when the platform is unreachable, lapsed or refusing the token, the
// recording calls (registration, heartbeat, batch, progress, brief, news) are dropped silently and counted; a QUESTION never fails open: the
// inject-session hook denies ask_guidance and tells the model to ask the person in the chat (an unattended session stops and reports). With no
// token, a plugin hook makes no network call at all. The rules are listed at 2026-11-13.2 below.
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
//   summary, else the message's first 80 characters; never the message; 0.2.21 sends "(no summary)" instead of those 80 characters), and the prompt hook reports a prompt wrapped as <cross-session-message>
//   (the sender's name; never its text).
const VERSION = '2026-11-14.2';
// 2026-11-14.2 (plugin 0.2.21, fixes from an external review): (1) a token is never sent over plain http to another machine: the hooks already held it back (headersFor), and now
//   pair.js headers answers an http address that is not this machine with a refusing Authorization that overrides .mcp.json's static one, and session start says so in plain words.
//   (2) the tests hook runs STEERLINE_TEST_COMMAND only when the user approved that exact command for that repository root (~/.steerline/trusted-tests.json, made by the
//   trust-tests command); an unapproved or changed command is not run, does not block the stop, and is announced once a day. (3) the spool, its markers and ~/.steerline are
//   owner-only (0700 folders, 0600 files; on Windows the folder's inherited rights are removed once). (4) a handoff with no summary sends "(no summary)", not the start of the message.
// 2026-11-14.1 (plugin 0.2.20, agent-platform issue 86 part 3 and issue 91 part 2): (1) the session's last message is sent only when the platform says this company
//   keeps it: before session-end sends it, and before a spooled outcome that holds it is replayed, the hook asks GET /api/data/last-message ({capture: true|false}),
//   at most one request, cached per address and token for 5 minutes (a 404 from an older platform counts as an answer; any other failure is kept for 1 minute), and on any doubt (failure, timeout, an older platform, a body
//   it does not understand, a platform known unusable) sends none. (2) reportGaps is called: after a successful heartbeat, session start or resume, or session end, a
//   session's dropped-call count goes to POST /api/sessions/{id}/gaps; cleared on success, kept and backed off (once a minute, five tries) on 404, 409 or any failure.
// 2026-11-13.3 (plugin 0.2.19, agent-platform issue 78, part 2): a machine paired with /steerline:pair (plugin/scripts/pair.js) keeps a personal token in
//   ~/.steerline/paired.json, keyed by the platform's address. It is the LAST source: an explicit option or environment token wins, a runner's per-run token default
//   wins, and the paired token is sent only to the address it was paired with. With one present the no-token rule no longer applies and the session is attended.
//   A paired token the platform refuses (401) is remembered like any, and the line says to pair again.
// 2026-11-13.2 (plugin 0.2.18, agent-platform issue 91, part 1 of fail-open): errors are classified (down: network, 5xx, 408; lapsed: 402; refused: 401 and 403;
//   slow: 429), a health cache (health.json) stops a known-down platform being retried on every event (60 s for down, 10 min for lapsed or refused), and a
//   recording call dropped for such a reason adds one to a local per-session count (<sid>.gaps.json; reportGaps sends it, since 0.2.20).
//   inject-session denies a platform tool when the platform is known unusable: a recording tool is skipped, ask_guidance sends the model to the chat
//   (interactive) or stops it (headless); the tool-failed hook (PostToolUseFailure) says the same when the call fails after the hook let it pass.
//   No token, no call (plugin mode, unless an explicit loopback address): and no /api/resolve unless the repository's committed .claude/settings.json
//   names Steerline. Distinct once-per-session lines for 402, 401, 403 and 429.
// 2026-11-13.1 (plugin 0.2.17, agent-platform issue 90): every call sends X-Steerline-Plugin (the plugin.json version, else 'unknown'), X-Steerline-Hook and,
//   when known, X-Steerline-Claude. The platform answers with X-Steerline-Min-Plugin (a version below its minimum: one line at session start, never a block) and
//   X-Steerline-Stand-Down (every event is then a silent no-op, with one GET /api/plugin/policy per 5 minutes on a prompt or session start to learn it was lifted;
//   a waiter already holding a long poll ends at its next answer, without waking the session).
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
// Makes the folder and writes the JSON; an error is swallowed (a hook never fails over its own bookkeeping).
// Every folder this hook makes under ~/.steerline goes through mkdirp, which first makes ~/.steerline itself owner-only (once per process, secureHome), so the
// spool, caches, stamps, test state and the trusted-tests file all sit under a private root and inherit its rights. Writes outside it (CLAUDE_PLUGIN_DATA) are left as they were.
const steerlineRoot = path.join(home, '.steerline');
const ownerOnlyDone = new Set();
function underSteerline(p) { const r = path.relative(steerlineRoot, path.resolve(p)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); }
function secureHome() { ownerOnlyDir(steerlineRoot); }
function mkdirp(dir) { if (underSteerline(dir)) secureHome(); fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, value) { try { mkdirp(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(value)); } catch (e) { /* ignore */ } }
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
const pluginManifest = pluginMode ? (readJson(path.join(process.env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json')) || {}) : {};
const pluginOptions = pluginManifest.userConfig || {};
// The plugin's version, sent with every call; the repository copy and install.js modes have no plugin root.
const pluginVersion = String(pluginManifest.version || 'unknown');
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
function writeCache(sid, entry) { try { mkdirp(sessionCacheDir); fs.writeFileSync(cacheFile(sid), JSON.stringify(entry)); } catch (e) { /* ignore */ } }
async function resolveByRemote(startDir, sid) {
  const url = baseUrl();
  const cached = readCache(sid);
  if (cached && cached.project) return { project: cached.project, url: cached.url || url, root: null };
  if (cached && cached.unresolved) return null;
  // The platform could not be asked a minute ago: ask again only after a minute, so a platform that is down does not slow every hook.
  if (cached && cached.unreachable && Date.now() - (cached.at || 0) < 60000) return null;
  // Issue 91: only a repository whose committed settings name Steerline is asked about; the plugin enabled at user scope resolves nothing elsewhere.
  if (!namesSteerline(startDir)) { writeCache(sid, { unresolved: true, quiet: true, why: 'the repository\'s settings do not name Steerline' }); return null; }
  const top = git(startDir, ['rev-parse', '--show-toplevel']);
  const remote = top ? bareRemote(git(top, ['remote', 'get-url', 'origin'])) : '';
  if (!remote) { writeCache(sid, { unresolved: true, why: 'no git remote' }); return null; }
  const rel = path.relative(top, path.resolve(startDir)).replace(/\\/g, '/');
  try {
    const r = JSON.parse(await callAt(url, 'GET', '/api/resolve?remote=' + enc(remote) + '&path=' + enc(rel)));
    writeCache(sid, { project: r.project, url, why: r.why });
    return { project: r.project, url, root: null };
  } catch (e) {
    // Not attached (404) is an answer; anything else (down, a wrong or missing token, a timeout) is not, and says so (2026-10-18.3).
    const kind = classify(e);
    if (e && e.status === 404) writeCache(sid, { unresolved: true, why: remote + ' is not attached' });
    else writeCache(sid, { unreachable: true, at: Date.now(), kind, status: (e && e.status) || 0, owner: kind === 'lapsed' ? ownerOf(e && e.body) : undefined, why: kind === 'refused' ? 'the platform at ' + url + ' refused the token' : 'the platform at ' + url + ' could not be reached' });
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

const explicitToken = process.env.CLAUDE_PLUGIN_OPTION_TOKEN || pluginDefaultToken || process.env.PLATFORM_TOKEN;
// The token pair.js keeps for this machine (issue 78): {"<address>": {token, ...}} in ~/.steerline/paired.json, read only as the plugin and only for the address
// this plugin talks to. The address key is pair.js's: scheme, lower-case host and port, path without a trailing slash.
function addressKey(url) {
  try { const u = new URL(String(url)); return u.protocol === 'https:' || u.protocol === 'http:' ? (u.origin + u.pathname).replace(/\/+$/, '') : null; } catch (e) { return null; }
}
// The token paired for an address key, or null.
function pairedFor(address) { const e = address ? (readJson(path.join(home, '.steerline', 'paired.json')) || {})[address] : null; return e && typeof e.token === 'string' && e.token ? e.token : null; }
const pairedAddress = pluginMode && !explicitToken ? addressKey(baseUrl()) : null;
const pairedToken = pairedFor(pairedAddress);
const token = explicitToken || pairedToken;
const plainHeaders = { 'Content-Type': 'application/json', 'X-Steerline-Plugin': pluginVersion, 'X-Steerline-Hook': VERSION };
// Claude Code's own version, only where it is known (CLAUDE_CODE_VERSION is not confirmed to reach hooks, so it is usually left out).
if (process.env.CLAUDE_CODE_VERSION) plainHeaders['X-Steerline-Claude'] = process.env.CLAUDE_CODE_VERSION;
const headers = Object.assign({}, plainHeaders, token ? { Authorization: 'Bearer ' + token } : {});
// What a call to this address carries: the token only over https or to this machine, and a paired token only to the address it was paired with.
function headersFor(url) {
  if (!safeForToken(url)) return plainHeaders;
  return pairedToken && addressKey(url) !== pairedAddress ? plainHeaders : headers;
}

// The token goes only over https or to this machine (a local platform), as the runner's GitLocation.SafeForSecrets.
function isLoopback(url) { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch (e) { return false; } }
function safeForToken(url) {
  try { return new URL(url).protocol === 'https:' || isLoopback(url); } catch { return false; }
}

// What the platform says about this plugin (issue 90), kept per machine for the hooks of every session: {url, standDown, min, update, at}.
// It is learned from the headers of any successful /api answer. A stand-down older than POLICY_MS is asked about again, once, on a prompt or a session start.
const POLICY_MS = 5 * 60 * 1000;
const LAPSE_MS = 24 * 60 * 60 * 1000; // a stand-down no answer has confirmed for this long lapses
const policyFile = path.join(path.dirname(sessionCacheDir), 'policy.json');
// A cached verdict counts only for the platform that gave it: one learned from another address is ignored.
function readPolicy(url) { const c = readJson(policyFile); return c && (!c.url || !url || c.url === url) ? c : null; }
function notePolicy(url, p, r) {
  if (!r.ok || !p.startsWith('/api/')) return; // an error or a route outside /api carries no verdict
  const next = { url, standDown: r.headers.get('x-steerline-stand-down') === '1', min: r.headers.get('x-steerline-min-plugin') || null, update: r.headers.get('x-steerline-update') || null, at: Date.now(), confirmed: Date.now() };
  const was = readPolicy(url);
  if (!was && !next.standDown && !next.min) return; // the usual case: nothing to say, no file
  if (was && !next.standDown && was.min === next.min && was.update === next.update && !was.standDown) return; // unchanged
  writeJson(policyFile, next);
}
// Whether a cached stand-down still holds, given how the last policy check ended (status: the HTTP status of a failed GET /api/plugin/policy,
// 0 for a network failure, undefined when none was made). The four cases:
//   1. 404: the platform has no policy (a rollback to a build without the endpoint): the stand-down is cleared, hooks carry on as normal.
//   2. 401 or 403: the token is the problem, not the policy: cleared, so the normal handling of a refused token takes over.
//   3. a network failure or a 5xx: the platform said so last time and cannot be asked: stays stood down, asked again at the next check.
//   4. in every case, a stand-down no successful answer has confirmed for LAPSE_MS (policy.json "confirmed") lapses until an answer says otherwise.
function stillStoodDown(c, status, now) {
  if (now - (c.confirmed || c.at || 0) >= LAPSE_MS) return false;
  return !(status === 404 || status === 401 || status === 403);
}
// True when the platform has stood this plugin down: the hook then does nothing at all (no output, no call), exit 0. After POLICY_MS it asks once
// (prompt and session-start only) whether that was lifted; when it cannot ask, stillStoodDown decides.
async function standDown(url) {
  const c = readPolicy(url);
  if (!c || !c.standDown || !stillStoodDown(c, undefined, Date.now())) return false;
  if (Date.now() - (c.at || 0) < POLICY_MS) return true;
  if (event !== 'prompt' && event !== 'session-start') return true;
  try { await callAt(url, 'GET', '/api/plugin/policy', undefined, 3000); }
  catch (e) {
    const status = e && e.status ? e.status : 0;
    const holds = stillStoodDown(c, status, Date.now());
    writeJson(policyFile, Object.assign({}, c, { standDown: holds, at: Date.now() }));
    return holds;
  }
  const after = readPolicy(url); // a successful answer was learned by notePolicy
  return !!(after && after.standDown);
}
// What a waiter asks between its long polls: it was started before the stand-down, learns of it from its own answers (notePolicy) and ends.
function stoodDown(url) { const c = readPolicy(url); return !!(c && c.standDown && stillStoodDown(c, undefined, Date.now())); }
// One line, once per session, when the platform says this plugin is below its minimum; it only warns.
function outdatedLine(url, sid) {
  const c = readPolicy(url);
  if (!c || !c.min) return '';
  const marker = path.join(sessionCacheDir, sidFile(sid) + '.outdated-told');
  if (fs.existsSync(marker)) return '';
  writeJson(marker, true);
  return 'Steerline plugin ' + pluginVersion + ' is older than the supported ' + c.min + '; update: ' + (c.update || 'claude plugin update steerline@steerline') + ' (it still works; this is only a warning).';
}

// ---- Fail-open rules (issue 91) --------------------------------------------------------------------------------------------------------------
// What a failed call was: 'down' (no answer, 5xx, 408), 'lapsed' (402, the plan), 'refused' (401 or 403, the token), 'slow' (429), else 'other' (a 404 is an answer).
function classify(e) {
  const s = e && e.status ? e.status : 0;
  if (s === 0 || s >= 500 || s === 408) return 'down';
  if (s === 402) return 'lapsed';
  if (s === 401 || s === 403) return 'refused';
  if (s === 429) return 'slow';
  return 'other';
}
// The owner a 402 body names ({error:'plan_lapsed', owner:'Ana'}), as one short plain line; '' when it names none.
function ownerOf(body) {
  try { const o = JSON.parse(body || '{}').owner; return typeof o === 'string' ? collapse(o).replace(/[^\p{L}\p{N} .'@_-]/gu, '').slice(0, 60) : ''; } catch (e) { return ''; }
}
// A refused paired token: the cure is another code, and a restart, since the MCP connection keeps the token it started with.
const pairAgainLine = (address) => 'Steerline refused this machine\'s paired token (401): it was revoked, or you left the company. Pair again with /steerline:pair <code> (a code from ' + address + '/pair), then restart Claude Code. This session works without it.';
// The one line for the person or the model: what happened and what it means. kind and status as classify gives them.
function lineFor(kind, status, owner) {
  if (kind === 'lapsed') return 'Steerline: your company\'s plan has lapsed; ask ' + (owner || 'your Steerline owner') + ' to renew. This session works without it.';
  if (kind === 'refused' && status !== 403 && pairedToken) return pairAgainLine(pairedAddress);
  if (kind === 'refused') return status === 403 ? 'Steerline says you may not use this company (403). Ask an admin. This session works without it.' : 'Steerline refused your token (401). Run steerline login. This session works without it.';
  if (kind === 'slow') return 'Steerline asked this machine to slow down (429). Nothing is lost; the next call goes through.';
  return 'Steerline is unreachable; this session works without it.';
}
// No token, no call: as the plugin with no token the hooks make no network request, unless the address was set on purpose and is this machine
// (local development). The runner's job token is the plugin's token default, so it counts as a token.
const noNetwork = pluginMode && !token && !(isLoopback(baseUrl()) && !!(process.env.CLAUDE_PLUGIN_OPTION_URL || process.env.PLATFORM_URL));
const NO_TOKEN_LINE = 'Steerline: this repository uses Steerline but you have no token yet. Run steerline login (or /plugin, Steerline, configure) to connect, or pair this machine with /steerline:pair <code> (a code from the Pair a machine page on your Steerline); this session works without it.';

// The health cache, per machine: {url, tk, state: 'ok'|'down'|'lapsed'|'refused', status, owner, at}. A healthy platform costs one read at most.
const DOWN_MS = 60 * 1000, LAPSED_MS = 10 * 60 * 1000;
const healthFile = path.join(path.dirname(sessionCacheDir), 'health.json');
const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
const tokenTag = token ? sha256(token).slice(0, 8) : '';
function noteHealth(url, kind, e) {
  if (kind !== 'down' && kind !== 'lapsed' && kind !== 'refused') return;
  writeJson(healthFile, { url, tk: tokenTag, state: kind, status: e && e.status ? e.status : 0, owner: kind === 'lapsed' ? ownerOf(e && e.body) : undefined, at: Date.now() });
}
// A call that succeeded clears the cached trouble; /health is open, so its answer only says the platform is up: it clears 'down', never a lapsed plan or a refused token.
function noteHealthy(p) { const h = readJson(healthFile); if (h && h.state !== 'ok' && (p !== '/health' || h.state === 'down')) writeJson(healthFile, { state: 'ok', at: Date.now() }); }
// The cached trouble that still holds for this address and token, else null.
function knownTrouble(url) {
  const h = readJson(healthFile);
  if (!h || !h.state || h.state === 'ok' || (h.url && url && h.url !== url) || (h.tk || '') !== tokenTag) return null;
  const age = Date.now() - (h.at || 0); // a stamp in the future (the clock moved back) has expired: it never holds a working platform off
  return age >= 0 && age < (h.state === 'down' ? DOWN_MS : LAPSED_MS) ? h : null;
}
// The error a skipped call throws: the same shape callAt gives a real failure, so every caller's own handling applies.
function skipped(status, body, why) { return Object.assign(new Error('HTTP ' + status + ' ' + why), { status, body: body || '', skipped: true }); }

// Dropped recording calls, counted per session ({count, since, tried, tries}); silent. reportGaps sends the count to the platform's POST /api/sessions/{id}/gaps (issue 91, part 2).
const gapsFile = (sid) => path.join(sessionCacheDir, sidFile(sid) + '.gaps.json');
function gap(sid) { const g = readJson(gapsFile(sid)) || { count: 0, since: new Date().toISOString() }; g.count = (g.count || 0) + 1; g.tries = 0; writeJson(gapsFile(sid), g); }
function dropped(sid, e) { if (classify(e) !== 'other') gap(sid); }
// A report that failed is not sent again for a minute, and after this many answers that were no help (a 404, a 409, a 400) it is left for good.
const GAP_RETRY_MS = 60 * 1000, GAP_MAX_TRIES = 5, GAP_TIMEOUT_MS = 2000;
// The report is the one call with a bound of 2 seconds, sent right after a call that succeeded: its timeout says the route is slow, not that the platform is down, so callAt does not remember it as an outage.
const GAPS_ROUTE = /^\/api\/sessions\/[^/]+\/gaps$/;
// Sends the session's count after a call that succeeded for it, at most one request, bounded by GAP_TIMEOUT_MS, never throwing. Sent: the count is cleared (what a
// later drop added while the request was out is kept). Not sent (any failure, a 404 or 409 included): the count is kept, stamped, and not offered again for a minute;
// a 401 or 402 is already remembered by the health cache (a 403 is this call's own) and the same stamp applies. A session whose own registration was dropped has no successful call
// to follow, so nothing is reported for it until it registers again (session start or resume).
async function reportGaps(sid, call) {
  try {
    const g = readJson(gapsFile(sid));
    if (!g || !(g.count > 0)) return;
    const age = Date.now() - (g.tried || 0);
    if ((g.tries || 0) >= GAP_MAX_TRIES || (g.tried && age >= 0 && age < GAP_RETRY_MS)) return;
    try {
      await call('POST', '/api/sessions/' + enc(sid) + '/gaps', { count: g.count, since: g.since }, GAP_TIMEOUT_MS);
      const now = readJson(gapsFile(sid));
      // Another since: another hook of this session already cleared this batch and a later drop began a new one, which is not this report's to clear.
      if (now && now.since !== g.since) return;
      if (now && now.count > g.count) writeJson(gapsFile(sid), { count: now.count - g.count, since: new Date().toISOString(), tries: 0 });
      else unlinkQuietly(gapsFile(sid));
    } catch (e) {
      const cur = readJson(gapsFile(sid)) || g;
      cur.tried = Date.now();
      if (classify(e) === 'other') cur.tries = (cur.tries || 0) + 1;
      writeJson(gapsFile(sid), cur);
    }
  } catch (e) { /* never breaks the hook */ }
}
// A line shown once per session (a flag file), so a lapsed plan or a refused token is said at session start or the first failed call and never per hook.
function toldOnce(sid, kind) {
  const f = path.join(sessionCacheDir, sidFile(sid) + '.told-' + kind);
  if (fs.existsSync(f)) return false;
  writeJson(f, true);
  return true;
}

// Whether a committed .claude/settings.json names Steerline: walking up from the folder to the git root, enabledPlugins has a steerline@ key set
// true, or extraKnownMarketplaces has steerline. settings.local.json is not committed and is not read; neither is the user's own settings.
function namesSteerline(startDir) {
  try {
    let d = path.resolve(startDir);
    for (;;) {
      // A folder outside any repository walks up through the home folder, whose .claude/settings.json is the user's own: never read as a repository's.
      const s = home && norm(d) === norm(home) ? null : readJson(path.join(d, '.claude', 'settings.json'));
      if (s && (Object.entries(s.enabledPlugins || {}).some(([k, v]) => k.startsWith('steerline@') && v === true) || (s.extraKnownMarketplaces && 'steerline' in s.extraKnownMarketplaces))) return true;
      if (fs.existsSync(path.join(d, '.git'))) return false;
      const up = path.dirname(d);
      if (up === d) return false;
      d = up;
    }
  } catch (e) { return false; }
}
// The no-token line, at most once a day on this machine.
const NO_TOKEN_STAMP = path.join(home, '.steerline', 'no-token.stamp');
function noTokenLineDue() {
  try {
    const age = Date.now() - Date.parse(fs.readFileSync(NO_TOKEN_STAMP, 'utf8').trim());
    if (age >= 0 && age < 24 * 60 * 60 * 1000) return false; // a stamp in the future (the clock moved back) has expired, as in knownTrouble
  } catch (e) { /* no stamp yet */ }
  try { mkdirp(path.dirname(NO_TOKEN_STAMP)); fs.writeFileSync(NO_TOKEN_STAMP, new Date().toISOString()); } catch (e) { /* ignore */ }
  return true;
}

async function callAt(url, method, p, body, timeoutMs) {
  // No token, or a platform known unusable a moment ago: no request (the /health probe is how the cache learns it is back).
  if (noNetwork) throw skipped(0, '', 'no token, so no call is made');
  if (p !== '/health') { const h = knownTrouble(url); if (h) throw skipped(h.status || 0, h.owner ? JSON.stringify({ error: 'plan_lapsed', owner: h.owner }) : '', 'recently ' + h.state + ', not retried yet'); }
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      // The address is the platform's, from the plugin's or the user's own settings, never from a request.
      const r = await fetch(url + p, { method, headers: headersFor(url), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs || TIMEOUT_MS) }); // nosemgrep
      const text = await r.text();
      log([new Date(t0).toISOString(), event, method, p, r.status, (Date.now() - t0) + 'ms']);
      notePolicy(url, p, r);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status + ' ' + text.slice(0, 80)), { status: r.status, body: text });
      noteHealthy(p);
      return text;
    } catch (e) {
      const detail = String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.message) || e);
      log([new Date(t0).toISOString(), event, method, p, 'FAIL', (Date.now() - t0) + 'ms', detail.slice(0, 80)]);
      // A name that does not resolve right after a reconnect is the one failure worth a second try (seen in the Docker proof).
      if (attempt < 2 && /ENOTFOUND|EAI_AGAIN|ECONNRESET/.test(detail)) { await sleep(300); continue; }
      if (e && typeof e === 'object' && !e.status) e.status = 0; // a network failure: status 0, as classify reads it
      if (!p.startsWith('/api/plugin/') && p !== '/api/data/last-message') { const k = classify(e); if (k === 'lapsed' || (k === 'refused' && e.status === 401) || (k === 'down' && (e.status === 0 || p === '/health') && !GAPS_ROUTE.test(p))) noteHealth(url, k, e); } // only what speaks for the whole platform is cached: no answer, a failed /health, a lapsed plan, a refused token (401); one route's 5xx or 403 is that call's own // the policy check says nothing of the platform's health: its 401 is answered by the normal handling of a refused token
      throw e;
    }
  }
}

// Whether this company keeps the session's last message (issue 86): the one question asked before it is sent, at session end and before a spooled outcome that holds it
// is replayed, never per tool call or per prompt. True only when the platform answers {"capture": true}; a failure, a timeout, a 404 from an older platform, a body that
// is not that, a missing token or a platform known unusable all answer false (the default is to send less). The answer is kept per address and token for LAST_MESSAGE_MS
// (turning the switch on reaches a machine within 5 minutes), a failed ask for LAST_MESSAGE_FAIL_MS; a request skipped for a known-unusable platform is not remembered here.
const LAST_MESSAGE_MS = 5 * 60 * 1000, LAST_MESSAGE_FAIL_MS = 60 * 1000, LAST_MESSAGE_TIMEOUT_MS = 3000;
const lastMessageFile = path.join(path.dirname(sessionCacheDir), 'last-message.json');
async function mayKeepLastMessage(url) {
  try {
    const c = readJson(lastMessageFile);
    const age = c ? Date.now() - (c.at || 0) : -1;
    if (c && c.url === url && (c.tk || '') === tokenTag && age >= 0 && age < (c.answered ? LAST_MESSAGE_MS : LAST_MESSAGE_FAIL_MS)) return c.capture === true;
    let capture = false, answered = false;
    try {
      const body = JSON.parse(await callAt(url, 'GET', '/api/data/last-message', undefined, LAST_MESSAGE_TIMEOUT_MS));
      if (body && typeof body === 'object' && typeof body.capture === 'boolean') { capture = body.capture; answered = true; }
    } catch (e) {
      if (e && e.skipped) return false;
      if (e && e.status === 404) answered = true; // an older platform keeps no setting: off, asked again in 5 minutes
    }
    writeJson(lastMessageFile, { url, tk: tokenTag, capture, answered, at: Date.now() });
    return capture;
  } catch (e) { return false; }
}
// A spooled outcome with the message cut away: the reason in the leading parenthesis stays (as the platform's own rule keeps it).
const SPOOL_PREFIX = '(recorded from the session\'s last message:';
function withoutLastMessage(what) {
  const end = what.indexOf(') ');
  return (end < 0 ? SPOOL_PREFIX.slice(0, -1) + ')' : what.slice(0, end + 1)) + ' The session\'s last message was not sent: this company\'s data settings leave it off, or could not be read.';
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
function writePaths(sid, seen) { try { mkdirp(sessionCacheDir); fs.writeFileSync(pathsFile(sid), JSON.stringify(seen)); } catch (e) { /* ignore */ } }
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
// Only the one line goes to the platform (the sender's summary, else the fixed words below): no part of the message itself, ever.
const AGENT_ID = /^a[0-9a-f]{8,}$/i;            // a raw agent id: an in-process subagent talking to its parent
const SUMMARY_MAX = 120;                        // the platform cuts to the same
const NO_SUMMARY = '(no summary)';              // a message sent with no summary: these words, never a piece of the message (0.2.21)
const CROSS_SESSION = /^\s*(?:[^<\n]{0,80}:[ \t]*\r?\n\s*)?<cross-session-message\b([^>]*)>/; // the wrapper at the start of a prompt, after at most the harness's own lead-in line (one line ending in a colon) and blank space
const ADDRESS = /^uds:|\\\\\.\\pipe\\|:\/\//i;  // a session's address on this machine, which names no one
function collapse(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }
// At most `max` characters, never ending on half an emoji; an ellipsis stands for what was cut (and counts in the max).
function cut(text, max) {
  if (text.length <= max) return text;
  let n = max - 1;
  if (/[\ud800-\udbff]/.test(text[n - 1] || '')) n--;
  return text.slice(0, n).trimEnd() + String.fromCharCode(0x2026);
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
    const summary = cut(collapse(ti.summary), SUMMARY_MAX) || NO_SUMMARY;
    found.push({ to: cut(to, SUMMARY_MAX), summary });
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
async function waitForNews(sid, call, url) {
  const lock = newsWaitFile(sid);
  if (waiterAlive(lock)) return;
  try { mkdirp(sessionCacheDir); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch (e) { return; }
  const until = Date.now() + WAIT_HOURS * 3600 * 1000;
  let peeked = 0, failures = 0, answered = false;
  try {
    while (Date.now() < until) {
      const mine = readJson(lock);
      if (!mine || mine.pid !== process.pid) return; // the session ended (session-end removes the lock), or another waiter took over
      if (stoodDown(url)) return;                                         // issue 90: stood down since this waiter started
      if (failures) await sleep(Math.min(60000, 5000 * failures)); // guidance-wait's backoff
      let text;
      try { text = await call('GET', '/api/sessions/' + enc(sid) + '/news/wait?wait=' + WAIT_SECONDS + '&peeked=' + peeked, undefined, (WAIT_SECONDS + 15) * 1000); failures = 0; }
      catch (e) {
        if (/HTTP 404/.test(String(e && e.message))) return;          // an older platform has no wait: nothing to hold
        if (!answered || ++failures > NEWS_WAIT_FAILURES) return;      // never reached, or down for long: the next batch tries again
        continue;
      }
      if (stoodDown(url)) return;                                         // the answer itself said so: no wake, no further poll
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
// A spooled file holds up to 4,000 characters of what the agent said last, so the spool is owner-only (external review, 2026-11-14, plugin 0.2.21): its folder is
// made 0700 and chmod-ed even when it exists (and, as the plugin, so is ~/.steerline above it), and each file is made empty at 0600 before the text is in it.
// On Windows the folder's inherited rights are removed and the current user is granted full control over it and what it will hold, once: a marker file in the folder
// says it was tried, so icacls is not run on every hook call. Best effort, never throwing: a hook fails open.
const OWNER_ONLY_MARK = '.owner-only';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:/Windows', 'System32'); // named in full: a Git Bash folder earlier on the path has its own whoami
// Keep in sync with pair.js (windowsAccount and its owner-only code): this is a copy, since the hook does not require another script.
function windowsAccount() { // the account's SID as icacls names it (as pair.js does), else DOMAIN\USERNAME
  try {
    const r = spawnSync(path.join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const sid = r.status === 0 ? (String(r.stdout).match(/"(S-1-[\d-]+)"/) || [])[1] : null;
    if (sid) return '*' + sid;
  } catch (e) { /* fall back */ }
  return process.env.USERDOMAIN && process.env.USERNAME ? process.env.USERDOMAIN + '\\' + process.env.USERNAME : null;
}
function ownerOnlyDir(dir) {
  const key = path.resolve(dir);
  if (ownerOnlyDone.has(key)) return; // once per folder per process: the folder, its mode and the marker are checked on the first write only
  ownerOnlyDone.add(key);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch (e) { /* a system without modes */ }
    if (process.platform !== 'win32') return;
    const mark = path.join(dir, OWNER_ONLY_MARK);
    if (fs.existsSync(mark)) return;
    const who = windowsAccount();
    const r = who ? spawnSync(path.join(SYSTEM32, 'icacls.exe'), [dir, '/inheritance:r', '/grant:r', who + ':(OI)(CI)F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }) : null;
    // The marker is written whether icacls worked or not, with the result in it: a home where icacls fails (a network share, say) would otherwise pay for whoami
    // and icacls, with their timeouts, on every hook call. Delete the marker to try again.
    fs.writeFileSync(mark, r && r.status === 0 ? 'ok' : 'failed');
  } catch (e) { /* ignore */ }
}
function writeOwnerOnly(file, text, dirs) {
  for (const d of dirs || (pluginMode ? [path.dirname(spoolDir), spoolDir] : [spoolDir])) ownerOnlyDir(d);
  fs.writeFileSync(file, '', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (e) { /* a system without modes */ }
  fs.writeFileSync(file, text);
}
function spool(entry) {
  try { writeOwnerOnly(spoolFile(entry.session), JSON.stringify(entry, null, 2)); } catch (e) { /* ignore */ }
}
function mark(sid, target, cwd) {
  try { writeOwnerOnly(markerFile(sid), JSON.stringify({ project: target.project, url: target.url, cwd, at: new Date().toISOString() })); } catch (e) { /* ignore */ }
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
      // A spooled last message is sent only when the company keeps it (asked once, then cached); the file on this machine keeps the text either way. An entry spooled under
      // another token (tk), or under none that was recorded (an older plugin's), is judged by a company's switch that may not be the one answering now: it is cut without asking.
      const what = typeof e.what === 'string' && e.what.startsWith(SPOOL_PREFIX) && (e.tk !== tokenTag || !(await mayKeepLastMessage(e.url || DEFAULT_URL))) ? withoutLastMessage(e.what) : e.what;
      await callAt(e.url || DEFAULT_URL, 'POST', '/api/sessions/' + enc(e.session) + '/outcomes', { what, project: e.project, cwd: e.cwd, at: e.at });
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
// env of its committed .claude/settings.json; without it this does nothing. A repository's settings are not the user's word, so since plugin 0.2.21
// (external review, 2026-11-14) the command runs only when the user approved this exact command string for this repository (its worktrees share one approval): the approval is
// a file in the user's home, ~/.steerline/trusted-tests.json, {"<main checkout's root, normalized>": {"command", "at"}}, made owner-only, written by
// `node platform-hook.js trust-tests` run in the repository (`--forget` removes it, `--command "<cmd>"` names the command when the environment
// does not). A command that is set but not approved, or changed since, does not run and does not block the stop: one notice, at most a day apart,
// says what the repository asks to run and how to approve it. It needs no platform. The tree's state (HEAD, status, the diff
// of tracked files, the contents of untracked ones) is fingerprinted, and the tests run only when it differs from the last green run; a
// failure blocks the stop with the tail of the output, once per state, so a session that cannot fix them is not held in a loop. A clean
// tree with no run on record whose HEAD is on a remote branch is taken as green (that branch's pipeline tested it), so a session that only
// reads never pays for the suite; a clean tree on local commits is tested. The test timeout stays under the hook's own (hooks.json, 900 s).
const TEST_TIMEOUT_S = 600;
const TEST_TIMEOUT_MAX_S = 870;
const TEST_OUTPUT_CHARS = 3000;
function treeState(root) {
  const run = (args) => { const r = spawnSync('git', ['-C', root].concat(args), { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
  const head = run(['rev-parse', 'HEAD']), status = run(['status', '--porcelain', '-uall']), diff = run(['diff', 'HEAD', '--binary']);
  const untracked = run(['ls-files', '--others', '--exclude-standard', '-z']);
  if (head === null || status === null || diff === null || untracked === null) return null;
  // git diff leaves untracked files out, so an edit to a new file would not change the state without their contents.
  const added = untracked.split('\0').filter(Boolean).map(f => { try { return f + '\0' + sha256(fs.readFileSync(path.join(root, f))); } catch (e) { return f; } }).join('\0');
  return { clean: status.trim() === '', print: sha256(head + '\0' + status + '\0' + diff + '\0' + added) };
}
// The user's approvals of test commands, kept beside the paired token and as private: one entry per repository root.
const trustedTestsFile = path.join(home, '.steerline', 'trusted-tests.json');
function readTrusted() { const t = readJson(trustedTestsFile); return t && typeof t === 'object' && !Array.isArray(t) ? t : {}; }
// An approval is for the repository, not one checkout of it: every worktree of a clone shares the key of its main checkout (the folder holding the common
// .git), so a new worktree does not ask again; the command must still match exactly. A submodule or an older git keeps its own root.
// One git call gives both the top level and the common dir (git 2.31 and later; --path-format first applies to both); an older git answers neither, and the
// top level is then asked alone and the common dir stays unknown.
function gitRoots(dir) {
  const both = git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']).split('\n').map(l => l.trim());
  if (both.length === 2 && both[0] && both[1]) return { root: both[0], common: both[1] };
  return { root: git(dir, ['rev-parse', '--show-toplevel']), common: '' };
}
function trustKey(root, common) {
  return norm(common && path.basename(common) === '.git' ? path.dirname(common) : root);
}
function testsTrusted(roots, command) { const e = readTrusted()[trustKey(roots.root, roots.common)]; return !!e && typeof e.command === 'string' && e.command === command; }
function writeTrusted(all) { writeOwnerOnly(trustedTestsFile, JSON.stringify(all, null, 2), [path.dirname(trustedTestsFile)]); }
const shown = (command) => collapse(command).slice(0, 300);
// The one notice for a command that is set and not approved, shown to the person (a systemMessage), never blocking; the same repository and command are
// not announced again for a day (a stamp beside the test states).
function tellNotTrusted(root, command, stateDir) {
  const stamp = path.join(stateDir, sha256(norm(root) + '\0' + command).slice(0, 16) + '.notice');
  try { const age = Date.now() - fs.statSync(stamp).mtimeMs; if (age >= 0 && age < 24 * 60 * 60 * 1000) return; } catch (e) { /* not told yet */ }
  try { mkdirp(stateDir); fs.writeFileSync(stamp, ''); } catch (e) { /* ignore */ }
  out({ systemMessage: 'Steerline: this repository asks to run `' + shown(command) + '` (its STEERLINE_TEST_COMMAND) at each stop, and it has not been approved on this machine, so it was not run. ' +
    'To approve exactly this command, run this yourself in your own terminal (an agent cannot approve it), in ' + root + ': node "' + __filename + '" trust-tests' });
}
// The manual command: approve (or, with --forget, withdraw the approval of) the current repository's test command. The command is --command, else the environment's,
// else what the repository's own settings set (a person's shell does not have the variable Claude Code gives its hooks); it is printed, so the person sees what they approved.
function readLine() {
  const buf = Buffer.alloc(1); let line = '';
  try { while (line.length < 1000 && fs.readSync(0, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]); } catch (e) { /* end of input */ }
  return line;
}
function trustTests(args) {
  const { root, common } = gitRoots(process.cwd());
  if (!root) return 'Run this in the repository whose tests you are approving (it is not inside a git repository here).';
  const all = readTrusted();
  const key = trustKey(root, common);
  if (args.includes('--forget')) {
    if (!(key in all)) return 'No test command was approved for ' + root + '.';
    delete all[key];
    try { writeTrusted(all); } catch (e) { return 'The approval could not be removed (' + (e && e.code ? e.code : 'write failed') + ').'; }
    return 'Forgot the approved test command for ' + root + '.';
  }
  // Approving needs a person at a terminal: Claude Code's Bash tool has no TTY, so an agent running this (say, told to by a repository's CLAUDE.md) is refused. The remaining
  // limit: anything running as the user can write the trust file directly; the TTY gate stops the agent's shell tool path and a repository instructing the agent to approve itself.
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) { process.exitCode = 1; return 'Not approved: approving a test command needs a terminal you type in, and this is not one. Run it yourself in a terminal, in ' + root + ':\n  node "' + __filename + '" trust-tests\nAn agent cannot approve it.'; }
  const at = args.indexOf('--command');
  let command = at >= 0 ? String(args[at + 1] || '') : process.env.STEERLINE_TEST_COMMAND || '';
  if (!command.trim() && at < 0) for (const f of ['settings.json', 'settings.local.json']) command = (((readJson(path.join(root, '.claude', f)) || {}).env || {}).STEERLINE_TEST_COMMAND || command);
  command = String(command).trim();
  if (!command) return 'No test command to approve: the repository sets no STEERLINE_TEST_COMMAND (or give one with --command "<command>").';
  process.stdout.write('Repository: ' + root + '\nTest command: ' + shown(command) + '\nIt would run at each stop. Type yes to approve it: ');
  if (readLine().trim().toLowerCase() !== 'yes') return 'Not approved; nothing was changed.';
  all[key] = { command, at: new Date().toISOString() };
  try { writeTrusted(all); } catch (e) { return 'The approval could not be saved (' + (e && e.code ? e.code : 'write failed') + ').'; }
  return 'Approved for ' + root + ': ' + shown(command) + '\nIt runs at each stop when the tree changed. If the repository changes the command, approve it again; node "' + __filename + '" trust-tests --forget withdraws this.';
}
function runTests(startDir) {
  const command = (process.env.STEERLINE_TEST_COMMAND || '').trim();
  if (!command) return;
  const roots = gitRoots(startDir), root = roots.root;
  if (!root) return;
  const stateDir = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(home, '.steerline', 'cache'), 'tests');
  if (!testsTrusted(roots, command)) { tellNotTrusted(root, command, stateDir); return; }
  const state = treeState(root);
  if (!state) return;
  const stateFile = path.join(stateDir, sha256(norm(root)).slice(0, 16) + '.json');
  const last = readJson(stateFile);
  const save = (s) => { try { mkdirp(path.dirname(stateFile)); fs.writeFileSync(stateFile, JSON.stringify(Object.assign({ root }, s))); } catch (e) { /* ignore */ } };
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

// ---- The platform's tools when the platform cannot be used (issue 91) ---------------------------------------------------------------------
// An unattended session (a runner job, a -p or SDK run) has nobody to ask; the interactive CLI and the VS Code and desktop apps do. An unknown entry point counts as unattended.
const ATTENDED_ENTRYPOINTS = ['cli', 'claude-vscode', 'claude-desktop'];
// A runner's job is a background CLI session ('cli' too) that nobody watches: it is known by the job token the runner writes as the plugin's token default (decision #517).
const attended = () => ATTENDED_ENTRYPOINTS.includes(process.env.CLAUDE_CODE_ENTRYPOINT) && !pluginDefaultToken;
// What to tell the model about a question that could not be filed. kind: the trouble's classification; line: its plain words.
function questionText(kind, line) {
  const why = kind === 'down' ? 'Steerline was unreachable' : kind === 'slow' ? 'Steerline asked this machine to slow down (429)' : line.replace(/\s*This session works without it\.$/i, '').replace(/[.;]$/, '');
  if (attended()) {
    const opener = kind === 'down' ? 'Steerline was unreachable, so I am asking you here.' : 'Steerline is not available to this session, so I am asking you here.';
    return why + ', so this question was not filed. Ask the person here in the chat, starting your message with the line "' + opener + '" and end your turn to wait for the answer; ' +
      'if it is a checkpoint (money, anything sent off the machine, deleting, production) do nothing further until they answer. Do not proceed on your recommendation.';
  }
  return why + ' and nobody is here to ask. Stop now: do no further work, and put the question, the options and what you were about to do in your final message.';
}
// What a skipped recording tool says.
function skipText(kind, line) {
  return kind === 'down' ? 'Steerline is unreachable, so this call is skipped; carry on without it and do not retry.' : line + ' This call is skipped; do not retry.';
}
// Why a platform tool call is denied before it is made, or '' to let it through. A question is checked with a quick /health probe when nothing is known;
// a recording tool is only skipped on what the health cache already says, so a healthy platform costs it nothing.
async function gateReason(sid, tool, url) {
  if (noNetwork) return tool === 'ask_guidance' ? questionText('refused', NO_TOKEN_LINE) : NO_TOKEN_LINE + ' This call is skipped; do not retry.';
  let h = knownTrouble(url);
  // No platform tool is denied on a remembered 'down' alone: one dropped connection on any route (a long poll cut by a laptop waking) writes it, so the probe
  // below decides, and clears it when the platform answers. A question is probed even with nothing remembered; a recording tool only then, so a healthy platform costs it nothing.
  const wasDown = !!h && h.state === 'down';
  if (wasDown) h = null;
  let kind = h && h.state, status = h && h.status, owner = h && h.owner;
  if (!h && (tool === 'ask_guidance' || wasDown)) {
    try { await callAt(url, 'GET', '/health', undefined, 3000); return ''; }
    catch (e) { kind = classify(e); status = e && e.status; owner = ownerOf(e && e.body); if (kind !== 'down') return ''; }
  }
  if (!kind) return '';
  const line = lineFor(kind, status, owner);
  if (tool === 'ask_guidance') return questionText(kind, line);
  gap(sid);
  return skipText(kind, line);
}
// PostToolUseFailure of a platform tool: the call failed after the pre-check let it through. A failure text that says the platform was unreachable, the plan
// lapsed or the token refused is classified, remembered (the health cache) and answered with the same words, so the model neither retries nor proceeds
// on a question that was never filed. Any other failure is the tool's own and is left alone.
function toolFailed(sid, input, url) {
  const tool = bare(input.tool_name);
  if (!tool || input.is_interrupt) return;
  const text = String(input.error || input.tool_response || '');
  // A status counts only where the text says it is one (HTTP 402, status 401): an item number in the tool's own error ("Guidance #402 is already answered") is not a status.
  const http = (n) => new RegExp('\\b(?:HTTP(?:/\\d(?:\\.\\d)?)?|status(?: code)?)\\W{0,3}' + n + '\\b', 'i').test(text);
  const kind = http(402) || /plan_lapsed|payment required/i.test(text) ? 'lapsed' : http(401) || http(403) || /unauthorized|forbidden/i.test(text) ? 'refused' : http(429) || /too many requests/i.test(text) ? 'slow'
    : /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|unreachable|could not connect|connection (refused|closed|reset)|network error/i.test(text) ? 'down' : null;
  if (!kind) return;
  const status = kind === 'lapsed' ? 402 : kind === 'slow' ? 429 : kind === 'refused' ? (http(403) || /forbidden/i.test(text) ? 403 : 401) : 0;
  const owner = kind === 'lapsed' ? ownerOf((/\{[^{}]*\}/.exec(text) || [''])[0]) : '';
  // The MCP connection carries a paired token even where the hooks use a typed one (pair.js headers cannot see the plugin's option; a runner's job copy is never
  // given one). Its 401 is then the paired token's and says nothing of the hooks' own: no health entry, which would hold their calls off for ten minutes.
  const mcpPairedAddress = kind === 'refused' && status === 401 && pluginMode && explicitToken && !pluginDefaultToken && safeForToken(url) ? addressKey(url) : null;
  const mcpPaired = !!pairedFor(mcpPairedAddress);
  if (!mcpPaired && (kind !== 'refused' || status === 401)) noteHealth(url, kind, { status, body: owner ? JSON.stringify({ owner }) : '' });
  const line = mcpPaired ? pairAgainLine(mcpPairedAddress) : lineFor(kind, status, owner);
  let context;
  if (tool === 'ask_guidance') context = questionText(kind, line);
  else { gap(sid); context = skipText(kind, line); }
  out({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: context } });
}

async function main() {
  if (event === 'version') { process.stdout.write(VERSION + '\n'); return; }
  if (event === 'trust-tests') { process.stdout.write(trustTests(process.argv.slice(3)) + '\n'); return; }
  if (event === 'replay') { const n = await replay(); process.stdout.write(n + ' spooled outcome(s) sent\n'); return; }

  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) { input = {}; }
  const sid = input.session_id || 'unknown';
  // The session's project is that of the folder it started in; input.cwd follows the agent's cd and may be elsewhere.
  const startDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const cwd = input.cwd || startDir;
  // issue 90: stood down by the platform, every event does nothing, except inject-session: it needs only local state (no platform call), and the
  // platform's own tools keep working if the model calls them. A stop is never held while stood down.
  // issue 91: with no token this makes no network call at all (callAt refuses too); the one line is for a repository that names Steerline, at most once a day.
  // Plugin 0.2.21: a token for an address that is neither https nor this machine is never sent, by the hooks (headersFor) or by the MCP connection (pair.js headers); say so once at session start.
  if (event === 'session-start' && pluginMode && token && !safeForToken(baseUrl())) process.stdout.write('Steerline: the address ' + baseUrl().replace(/\/\/[^/@]*@/, '//') + ' is plain http, not https and not this machine, so your token was not sent to it, by the hooks or by the MCP connection (which was given a refused header instead). Set an https address (/plugin, Steerline, configure).'+String.fromCharCode(10));
  if (noNetwork && event !== 'tests' && event !== 'inject-session') {
    if (event === 'session-start' && namesSteerline(startDir) && noTokenLineDue()) process.stdout.write(NO_TOKEN_LINE);
    return;
  }
  const stood = await standDown(baseUrl());
  if (stood && event !== 'inject-session') return;
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
      try { mkdirp(sessionCacheDir); fs.writeFileSync(beatFile, ''); } catch (e) { /* ignore */ }
      beat = { seen, edits, reads };
    }
    // Nothing to send, and a waiter already holds this session's long poll (decision #1157): done, at the cost of one stat and one read.
    else if ((event !== 'batch' || waiterAlive(newsWaitFile(sid))) && handoffs.length === 0) return;
  }
  let target = resolveProject(startDir);
  // The health cache is kept per address, and the project's own address is the one its calls go to (a platform.json may name another than baseUrl()).
  if (event === 'tool-failed') { toolFailed(sid, input, target ? target.url : baseUrl()); return; }
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
    // Issue 91: a platform tool is let through only when the platform can be used. Otherwise the hook speaks, since the call itself would fail into the
    // model's own judgment: a recording tool is skipped (and counted), a question goes to the person in the chat, or stops an unattended session.
    // A call let through here that then fails at the network is outside this hook's control; the tool-failed hook gives the same words after it.
    if (!stood && tool) {
      const reason = await gateReason(sid, tool, target ? target.url : baseUrl());
      if (reason) { out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }); return; }
    }
    if (tool === 'ask_guidance' && process.env.CLAUDE_CODE_ENTRYPOINT === 'cli') extra.waits = true;
    out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'platform tool; session id and project attached by hook', updatedInput: Object.assign({}, ti, extra) } });
    return;
  }

  if (!target) {
    // A folder the platform cannot place (#494): one line at session start, nothing else, so an unrelated repository never lands in a ledger.
    if (pluginMode && event === 'session-start') {
      const c = readCache(sid) || {};
      const why = c.why || 'it resolves to no project';
      if (c.quiet) return; // the repository's settings do not name Steerline: the plugin is on for another reason, and says nothing here
      if (c.unreachable && c.kind && c.kind !== 'down') { if (toldOnce(sid, c.kind)) process.stdout.write(lineFor(c.kind, c.status, c.owner)); return; }
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
      const old = outdatedLine(url, sid);
      if (old) brief = old + '\n' + brief;
      process.stdout.write(capContext(brief));
      await reportGaps(sid, call); // a restarted session (clear, compact) with a count kept from before: the registration just succeeded
    } catch (e) {
      mark(sid, target, cwd);
      const kind = classify(e);
      // A 429 here did cost something, unlike on a later call: the brief of this start. The line says so, and how to get it.
      if (kind === 'lapsed' || kind === 'refused' || kind === 'slow') { if (toldOnce(sid, kind)) process.stdout.write(lineFor(kind, e.status, ownerOf(e.body)) + (kind === 'slow' ? ' Only the brief is missing from this start: read it with the get_brief tool before you work.' : '')); return; }
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
      const old = outdatedLine(url, sid);
      if (news || old) process.stdout.write(capContext((old ? old + '\n' : '') + (news ? 'Steerline news since this session last looked (the brief it was given at start is in its history): ' + news : '')));
      await reportGaps(sid, call);
    } catch (e) {
      mark(sid, target, cwd);
    }
    return;
  }

  if (event === 'batch' || event === 'heartbeat') {
    // The line about each handoff, never the message (agent-platform #45); fail open, like every call here.
    for (const h of handoffs) {
      try { await call('POST', '/api/sessions/' + enc(sid) + '/handoffs', { kind: 'sent', to: h.to, summary: h.summary }); } catch (e) { dropped(sid, e); /* unreachable, or an older platform: the handoff is not on the record */ }
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
      } catch (e) { dropped(sid, e); return; /* unreachable, or an older platform: the next heartbeat carries them; the tools still refresh the heartbeat */ }
      // The heartbeat is the one recording call that is both frequent and not waited on (an async hook), so it carries the report of the calls dropped before it.
      await reportGaps(sid, call);
    }
    // Stay behind as the session's one waiter for a signal addressed to it, such as its branch's merge request verdict (decisions #1157, #3226).
    if (event !== 'batch') return; // the PostToolUse heartbeat of an older hooks.json is not an async hook: it holds no waiter
    await waitForNews(sid, call, url);
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
    const received = from === null ? null : call('POST', '/api/sessions/' + enc(sid) + '/handoffs', { kind: 'received', from }).catch((e) => { dropped(sid, e); /* fail open */ });
    try {
      const r = JSON.parse(await call('POST', '/api/sessions/' + enc(sid) + '/prompts?news=1', {}));
      if (r && r.continued) notes.push('Steerline: your intent #' + r.continued + (r.what ? ' ("' + String(r.what).slice(0, 120) + '")' : '') + ' is open again for this prompt. If this is other work, declare a new intent first; record an outcome when it is done.');
      // The unseen news rides back with the answer (decision #1151): what landed while the session sat idle, before it starts on this.
      if (r && r.news) notes.push(String(r.news).trim());
    } catch (e) {
      dropped(sid, e); // fail open: the prompt is not recorded, and a lapsed plan or a refused token is said once
      const kind = classify(e);
      if ((kind === 'lapsed' || kind === 'refused' || kind === 'slow') && toldOnce(sid, kind)) notes.push(lineFor(kind, e.status, ownerOf(e.body)));
    }
    if (received) await received;
    else if (PREFERENCE.test(String(input.prompt || ''))) notes.push(PREFERENCE_REMINDER);
    if (notes.length) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: capContext(notes.join(' ')) } });
    return;
  }

  if (event === 'session-end') {
    // The session ended (decision #791): its open intent closes, with an outcome from its last message where work followed the last one, and
    // its news waiter, if one is held, sees the lock gone and ends (decision #1157).
    unlinkQuietly(newsWaitFile(sid));
    // The last message is read and sent only when the platform says this company keeps it (issue 86): on any doubt the field is left out.
    try {
      const keep = await mayKeepLastMessage(url);
      await call('POST', '/api/sessions/' + enc(sid) + '/end', { reason: input.reason || 'other', lastMessage: keep ? lastAssistantText(input.transcript_path) : undefined });
      await reportGaps(sid, call);
    } catch (e) { dropped(sid, e); /* fail open: the intent expires as before */ }
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
    // Issue 91: a lapsed plan or a refused token is remembered, and /health, which is open, cannot see either: ask_guidance would be denied, so
    // the question tool is not turned away for it and asks the person. A remembered 'down' is only a hint: the probe below decides.
    const known = knownTrouble(url);
    if (known && known.state !== 'down') return;
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
      if (stoodDown(url)) return; // issue 90: stood down while this wait was held; no wake, no further poll
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
      spool({ session: sid, project, cwd, url, tk: tokenTag, at: new Date().toISOString(), what: '(' + why + ') ' + (lastText() || 'no outcome text was captured') });
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
