#!/usr/bin/env node
/**
 * MCP server (stdio) over the same core as the CLI.
 *
 * Register in any MCP client, e.g. Claude:
 *   { "command": "ynab-agent-mcp", "env": { "YNAB_TOKEN": "..." } }
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { YnabClient } from "../core/api.js";
import { getToken, loadConfig } from "../core/config.js";
import { openDb } from "../core/db.js";
import {
  categorySpendByMonth,
  listAccounts,
  listTransactions,
  monthlyTotals,
  toDollars,
} from "../core/queries.js";
import { syncBudget } from "../core/sync.js";
import { generateObservedMd } from "../observe/report.js";

const server = new McpServer({ name: "ynab-agent", version: "0.1.0" });

function text(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

server.registerTool(
  "ynab_sync",
  {
    description:
      "Delta-sync the configured YNAB budget into the local SQLite mirror. Cheap (uses last_knowledge_of_server). Run before queries if freshness matters.",
    inputSchema: {},
  },
  async () => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const result = await syncBudget(new YnabClient(getToken()), db, cfg.budgetId);
    return text(result);
  }
);

server.registerTool(
  "ynab_list_transactions",
  {
    description:
      "Query transactions from the local mirror. Splits are resolved to subtransaction categories. Amounts in milliunits (divide by 1000 for dollars); negative = outflow.",
    inputSchema: {
      since: z.string().optional().describe("yyyy-mm-dd or yyyy-mm"),
      until: z.string().optional().describe("yyyy-mm-dd or yyyy-mm"),
      category: z.string().optional().describe("category name substring, case-insensitive"),
      payee: z.string().optional().describe("payee name substring, case-insensitive"),
      min_amount: z.number().optional().describe("absolute amount in dollars, at least"),
      limit: z.number().optional().describe("max rows, default 100"),
    },
  },
  async (args) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const rows = listTransactions(db, {
      since: args.since,
      until: args.until,
      category: args.category,
      payee: args.payee,
      minAmount: args.min_amount,
      limit: args.limit,
    });
    return text(rows.map((r) => ({ ...r, amount_usd: toDollars(r.amount) })));
  }
);

server.registerTool(
  "ynab_spend_summary",
  {
    description:
      "Spending summary from the local mirror: totals by month, or by category per month. Outflow values returned in dollars.",
    inputSchema: {
      months: z.number().optional().describe("window in months, default 3"),
      by: z.enum(["month", "category"]).optional().describe("aggregation, default 'month'"),
    },
  },
  async (args) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const months = args.months ?? 3;
    if (args.by === "category") {
      const rows = categorySpendByMonth(db, months);
      return text(
        rows.map((r) => ({ month: r.month, category: r.category, outflow_usd: toDollars(r.outflow) }))
      );
    }
    const rows = monthlyTotals(db, months);
    return text(
      rows.map((r) => ({
        month: r.month,
        outflow_usd: toDollars(r.outflow),
        inflow_usd: toDollars(r.inflow),
        net_usd: toDollars(r.net),
      }))
    );
  }
);

server.registerTool(
  "ynab_list_accounts",
  {
    description: "List accounts from the local mirror with balances (milliunits and dollars).",
    inputSchema: {
      include_closed: z.boolean().optional(),
    },
  },
  async (args) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const rows = listAccounts(db, !!args.include_closed);
    return text(rows.map((r) => ({ ...r, balance_usd: toDollars(r.balance) })));
  }
);

server.registerTool(
  "ynab_observe",
  {
    description:
      "Generate the observed.md drift report (actual spend vs modeled expense floor, category drift, large transactions). Returns markdown. Set sync=true to refresh data first.",
    inputSchema: {
      sync: z.boolean().optional().describe("delta-sync before generating"),
    },
  },
  async (args) => {
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    if (args.sync) {
      await syncBudget(new YnabClient(getToken()), db, cfg.budgetId);
    }
    return text(generateObservedMd(db, cfg));
  }
);

const execFileAsync = promisify(execFile);
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "cli", "index.js");

server.registerTool(
  "ynab_cli",
  {
    description:
      "Run any ynab-agent CLI command directly and get its stdout. The full CLI surface " +
      "(including commands added after this server was built): sync, budgets, accounts, " +
      "tx list, spend, observe [--gist], note add/list/rm, config show/set/set-floor. " +
      "Pass args as an array, e.g. [\"tx\", \"list\", \"--since\", \"2026-01\", \"--json\"]. " +
      "Use [\"--help\"] or [\"<cmd>\", \"--help\"] to discover options. The CLI is read-only " +
      "against YNAB; writes are limited to local config and notes.",
    inputSchema: {
      args: z.array(z.string()).describe("CLI arguments, e.g. ['spend', '--months', '6', '--json']"),
    },
  },
  async ({ args }) => {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });
      return text(stdout + (stderr ? `\n[stderr]\n${stderr}` : ""));
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return text(
        `command failed: ${e.message ?? "unknown error"}\n${e.stdout ?? ""}${e.stderr ? `\n[stderr]\n${e.stderr}` : ""}`
      );
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
