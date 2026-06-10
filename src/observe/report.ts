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
import { listNotes, type Note } from "../core/notes.js";
import {
  categorySpendByMonth,
  completeMonths,
  fmtUsd,
  groupPnl,
  latestTxDate,
  listTransactions,
  monthlyTotals,
  toDollars,
} from "../core/queries.js";

/** Category groups never meaningful in spend drift (YNAB internals). */
const INTERNAL_GROUPS = new Set(["Internal Master Category", "Credit Card Payments"]);

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
  const excl = cfg.floorExcludeGroups;
  const totals = monthlyTotals(db, 14, excl); // generous window; we filter below
  const byMonth = new Map(totals.map((t) => [t.month, t]));

  lines.push("## Monthly outflow vs modeled floor");
  lines.push("");
  lines.push(`Modeled expense floor: ${describeFloor(cfg.expenseFloor)}`);
  if (excl.length > 0) {
    lines.push("");
    lines.push(
      `Excluded from floor comparison (reported separately below): ${excl.map((g) => `**${g}**`).join(", ")}`
    );
  }
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

  // --- Excluded group P&L (netted against offset payee inflows) ---
  if (excl.length > 0 && months.length > 0) {
    const sinceMonth = months[months.length - 1];
    for (const group of excl) {
      const offsetPayees = cfg.offsets[group] ?? [];
      const pnl = groupPnl(db, group, offsetPayees, sinceMonth);
      lines.push(`## ${group} — separate P&L`);
      lines.push("");
      if (offsetPayees.length > 0) {
        lines.push(`Offset inflows matched by payee: ${offsetPayees.join(", ")}`);
        lines.push("");
      }
      if (pnl.length > 0) {
        lines.push("| Month | Costs | Offset inflows | Net |");
        lines.push("|---|---|---|---|");
        let netSum = 0;
        for (const r of pnl) {
          netSum += toDollars(r.net);
          lines.push(
            `| ${r.month} | ${fmtUsd(r.outflow)} | ${fmtUsd(r.offset_inflow)} | ${fmtUsd(r.net)} |`
          );
        }
        lines.push("");
        const verdict =
          netSum >= 0
            ? `self-funding over this window (+$${Math.round(netSum).toLocaleString("en-US")} net)`
            : `costing $${Math.abs(Math.round(netSum)).toLocaleString("en-US")} net over this window`;
        lines.push(`Net: ${group} is ${verdict}.`);
      } else {
        lines.push("_No activity in window._");
      }
      lines.push("");
    }
  }

  // --- Category drift: last complete month vs prior trailing average ---
  lines.push("## Category drift (last complete month vs prior 3-month avg)");
  lines.push("");
  const catRows = categorySpendByMonth(db, 5, excl).filter(
    (r) => !INTERNAL_GROUPS.has(r.group_name)
  );
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
    const allNotes = listNotes(db, {}, 500);
    const notesFor = (category: string): Note[] =>
      allNotes.filter(
        (n) =>
          n.category !== null &&
          (category.toLowerCase().includes(n.category.toLowerCase()) ||
            n.category.toLowerCase().includes(category.toLowerCase()))
      );
    lines.push(`| Category | ${lastMonth} | Prior avg | Δ | Context |`);
    lines.push("|---|---|---|---|---|");
    for (const d of drifts.slice(0, 10)) {
      if (Math.abs(d.delta) < 25) continue; // noise floor
      const sign = d.delta > 0 ? "+" : "−";
      const ctx = notesFor(d.category)
        .slice(0, 2)
        .map((n) => (n.month ? `[${n.month}] ${n.text}` : n.text))
        .join(" · ");
      lines.push(
        `| ${d.category} | $${Math.round(d.last).toLocaleString("en-US")} | $${Math.round(d.avg).toLocaleString("en-US")} | ${sign}$${Math.abs(Math.round(d.delta)).toLocaleString("en-US")} | ${ctx} |`
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

  // --- Context notes (institutional memory for agents) ---
  const recentNotes = listNotes(db, {}, 15);
  lines.push("## Context notes");
  lines.push("");
  if (recentNotes.length > 0) {
    lines.push(
      "_Observations recorded by humans or agents. Use these to interpret the numbers above; add new ones via `ynab-agent note add`._"
    );
    lines.push("");
    for (const n of recentNotes) {
      const scope = [
        n.month ? `month:${n.month}` : null,
        n.category ? `category:${n.category}` : null,
        n.payee ? `payee:${n.payee}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`- ${scope ? `**(${scope})** ` : ""}${n.text}`);
    }
  } else {
    lines.push(
      "_None yet. Record explanations for anomalies (`ynab-agent note add \"...\" --category X --month yyyy-mm`) so future reports self-explain._"
    );
  }
  lines.push("");

  return lines.join("\n") + "\n";
}
