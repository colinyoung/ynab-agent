# events/ (stub)

The memory layer. Planned shape:

1. **Cluster** — group transactions into "events" by time window + geography hints
   (payee names, category mix). A Legoland day = parking + tickets + lunch + gas
   within ~36 hours.
2. **Enrich** — pull photos from the same date range via
   [`osxphotos`](https://github.com/RhetTbull/osxphotos) (`osxphotos query --from-date
   ... --to-date ... --json`), calendar events via MCP.
3. **Render** — one static HTML page per event (photos, transaction table, total
   cost), written to `~/.local/share/ynab-agent/events/<slug>.html`. The CLI prints
   `file://` links — cmd+click to open.

Planned commands:

```sh
ynab-agent events detect --since 2026-01     # cluster + list candidate events
ynab-agent events show <slug> --open         # render HTML page, open in browser
```

Not built yet; the SQLite mirror in core/ is the only dependency this needs.
