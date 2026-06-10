#!/usr/bin/env node
/**
 * MCP server (stdio) over the same core as the CLI.
 *
 * Register in any MCP client, e.g. Claude:
 *   { "command": "ynab-agent-mcp", "env": { "YNAB_TOKEN": "..." } }
 */
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

const transport = new StdioServerTransport();
await server.connect(transport);
