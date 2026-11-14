# Steerline marketplace

The Claude Code marketplace for the Steerline plugin. Its id is `steerline` and it holds one plugin, `steerline`, which connects every Claude Code session in an enrolled repository to your team's Steerline: a brief at start, intents and outcomes recorded, questions sent to the person who owns the decision, and the decisions in scope.

## Install

```
claude plugin marketplace add Pigravenllc/pigraven-marketplace
claude plugin install steerline@steerline
```

Then give the plugin your Steerline's address and a token from its team page: `/plugin`, Steerline, configure. The token is kept in your system's secure credential store and is sent only over https or to your own machine.

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

## Updates

An installed copy updates when the plugin's `version` in `plugin/.claude-plugin/plugin.json` changes.

## License

MIT, see [LICENSE](LICENSE).
