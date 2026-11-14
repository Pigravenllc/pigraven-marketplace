---
description: Pair this machine with Steerline using a code from the Pair a machine page
argument-hint: <code> | --forget
---

The person wants to pair this machine with their Steerline, or to forget the pairing. First check that `$ARGUMENTS` is empty, is `--forget`, or consists only of letters, digits and hyphens; if it holds anything else (a space, quote, semicolon, `$`, `|`, `&`, a backtick), do not run anything and tell the person the code looks wrong. Otherwise run this one command with the Bash tool and nothing else, keeping the address and the argument inside their single quotes exactly as written (pair.js checks the argument again and refuses anything but a code or `--forget`, and uses the plugin's own address when the one here is empty or still a placeholder), then tell the person in one or two plain sentences what it printed:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/pair.js" --url '${user_config.url}' '$ARGUMENTS'
```

- `$ARGUMENTS` is the code from the Pair a machine page on their Steerline (a code such as ABCD-EFGH that works once, for 10 minutes), or `--forget` to remove the token this machine keeps.
- Do not read, print or search for any file the command writes, and do not repeat the code.
- If `$ARGUMENTS` is empty, tell the person to open the Pair a machine page on their Steerline (`/pair`), press Get a code, and run `/steerline:pair <code>`.
- When it succeeds, tell the person to restart Claude Code, so the session and its Steerline tools use the new token.
- When it fails, say what it printed and stop; do not try again with another code unless the person gives one.
