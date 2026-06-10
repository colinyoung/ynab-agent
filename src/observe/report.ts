/**
 * observed.md generator — the "live layer" consumed by an LLM skill.
 *
 * Static facts (comp, milestones, modeling conventions) live in the skill
 * itself; this report carries only what changes daily: actual spend vs the
 * modeled expense floor, category drift, and large/unusual transactions.
 */
import type { DatabaseSync } from "node:sqlite";
import { describeFloor, floorForMonth, type Config } from "../core/config.js";
import { getMeta } from "../core/db.js";
import {
  categorySpendByMonth,
  completeMonths,
  fmtUsd,
  latestTxDate,
  listTransactions,
  monthlyTotals,
  toDollars,
} from "../core/queries.js";

export function generateObservedMd(db: DatabaseSync, cfg: Config): string {
  const lines: string[] = [];
  const now = new Date().toISOString().slice(0, 10);
  const fresh = latestTxDate(db) ?? "unknown";
  const lastSync = getMeta(db, `last_sync:${cfg.budgetId}`) ?? "never";

  lines.push("# Observed Financial Reality (auto-generated)");
  lines.push("");
  lines.push(`> Generated ${now} by \`ynab-agent observe\`. Latest transaction: ${fresh}. Last sync: ${lastSync}.`);
  lines.push("> This file reflects ACTUALS from YNAB. When it conflicts with modeled assumptions, trust this file and flag the divergence.");
  lines.push("");

  // --- Monthly outflow vs modeled floor ---
  const months = completeMonths(db, 3);
  const totals = monthlyTotals(db, 14); // generous window; we filter below
  const byMonth = new Map(totals.map((t) => [t.month, t]));

  lines.push("## Monthly outflow vs modeled floor");
  lines.push("");
  lines.push(`Modeled expense floor: ${describeFloor(cfg.expenseFloor)}`);
  lines.push("");
  lines.push("| Month | Outflow | Floor | Δ vs floor | Inflow | Net |");
  lines.push("|---|---|---|---|---|---|");

  let trailingOut = 0;
  let trailingFloor = 0;
  let flooredMonths = 0;
  for (const m of [...months].reverse()) {
    const t = byMonth.get(m);
    if (!t) continue;
    const out = toDollars(t.outflow);
    trailingOut += out;
    const floor = floorForMonth(cfg.expenseFloor, m);
    let floorCell = "—";
    let delta = "—";
    if (floor > 0) {
      trailingFloor += floor;
      flooredMonths++;
      floorCell = `$${floor.toLocaleString("en-US")}`;
      delta = `${out >= floor ? "+" : "−"}$${Math.abs(Math.round(out - floor)).toLocaleString("en-US")} (${(((out - floor) / floor) * 100).toFixed(1)}%)`;
    }
    lines.push(`| ${m} | ${fmtUsd(t.outflow)} | ${floorCell} | ${delta} | ${fmtUsd(t.inflow)} | ${fmtUsd(t.net)} |`);
  }
  if (months.length > 0) {
    const avg = trailingOut / months.length;
    lines.push("");
    lines.push(`**Trailing ${months.length}-month average outflow: $${Math.round(avg).toLocaleString("en-US")}/mo**`);
    if (flooredMonths > 0) {
      const avgFloor = trailingFloor / flooredMonths;
      const driftPct = ((avg - avgFloor) / avgFloor) * 100;
      const verdict =
        Math.abs(driftPct) < 5
          ? "tracking the modeled floor"
          : driftPct > 0
            ? `running ${driftPct.toFixed(1)}% ABOVE the modeled floor — projections using the floor are optimistic`
            : `running ${Math.abs(driftPct).toFixed(1)}% below the modeled floor — projections have slack`;
      lines.push(`Reality check: actuals are ${verdict} (avg floor in effect: $${Math.round(avgFloor).toLocaleString("en-US")}/mo).`);
    } else {
      lines.push("_No floor set — run `ynab-agent config set-floor <yyyy-mm> <dollars>`._");
    }
  } else {
    lines.push("");
    lines.push("_No complete months of data yet — run `ynab-agent sync` first._");
  }
  lines.push("");

  // --- Category drift: last complete month vs prior trailing average ---
  lines.push("## Category drift (last complete month vs prior 3-month avg)");
  lines.push("");
  const catRows = categorySpendByMonth(db, 5);
  const lastMonth = months[0];
  if (lastMonth && catRows.length > 0) {
    const priorMonths = months.slice(1);
    const lastByCat = new Map<string, number>();
    const priorByCat = new Map<string, number[]>();
    for (const r of catRows) {
      if (r.month === lastMonth) {
        lastByCat.set(r.category, toDollars(r.outflow));
      } else if (priorMonths.includes(r.month)) {
        const arr = priorByCat.get(r.category) ?? [];
        arr.push(toDollars(r.outflow));
        priorByCat.set(r.category, arr);
      }
    }
    const drifts: { category: string; last: number; avg: number; delta: number }[] = [];
    const allCats = new Set([...lastByCat.keys(), ...priorByCat.keys()]);
    for (const cat of allCats) {
      const last = lastByCat.get(cat) ?? 0;
      const priorVals = priorByCat.get(cat) ?? [];
      const avg =
        priorMonths.length > 0
          ? priorVals.reduce((a, b) => a + b, 0) / priorMonths.length
          : 0;
      drifts.push({ category: cat, last, avg, delta: last - avg });
    }
    drifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    lines.push(`| Category | ${lastMonth} | Prior avg | Δ |`);
    lines.push("|---|---|---|---|");
    for (const d of drifts.slice(0, 10)) {
      if (Math.abs(d.delta) < 25) continue; // noise floor
      const sign = d.delta > 0 ? "+" : "−";
      lines.push(
        `| ${d.category} | $${Math.round(d.last).toLocaleString("en-US")} | $${Math.round(d.avg).toLocaleString("en-US")} | ${sign}$${Math.abs(Math.round(d.delta)).toLocaleString("en-US")} |`
      );
    }
  } else {
    lines.push("_Not enough data yet._");
  }
  lines.push("");

  // --- Large transactions, last 30 days ---
  lines.push(`## Large transactions (last 30 days, ≥ $${cfg.largeTxThreshold.toLocaleString("en-US")})`);
  lines.push("");
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const large = listTransactions(db, { since, minAmount: cfg.largeTxThreshold, limit: 25 });
  if (large.length > 0) {
    lines.push("| Date | Payee | Category | Amount |");
    lines.push("|---|---|---|---|");
    for (const t of large) {
      lines.push(
        `| ${t.date} | ${t.payee_name ?? "—"} | ${t.category_name ?? "(uncategorized)"} | ${fmtUsd(t.amount)} |`
      );
    }
    lines.push("");
    lines.push(
      "_Grounding note: for any large or unusual outflow above, it is worth asking whether the decision behind it was considered or urgent. Surface this gently when relevant._"
    );
  } else {
    lines.push("_None._");
  }
  lines.push("");

  return lines.join("\n") + "\n";
}
