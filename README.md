# Steerline marketplace

The Claude Code marketplace for the Steerline plugin. Its id is `steerline` and it holds one plugin, `steerline`, which connects every Claude Code session in an enrolled repository to your team's Steerline: a brief at start, intents and outcomes recorded, questions sent to the person who owns the decision, and the decisions in scope.

## Install

```
claude plugin marketplace add Pigravenllc/pigraven-marketplace
claude plugin install steerline@steerline
```

The plugin talks to the hosted Steerline at https://steerline.pigraven.com unless you give it another address (`/plugin`, Steerline, configure). Pair this machine: open the Pair a machine page on your Steerline (https://steerline.pigraven.com/pair), press Get a code, and run `/steerline:pair <code>` in Claude Code. The code works once, for 10 minutes; restart Claude Code afterwards. `/steerline:pair --forget` removes the pairing. A token from the team page, entered in the same configure screen, works too: it is kept in your system's secure credential store. The plugin sends a token only over https or to your own machine.

## Enroll a repository

A repository is enrolled by two keys in its committed `.claude/settings.json`, so every session started there loads the plugin:

```json
{
  "extraKnownMarketplaces": {
    "steerline": { "source": { "source": "github", "repo": "Pigravenllc/pigraven-marketplace" } }
  },
  "enabledPlugins": { "steerline@steerline": true }
}
```

## What runs on your machine

The plugin's hooks are a Node script that Claude Code runs at session events. They talk only to your Steerline address.

Your token is sent only over https, or to your own machine (localhost). If the address is plain http to another machine, the plugin withholds the token from the hooks and the MCP connection, and says so at session start.

A repository may set `STEERLINE_TEST_COMMAND` in its `.claude/settings.json`. At the end of a turn the plugin runs that shell command in the repository, but only after you approve that exact command for that repository yourself, in your own terminal: `node <plugin folder>/scripts/platform-hook.js trust-tests`. It shows the command and asks you to type yes; an agent cannot approve it. Worktrees of the same clone share the approval. If the repository changes the command, it does not run until you approve it again. `trust-tests --forget` withdraws it.

The plugin keeps its files in `~/.steerline` (a paired token, outcomes it could not send yet, and test approvals), readable only by your user.

## Updates

An installed copy updates when the plugin's `version` in `plugin/.claude-plugin/plugin.json` changes.

## License

MIT, see [LICENSE](LICENSE).
