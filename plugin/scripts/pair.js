#!/usr/bin/env node
// Pair this machine with Steerline (agent-platform issue 78, part 2). MIT, no dependencies, node's own fetch.
//   node pair.js <code> [--url <address>]   trade the code from the platform's /pair page for a personal token and keep it on this machine
//   node pair.js --forget [--url <address>] forget the token kept for the address
//   node pair.js headers                    the plugin's MCP connection asks this for its headers (headersHelper in .mcp.json): prints
//                                           {"Authorization":"Bearer <token>"} for the paired address, or {} when there is nothing to add; for an address that is
//                                           not https or this machine, a refusing Authorization that overrides .mcp.json's, so no token goes over http
// WHERE THE TOKEN LIVES: ~/.steerline/paired.json, one file per user, outside every repository, beside the spool the hook already keeps there.
// It is {"<address>": {"token", "person", "company", "machine", "at"}}: the token is only ever read for the address it was paired with, and
// only sent over https or to this machine. The file is made owner-only (mode 0600; on Windows the inherited rights are removed and the
// current user is granted full control, which is as far as the file system goes without a keychain). The token is never printed, logged, put
// in a URL or on a command line; the code is typed by the person as an argument, which is fine for a code that works once, for 10 minutes.
// The file format and the address key are read by the hook script (platform-hook.js) too; keep them the same in both.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
const pairedFile = path.join(home, '.steerline', 'paired.json');
const DEFAULT_URL = 'http://localhost:5311';
const TIMEOUT_MS = 15000;
const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{3,31}$/; // a code is eight letters and digits, shown with a hyphen; nothing a shell could split or expand, and never an option (--help)
// A name the platform sent, as a few plain words: it is printed where the model reads it.
function plain(s) { return typeof s === 'string' ? s.replace(/[^\p{L}\p{N} .'@_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) : ''; }

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
// An address as the file's key: scheme, lower-case host and port, path without a trailing slash. Null when it is not an http(s) address.
function addressKey(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (e) { return null; }
}
function isLoopback(url) { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch (e) { return false; } }
// The token goes only over https or to this machine.
function safeForToken(url) { try { return new URL(url).protocol === 'https:' || isLoopback(url); } catch (e) { return false; } }

function readAll() { const all = readJson(pairedFile); return all && typeof all === 'object' && !Array.isArray(all) ? all : {}; }
// The paired entry for an address, or null.
function readPaired(url) {
  const key = addressKey(url);
  const e = key ? readAll()[key] : null;
  return e && typeof e.token === 'string' && e.token ? e : null;
}
// The Windows tools are named in full: a Git Bash folder earlier on the path has its own whoami.
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
// Who this process is on Windows, as icacls can name it: the account's SID from whoami (a bare USERNAME can name another account of the same name, a local
// one beside a domain one), else DOMAIN\USERNAME. Null when neither is known.
function windowsAccount() {
  try {
    const r = spawnSync(path.join(SYSTEM32, 'whoami.exe'),['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const sid = r.status === 0 ? (String(r.stdout).match(/"(S-1-[\d-]+)"/) || [])[1] : null;
    if (sid) return '*' + sid;
  } catch (e) { /* fall back */ }
  return process.env.USERDOMAIN && process.env.USERNAME ? process.env.USERDOMAIN + '\\' + process.env.USERNAME : null;
}
// Owner-only: 0600 on a system that has modes; on Windows, drop the inherited rights and grant the current user alone. Best effort, never throws.
let aclFailed = false; // set when the Windows rights step did not succeed; the success text then says so
function ownerOnly(file) {
  try { fs.chmodSync(file, 0o600); } catch (e) { /* not supported */ }
  if (process.platform !== 'win32') return;
  try {
    const who = windowsAccount();
    const r = who ? spawnSync(path.join(SYSTEM32, 'icacls.exe'),[file, '/inheritance:r', '/grant:r', who + ':F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }) : null;
    if (!r || r.status !== 0) aclFailed = true;
  } catch (e) { aclFailed = true; }
}
// Writes the whole file through a new file of its own, owner-only before the token is in it, so a half-written or readable file never exists.
function writeAll(all) {
  fs.mkdirSync(path.dirname(pairedFile), { recursive: true, mode: 0o700 });
  const tmp = pairedFile + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, '', { mode: 0o600 });
    ownerOnly(tmp);
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, pairedFile);
  } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ } throw e; }
}

// The plugin's address: an explicit one, then the plugin's option (the command passes it), the environment, the plugin's own default.
function pluginManifest() { return readJson(path.join(process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..'), '.claude-plugin', 'plugin.json')) || {}; }
function defaultUrl() {
  const m = pluginManifest();
  return process.env.CLAUDE_PLUGIN_OPTION_URL || process.env.PLATFORM_URL || ((m.userConfig || {}).url || {}).default || DEFAULT_URL;
}

// What went wrong, in plain words and never with the code in them.
function failure(status, base) {
  if (status === 400) return 'That code is wrong, was used already or has expired. Get a new one at ' + base + '/pair and try again.';
  if (status === 429) return 'Too many tries from this address. Wait a minute, then try again with a fresh code from ' + base + '/pair.';
  if (status === 413) return 'The platform refused the request as too large.';
  if (status === 404) return 'The platform at ' + base + ' does not support pairing yet. Update the platform, or use steerline login with a token from the team page.';
  if (status >= 300 && status < 400) return 'The platform at ' + base + ' answered with a redirect, which pairing does not follow (the code would go to another address). Set the plugin to the address it redirects to, then try again.';
  if (status === 0) return 'Could not reach the platform at ' + base + '. Check the address and your network, then try again.';
  return 'The platform at ' + base + ' answered HTTP ' + status + ', so nothing was saved.';
}

async function pair(code, url) {
  const key = addressKey(url);
  if (!key) return { ok: false, text: 'That is not an http or https address: ' + String(url).slice(0, 80) };
  if (!safeForToken(key)) return { ok: false, text: 'Refusing ' + key + ': over plain http the token would travel in clear text. Use https; http is only for this machine.' };
  const version = String(pluginManifest().version || 'unknown');
  let r, text;
  try {
    r = await fetch(key + '/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Steerline-Plugin': version, 'X-Steerline-Hook': 'pair' }, body: JSON.stringify({ code, machine: os.hostname().slice(0, 60), client: 'claude-code-plugin ' + version }), redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }); // nosemgrep (a redirect is not followed: it would send the code to another address)
    text = await r.text();
  } catch (e) { return { ok: false, text: failure(0, key) }; }
  if (!r.ok) return { ok: false, text: failure(r.status, key) };
  let body;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (!body || typeof body.token !== 'string' || !body.token) return { ok: false, text: 'The platform at ' + key + ' answered without a token, so nothing was saved.' };
  // The token is kept under the address the code was traded at, never under one the answer names: it can only ever be sent back there.
  const all = readAll();
  all[key] = { token: body.token, person: plain(body.person && body.person.name), company: plain(body.company), machine: os.hostname().slice(0, 60), at: new Date().toISOString() };
  // The code is spent and the platform lists this machine, though nothing here holds its token.
  try { writeAll(all); } catch (e) { return { ok: false, text: 'Paired, but the token could not be saved on this machine (' + (e && e.code ? e.code : 'write failed') + '). Nothing was kept: revoke this machine on ' + key + '/pair, then try again with a new code.' }; }
  const who = all[key].person ? ' as ' + all[key].person : '';
  const where = all[key].company ? ' (' + all[key].company + ')' : '';
  return { ok: true, text: 'Paired ' + key + who + where + '. Restart Claude Code so this session and its Steerline tools use the new token. The token stays on this machine; /steerline:pair --forget removes it, and you can revoke this machine on ' + key + '/pair.' + (aclFailed ? " Note: this machine would not limit the file's rights to your user alone, so it keeps the rights of your profile folder." : '') };
}

function forget(url) {
  const key = addressKey(url);
  const all = readAll();
  if (!key || !(key in all)) return { ok: true, text: 'No paired token is kept for ' + (key || url) + '.' };
  delete all[key];
  try { writeAll(all); } catch (e) { return { ok: false, text: 'The token could not be removed (' + (e && e.code ? e.code : 'write failed') + ').' }; }
  return { ok: true, text: 'Forgot the paired token for ' + key + ' on this machine. To end it on the platform too, revoke the machine at ' + key + '/pair. Restart Claude Code.' };
}

// A header the server will refuse, printed for an address that is neither https nor this machine. Claude Code lets a helper's header override the static
// header of the same name, so this replaces .mcp.json's `Authorization: Bearer ${user_config.token}`: the typed token, which the helper cannot see, is never
// sent over plain http (external review, 2026-11-14). It holds no part of any token.
const INSECURE_HEADERS = { Authorization: 'Bearer refused-insecure-address' };
// What the MCP connection adds to its headers. For an address that is not https (and not this machine) the refusing header above, decided before anything is read.
// Otherwise nothing when the plugin's own token default is set (a runner's job copy: the job's token must stay the job's),
// when no token was paired for this address, or when anything goes wrong: the static headers of .mcp.json then stand. The one trade-off: a token typed
// into the plugin's option cannot be seen from here (a helper runs without credential variables), so a paired token wins on the MCP connection.
function headers() {
  const server = String(process.env.CLAUDE_CODE_MCP_SERVER_URL || '').replace(/\/mcp\/?$/, '');
  if (!safeForToken(server)) return INSECURE_HEADERS; // also an empty or unreadable address: nothing is sent where it cannot be shown safe (safeForToken never throws)
  try {
    if (((pluginManifest().userConfig || {}).token || {}).default) return {};
    const e = readPaired(server);
    return e ? { Authorization: 'Bearer ' + e.token } : {};
  } catch (e) { return {}; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'headers') { process.stdout.write(JSON.stringify(headers())); return 0; }
  let url = null, code = null, forgetting = false, bad = false;
  // Only a code, --forget and --url <address> are accepted, whatever the command line holds (a command can hand over what the person typed): anything else is
  // refused before any request and is not echoed.
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && i + 1 < args.length) url = args[++i];
    else if (args[i] === '--forget') forgetting = true;
    else if (args[i] === '') continue; // the command's quoted, empty argument
    else if (!code && CODE_SHAPE.test(args[i])) code = args[i];
    else bad = true;
  }
  if (bad || (forgetting && code)) { process.stderr.write('That does not look like a pairing code: it is letters and digits with a hyphen, like WXYZ-2345. Get one on the Pair a machine page, or use --forget.\n'); return 1; }
  // The command passes the option as ${user_config.url}; an unset option can arrive as an empty string or the placeholder itself.
  if (!url || /^\$\{/.test(url)) url = defaultUrl();
  const r = forgetting ? forget(url) : code ? await pair(code, url) : { ok: false, text: 'Usage: /steerline:pair <code> (a code from the Pair a machine page on your Steerline), or /steerline:pair --forget.' };
  (r.ok ? process.stdout : process.stderr).write(r.text + '\n');
  return r.ok ? 0 : 1;
}

if (require.main === module) main().then(c => { process.exitCode = c; }, () => { process.stderr.write('Pairing failed.\n'); process.exitCode = 1; });
