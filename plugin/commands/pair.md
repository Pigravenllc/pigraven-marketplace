---
description: Pair this machine with Steerline using a code from the Pair a machine page
argument-hint: <code> [<address>] | --forget
---

The person wants to pair this machine with their Steerline, or to forget the pairing. First check that `$ARGUMENTS` is empty, is `--forget`, or is a code of letters, digits and hyphens, optionally followed by one space and one address of the Steerline the code came from (it starts with `https://`, or `http://` only for `localhost`, `127.0.0.1` or `[::1]`, and holds only letters, digits and `.` `:` `/` `-` `_` `~`, with `[` `]` only around `::1`); if it holds anything else (a second space, quote, semicolon, `$`, `|`, `&`, a backtick), do not run anything and tell the person the code or address looks wrong. Otherwise run this one command with the Bash tool and nothing else, keeping the address and the argument inside their single quotes exactly as written (pair.js checks the argument again and refuses anything but a code, an address after it, or `--forget`, and uses the plugin's own address when the one here is empty or still a placeholder), then tell the person in one or two plain sentences what it printed:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.js" --url '${user_config.url}' '$ARGUMENTS'
```

- `$ARGUMENTS` is the code from the Pair a machine page on their Steerline (a code such as ABCD-EFGH that works once, for 10 minutes), followed by that Steerline's address when the page shows one (`/steerline:pair ABCD-EFGH https://staging.example`; the address wins over the plugin's own), or `--forget` to remove the token this machine keeps.
- Do not read, print or search for any file the command writes, and do not repeat the code.
- If `$ARGUMENTS` is empty, tell the person to open the Pair a machine page on their Steerline (`/pair`), press Get a code, and run the command the page shows, `/steerline:pair <code>` (with the page's address after the code when it shows one).
- When it succeeds, tell the person to restart Claude Code, so the session and its Steerline tools use the new token. If it says the plugin still connects to another address, give the one step it names: set the plugin's Steerline address to the address it paired (in Claude Code: `/plugin`, Steerline, configure, "Steerline address"), then restart; until then this session still talks to the other Steerline.
- When it fails, say what it printed and stop; do not try again with another code unless the person gives one.
