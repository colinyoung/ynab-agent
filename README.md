# ynab-agent

Agent-first YNAB tooling: a CLI and MCP server backed by a local SQLite mirror.

Why a mirror? YNAB rate-limits at 200 requests/hour. Agents are chatty. So API access
happens once via cheap delta sync (`last_knowledge_of_server`), and every analytical
query runs locally against SQLite — fast, free, offline.

## Requirements

- Node >= 22.13 (uses the built-in `node:sqlite` — zero native dependencies)
- A YNAB Personal Access Token: https://app.ynab.com/settings/developer

## Setup

```sh
npm install
npm run build
export YNAB_TOKEN=<your token>

node dist/cli/index.js budgets                 # find your budget id (or use "last-used")
node dist/cli/index.js config set budgetId <id>

# expense floor is a dated schedule: each month's actuals are compared
# against the floor in effect at that time
node dist/cli/index.js config set-floor 2026-01 13705
node dist/cli/index.js config set-floor 2030-07 21500   # e.g. post-house-purchase
node dist/cli/index.js sync                    # first sync is full; subsequent are deltas
```

Optionally `npm link` to get `ynab-agent` and `ynab-agent-mcp` on your PATH.

## CLI

```sh
ynab-agent sync                                      # delta-sync into SQLite mirror
ynab-agent accounts                                  # balances
ynab-agent tx list --since 2026-01 --category Dining --json
ynab-agent tx list --payee Legoland --min 50
ynab-agent spend --months 6                          # monthly outflow/inflow/net
ynab-agent spend --by category --months 3
ynab-agent observe                                   # drift report to stdout
ynab-agent observe --sync --write observed.md        # refresh + write for skill ingestion
```

`--json` on any command gives agent-friendly output. Amounts are YNAB milliunits
unless suffixed `_usd`.

## MCP server

Stdio transport. Register in your MCP client:

```json
{
  "mcpServers": {
    "ynab": {
      "command": "node",
      "args": ["/path/to/ynab-agent/dist/mcp/server.js"],
      "env": { "YNAB_TOKEN": "..." }
    }
  }
}
```

Tools: `ynab_sync`, `ynab_list_transactions`, `ynab_spend_summary`,
`ynab_list_accounts`, `ynab_observe`.

## The observe loop (skill integration)

`ynab-agent observe` renders `observed.md`: trailing-3-month actual outflow vs your
modeled expense floor, category drift, and large-transaction flags. The intent is a
split-brain skill design: static facts live in your LLM skill file; daily-changing
reality lives in `observed.md`, regenerated on a schedule. See
[docs/skill-integration.md](docs/skill-integration.md).

## Layout

```
src/core/     API client (backoff + jitter), SQLite schema, delta sync, queries
src/cli/      commander CLI
src/mcp/      MCP stdio server over the same core
src/observe/  observed.md generator
src/events/   (stub) transaction→life-event clustering + photos enrichment
```

## Notes

- Split transactions are resolved to their subtransaction categories via the
  `effective_tx` view, so category math is correct.
- Spend queries exclude transfers and off-budget (tracking) accounts.
- The SQLite mirror lives at `~/.local/share/ynab-agent/ynab.db` by default.
- `node:sqlite` prints an ExperimentalWarning on Node 22; harmless. Use
  `NODE_NO_WARNINGS=1` to silence.
