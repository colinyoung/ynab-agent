# Skill integration: the observe loop

The pattern: your skill file holds **static** facts (compensation, milestones, modeling
conventions). `observed.md` holds **live** facts (actual spend, drift, flags), regenerated
daily. The skill instructs the model to fetch `observed.md` before answering anything
quantitative, and to trust actuals over modeled assumptions when they conflict.

## Add to your SKILL.md

```markdown
## Live data (fetch before answering)

Before any quantitative answer, fetch the latest observed actuals:
<OBSERVED_MD_URL_OR_PATH>

Rules:
- If actuals conflict with the modeled assumptions in this skill, trust actuals
  and explicitly flag the divergence.
- If the file is stale (generated > 7 days ago), say so.
```

## Hosting options for observed.md

This file contains real spending data. Pick deliberately:

| Option | Daily-time? | Privacy | Notes |
|---|---|---|---|
| **Secret GitHub Gist** | yes | URL-obscure, not private | Raw URL is fetchable without auth; anyone with the URL can read it. Easiest that actually works with web fetch. |
| **Private repo raw URL** | no (auth) | private | `raw.githubusercontent.com` on private repos requires a token; most LLM fetch tools can't send one. |
| **Local file, connected folder** | yes | fully private | If your client can read local files (e.g. Cowork with a mounted folder), point the skill at the local path. Best option when available. |
| **Commit into the skill repo + re-upload** | no | private | Manual re-upload kills daily-time. Fallback only. |

Recommended: **local file path** when your client supports it; **secret gist** otherwise.

```sh
# gist update via gh cli, after observe:
ynab-agent observe --sync --write observed.md
gh gist edit <GIST_ID> observed.md
```

## Scheduling (macOS)

```sh
# crontab -e
15 7 * * * cd ~/code/ynab-agent && YNAB_TOKEN=$(security find-generic-password -s ynab-token -w) \
  node dist/cli/index.js observe --sync --write observed.md && gh gist edit <GIST_ID> observed.md
```

Storing the token in Keychain (`security add-generic-password -s ynab-token -a ynab -w`) keeps
it out of dotfiles and crontabs.
