#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { YnabClient, type BudgetSummary } from "../core/api.js";
import { configPath, getToken, loadConfig, saveConfig, type Config } from "../core/config.js";
import { openDb } from "../core/db.js";
import {
  categoryPayeeBreakdown,
  categorySpendByMonth,
  categorySpendInRange,
  fmtUsd,
  listAccounts,
  listTransactions,
  monthlyTotals,
  toDollars,
} from "../core/queries.js";
import { addNote, listNotes, removeNote } from "../core/notes.js";
import { syncBudget } from "../core/sync.js";
import { publishGist, stableRawUrl } from "../observe/gist.js";
import { generateObservedMd } from "../observe/report.js";

const program = new Command();
program
  .name("ynab-agent")
  .description("Agent-first YNAB CLI: local SQLite mirror, spend analysis, observed.md generation")
  .version("0.1.0")
  .option("--json", "output JSON (default for list commands is a table)");

function out(data: unknown, asJson: boolean, table?: () => void): void {
  if (asJson || !table) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    table();
  }
}

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
}

program
  .command("budgets")
  .description("List budgets from the YNAB API (live call)")
  .action(async () => {
    try {
      const client = new YnabClient(getToken());
      const data = await client.get<{ budgets: BudgetSummary[] }>("/budgets");
      out(data.budgets, !!program.opts().json, () => {
        for (const b of data.budgets) console.log(`${b.id}  ${b.name}`);
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("sync")
  .description("Delta-sync the configured budget into the local SQLite mirror")
  .option("--full", "reset server knowledge and re-pull everything (fixes missed deletions/merges)")
  .action(async (opts: { full?: boolean }) => {
    try {
      const cfg = loadConfig();
      const client = new YnabClient(getToken());
      const db = openDb(cfg.dbPath);
      const result = await syncBudget(client, db, cfg.budgetId, !!opts.full);
      out(result, !!program.opts().json, () => {
        const mode = opts.full ? "full" : "delta";
        console.log(
          `synced budget=${result.budgetId}: ${result.transactions} tx, ` +
            `${result.accounts} accounts, ${result.categories} categories, ${result.payees} payees (${mode})`
        );
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("accounts")
  .description("List accounts from the local mirror")
  .option("--closed", "include closed accounts")
  .action((opts: { closed?: boolean }) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const rows = listAccounts(db, !!opts.closed);
      out(rows, !!program.opts().json, () => {
        for (const a of rows) {
          console.log(
            `${a.on_budget ? "[budget]  " : "[tracking]"} ${a.name.padEnd(40)} ${fmtUsd(a.balance)}`
          );
        }
      });
    } catch (e) {
      fail(e);
    }
  });

const tx = program.command("tx").description("Transaction queries against the local mirror");
tx.command("list")
  .description("List transactions (splits resolved to their subtransaction categories)")
  .option("--since <date>", "yyyy-mm-dd or yyyy-mm")
  .option("--until <date>", "yyyy-mm-dd or yyyy-mm")
  .option("--category <substr>", "category name contains (case-insensitive)")
  .option("--payee <substr>", "payee name contains (case-insensitive)")
  .option("--min <dollars>", "absolute amount at least", parseFloat)
  .option("--limit <n>", "max rows (default 100)", (v) => parseInt(v, 10))
  .action((opts: { since?: string; until?: string; category?: string; payee?: string; min?: number; limit?: number }) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const rows = listTransactions(db, {
        since: opts.since,
        until: opts.until,
        category: opts.category,
        payee: opts.payee,
        minAmount: opts.min,
        limit: opts.limit,
      });
      out(rows, !!program.opts().json, () => {
        for (const t of rows) {
          console.log(
            `${t.date}  ${fmtUsd(t.amount).padStart(12)}  ${(t.payee_name ?? "—").padEnd(30)} ${t.category_name ?? "(uncategorized)"}`
          );
        }
        console.error(`\n${rows.length} rows`);
      });
    } catch (e) {
      fail(e);
    }
  });

program
  .command("spend")
  .description("Spend summaries from the local mirror")
  .option("--months <n>", "window in months (default 3)", (v) => parseInt(v, 10), 3)
  .option("--by <dim>", "'month' (default) or 'category'", "month")
  .option("--no-uncategorized", "exclude uncategorized transactions from --by category view")
  .option("--detail <category>", "show payee breakdown within a category instead of category totals")
  .action((opts: { months: number; by: string; uncategorized: boolean; detail?: string }) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      if (opts.detail) {
        const rows = categoryPayeeBreakdown(db, opts.detail, opts.months);
        out(rows.map((r) => ({ ...r, outflow_usd: toDollars(r.outflow), avg_usd: toDollars(r.avg) })), !!program.opts().json, () => {
          console.log(`\n== ${opts.detail} — top payees (last ${opts.months} month${opts.months === 1 ? "" : "s"}) ==`);
          for (const r of rows) {
            console.log(
              `  ${r.payee.padEnd(36)} ${fmtUsd(r.outflow).padStart(12)}   ${String(r.count).padStart(3)}x  avg ${fmtUsd(r.avg)}`
            );
          }
          const total = rows.reduce((s, r) => s + r.outflow, 0);
          console.log(`\n  ${"total".padEnd(36)} ${fmtUsd(total).padStart(12)}`);
        });
      } else if (opts.by === "category") {
        const rows = categorySpendByMonth(db, opts.months, [], !opts.uncategorized);
        out(rows.map((r) => ({ ...r, outflow_usd: toDollars(r.outflow) })), !!program.opts().json, () => {
          let month = "";
          for (const r of rows) {
            if (r.month !== month) {
              month = r.month;
              console.log(`\n== ${month} ==`);
            }
            console.log(`  ${r.category.padEnd(36)} ${fmtUsd(r.outflow).padStart(12)}`);
          }
        });
      } else {
        const rows = monthlyTotals(db, opts.months);
        out(rows.map((r) => ({ ...r, outflow_usd: toDollars(r.outflow), net_usd: toDollars(r.net) })), !!program.opts().json, () => {
          for (const r of rows) {
            console.log(
              `${r.month}  out ${fmtUsd(r.outflow).padStart(12)}  in ${fmtUsd(r.inflow).padStart(12)}  net ${fmtUsd(r.net).padStart(12)}`
            );
          }
        });
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command("observe")
  .description("Generate observed.md — actuals vs modeled assumptions, for skill ingestion")
  .option("--write <path>", "write to file instead of stdout")
  .option("--sync", "delta-sync before generating")
  .option("--gist", "publish to a secret GitHub gist (creates one on first use; needs GITHUB_TOKEN)")
  .action(async (opts: { write?: string; sync?: boolean; gist?: boolean }) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      if (opts.sync) {
        const client = new YnabClient(getToken());
        await syncBudget(client, db, cfg.budgetId);
      }
      const md = generateObservedMd(db, cfg);
      if (opts.write) {
        writeFileSync(opts.write, md);
        console.error(`wrote ${opts.write}`);
      }
      if (opts.gist) {
        const result = await publishGist(md, cfg.gistId || undefined);
        if (result.created) {
          saveConfig({ gistId: result.id });
          console.error(`created secret gist ${result.id} (saved to config)`);
        }
        console.error(`gist:    ${result.htmlUrl}`);
        console.error(`raw url: ${stableRawUrl(result.htmlUrl)}`);
      }
      if (!opts.write && !opts.gist) {
        console.log(md);
      }
    } catch (e) {
      fail(e);
    }
  });

const note = program.command("note").description("Persistent observations (institutional memory for agents)");
note
  .command("add <text>")
  .description('e.g. note add "May spike = whole-summer camp prepay" --category "Happy Hall" --month 2026-05')
  .option("--category <name>", "category this observation applies to")
  .option("--payee <name>", "payee this observation applies to")
  .option("--month <yyyy-mm>", "month this observation applies to")
  .action((text: string, opts: { category?: string; payee?: string; month?: string }) => {
    try {
      if (opts.month && !/^\d{4}-\d{2}$/.test(opts.month)) fail(new Error("month must be yyyy-mm"));
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const n = addNote(db, text, opts);
      console.log(JSON.stringify(n, null, 2));
    } catch (e) {
      fail(e);
    }
  });
note
  .command("list")
  .option("--category <name>")
  .option("--payee <name>")
  .option("--month <yyyy-mm>")
  .option("--limit <n>", "max rows (default 100)", (v) => parseInt(v, 10))
  .action((opts: { category?: string; payee?: string; month?: string; limit?: number }) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const rows = listNotes(db, opts, opts.limit ?? 100);
      out(rows, !!program.opts().json, () => {
        for (const n of rows) {
          const scope = [n.month, n.category, n.payee].filter(Boolean).join(" / ");
          console.log(`#${n.id} ${scope ? `[${scope}] ` : ""}${n.text}`);
        }
      });
    } catch (e) {
      fail(e);
    }
  });
note
  .command("rm <id>")
  .action((id: string) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const ok = removeNote(db, parseInt(id, 10));
      if (!ok) fail(new Error(`no note #${id}`));
      console.log(`removed #${id}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("floor-estimate")
  .description(
    "Estimate a realistic expense floor from actuals: per-category MEDIAN monthly outflow " +
      "over the window (medians suppress one-offs). Respects floorExcludeGroups; internal " +
      "YNAB groups always excluded."
  )
  .requiredOption("--since <yyyy-mm>", "first month of window (inclusive)")
  .option("--until <yyyy-mm>", "last month of window (inclusive; default last complete month)")
  .option("--exclude <names>", "comma-separated category names to exclude (one-offs, savings, reimbursables)", "")
  .action((opts: { since: string; until?: string; exclude: string }) => {
    try {
      const cfg = loadConfig();
      const db = openDb(cfg.dbPath);
      const now = new Date();
      const defaultUntil = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
        .toISOString()
        .slice(0, 7);
      const until = opts.until ?? defaultUntil;
      const excluded = opts.exclude
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const internal = new Set(["Internal Master Category", "Credit Card Payments"]);
      const rows = categorySpendInRange(db, opts.since, until, cfg.floorExcludeGroups).filter(
        (r) => !internal.has(r.group_name) && !excluded.includes(r.category.toLowerCase())
      );
      // enumerate months in window
      const monthList: string[] = [];
      for (let d = new Date(opts.since + "-01T00:00:00Z"); d.toISOString().slice(0, 7) <= until; d.setUTCMonth(d.getUTCMonth() + 1)) {
        monthList.push(d.toISOString().slice(0, 7));
      }
      const byCat = new Map<string, { group: string; values: Map<string, number> }>();
      for (const r of rows) {
        const e = byCat.get(r.category) ?? { group: r.group_name, values: new Map() };
        e.values.set(r.month, toDollars(r.outflow));
        byCat.set(r.category, e);
      }
      const median = (vals: number[]): number => {
        const s = [...vals].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
      };
      const cats = [...byCat.entries()]
        .map(([category, e]) => {
          const series = monthList.map((m) => e.values.get(m) ?? 0);
          const med = median(series);
          const mean = series.reduce((a, b) => a + b, 0) / series.length;
          return { category, group: e.group, median: Math.round(med), mean: Math.round(mean), series };
        })
        .filter((c) => c.median > 0 || c.mean > 0)
        .sort((a, b) => b.median - a.median);
      const sumMedian = cats.reduce((a, c) => a + c.median, 0);
      const sumMean = cats.reduce((a, c) => a + c.mean, 0);
      const result = {
        window: { since: opts.since, until, months: monthList },
        excludedCategories: excluded,
        excludedGroups: cfg.floorExcludeGroups,
        estimatedFloorMedian: sumMedian,
        estimatedFloorMean: sumMean,
        categories: cats,
      };
      out(result, !!program.opts().json, () => {
        for (const c of cats) {
          console.log(
            `${c.category.padEnd(40)} median $${String(c.median).padStart(7)}  mean $${String(c.mean).padStart(7)}  [${c.series.map((v) => Math.round(v)).join(", ")}]`
          );
        }
        console.log(`\nestimated floor (sum of medians): $${sumMedian.toLocaleString("en-US")}/mo`);
        console.log(`estimated floor (sum of means):   $${sumMean.toLocaleString("en-US")}/mo  (inflated by one-offs)`);
      });
    } catch (e) {
      fail(e);
    }
  });

const config = program.command("config").description("Show or set configuration");
config
  .command("show")
  .action(() => {
    console.log(`# ${configPath()}`);
    console.log(JSON.stringify(loadConfig(), null, 2));
  });
config
  .command("set <key> <value>")
  .description(
    "Set a config key: budgetId, dbPath, expenseFloor (number or JSON schedule), largeTxThreshold, " +
      'floorExcludeGroups (JSON array), offsets (JSON object: group → payee substrings), gistId'
  )
  .action((key: string, value: string) => {
    const valid = [
      "budgetId",
      "dbPath",
      "expenseFloor",
      "largeTxThreshold",
      "floorExcludeGroups",
      "offsets",
      "gistId",
    ];
    if (!valid.includes(key)) fail(new Error(`unknown key '${key}'; valid: ${valid.join(", ")}`));
    let parsed: unknown = value;
    if (key === "largeTxThreshold") parsed = parseFloat(value);
    if (key === "expenseFloor") {
      // accept a flat number or a JSON schedule: '{"2026-01": 13705, "2030-07": 21500}'
      parsed = value.trim().startsWith("{") ? JSON.parse(value) : parseFloat(value);
    }
    if (key === "floorExcludeGroups" || key === "offsets") {
      try {
        parsed = JSON.parse(value);
      } catch {
        fail(new Error(`${key} must be JSON, e.g. '["Investment Property"]' or '{"Investment Property": ["Winnemac"]}'`));
      }
    }
    const merged = saveConfig({ [key]: parsed } as Partial<Config>);
    console.log(JSON.stringify(merged, null, 2));
  });
config
  .command("set-floor <month> <dollars>")
  .description("Set the expense floor in effect from <yyyy-mm> onward (converts a flat floor to a schedule)")
  .action((month: string, dollars: string) => {
    if (!/^\d{4}-\d{2}$/.test(month)) fail(new Error("month must be yyyy-mm"));
    const amount = parseFloat(dollars);
    if (!Number.isFinite(amount) || amount < 0) fail(new Error("dollars must be a non-negative number"));
    const cur = loadConfig().expenseFloor;
    const schedule: Record<string, number> =
      typeof cur === "number" ? (cur > 0 ? { "0000-01": cur } : {}) : { ...cur };
    schedule[month] = amount;
    const merged = saveConfig({ expenseFloor: schedule });
    console.log(JSON.stringify(merged, null, 2));
  });

program.parseAsync(process.argv);
