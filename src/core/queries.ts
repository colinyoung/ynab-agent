import type { DatabaseSync } from "node:sqlite";

/** YNAB stores amounts in milliunits. Negative = outflow. */
export function toDollars(milliunits: number): number {
  return Math.round(milliunits / 10) / 100;
}

export function fmtUsd(milliunits: number): string {
  const d = toDollars(milliunits);
  return d.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Spending filter shared by most queries: on-budget, non-transfer rows. */
const SPEND_FILTER = `
  transfer_account_id IS NULL
  AND account_id IN (SELECT id FROM accounts WHERE on_budget = 1)
`;

export interface MonthlyTotal {
  month: string; // yyyy-mm
  outflow: number; // milliunits, positive number
  inflow: number; // milliunits
  net: number; // milliunits
}

/** SQL fragment + params excluding categories in the given groups (NULL category passes). */
function excludeGroupsClause(
  alias: string,
  excludeGroups: string[]
): { sql: string; params: string[] } {
  if (excludeGroups.length === 0) return { sql: "", params: [] };
  const ph = excludeGroups.map(() => "?").join(", ");
  return {
    sql: ` AND (${alias}category_id IS NULL OR ${alias}category_id NOT IN
            (SELECT id FROM categories WHERE group_name IN (${ph})))`,
    params: excludeGroups,
  };
}

export function monthlyTotals(
  db: DatabaseSync,
  months: number,
  excludeGroups: string[] = []
): MonthlyTotal[] {
  const ex = excludeGroupsClause("", excludeGroups);
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 7) AS month,
              -SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS outflow,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS inflow,
              SUM(amount) AS net
       FROM effective_tx
       WHERE ${SPEND_FILTER} ${ex.sql}
       GROUP BY month ORDER BY month DESC LIMIT ?`
    )
    .all(...ex.params, months) as unknown as MonthlyTotal[];
  return rows.reverse();
}

export interface CategoryMonth {
  month: string;
  category: string;
  group_name: string;
  outflow: number; // milliunits, positive
}

export function categorySpendByMonth(
  db: DatabaseSync,
  months: number,
  excludeGroups: string[] = [],
  excludeUncategorized = false
): CategoryMonth[] {
  const cutoff = new Date();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffMonth = cutoff.toISOString().slice(0, 7);
  const ex = excludeGroupsClause("e.", excludeGroups);
  const uncatClause = excludeUncategorized
    ? " AND e.category_name IS NOT NULL AND e.category_name != 'Uncategorized'"
    : "";
  return db
    .prepare(
      `SELECT substr(e.date, 1, 7) AS month,
              COALESCE(e.category_name, '(uncategorized)') AS category,
              COALESCE(c.group_name, '') AS group_name,
              -SUM(e.amount) AS outflow
       FROM effective_tx e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.amount < 0
         AND e.transfer_account_id IS NULL
         AND e.account_id IN (SELECT id FROM accounts WHERE on_budget = 1)
         AND substr(e.date, 1, 7) >= ?${uncatClause} ${ex.sql}
       GROUP BY month, category
       ORDER BY month ASC, outflow DESC`
    )
    .all(cutoffMonth, ...ex.params) as unknown as CategoryMonth[];
}

export interface PayeeTotal {
  payee: string;
  outflow: number; // milliunits, positive
  count: number;
  avg: number; // milliunits
}

export function categoryPayeeBreakdown(
  db: DatabaseSync,
  categorySubstr: string,
  months: number
): PayeeTotal[] {
  const cutoff = new Date();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffMonth = cutoff.toISOString().slice(0, 7);
  return db
    .prepare(
      `SELECT COALESCE(e.payee_name, '(no payee)') AS payee,
              -SUM(e.amount) AS outflow,
              COUNT(*) AS count,
              -AVG(e.amount) AS avg
       FROM effective_tx e
       WHERE e.amount < 0
         AND e.transfer_account_id IS NULL
         AND e.account_id IN (SELECT id FROM accounts WHERE on_budget = 1)
         AND LOWER(COALESCE(e.category_name, '')) LIKE ?
         AND substr(e.date, 1, 7) >= ?
       GROUP BY payee
       ORDER BY outflow DESC`
    )
    .all(`%${categorySubstr.toLowerCase()}%`, cutoffMonth) as unknown as PayeeTotal[];
}

export function categorySpendInRange(
  db: DatabaseSync,
  sinceMonth: string,
  untilMonth: string,
  excludeGroups: string[] = []
): CategoryMonth[] {
  const ex = excludeGroupsClause("e.", excludeGroups);
  return db
    .prepare(
      `SELECT substr(e.date, 1, 7) AS month,
              COALESCE(e.category_name, '(uncategorized)') AS category,
              COALESCE(c.group_name, '') AS group_name,
              -SUM(e.amount) AS outflow
       FROM effective_tx e
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.amount < 0
         AND e.transfer_account_id IS NULL
         AND e.account_id IN (SELECT id FROM accounts WHERE on_budget = 1)
         AND substr(e.date, 1, 7) >= ? AND substr(e.date, 1, 7) <= ? ${ex.sql}
       GROUP BY month, category
       ORDER BY month ASC, outflow DESC`
    )
    .all(sinceMonth, untilMonth, ...ex.params) as unknown as CategoryMonth[];
}

export interface GroupPnlRow {
  month: string;
  outflow: number; // milliunits, positive
  offset_inflow: number; // milliunits, positive — inflows from offset payees
  net: number; // milliunits; negative = group costs money
}

/**
 * Netted P&L for an excluded category group: the group's outflows vs inflows
 * from its offset payees (e.g. rental income against property costs).
 */
export function groupPnl(
  db: DatabaseSync,
  group: string,
  offsetPayees: string[],
  sinceMonth: string
): GroupPnlRow[] {
  const out = db
    .prepare(
      `SELECT substr(e.date, 1, 7) AS month, -SUM(e.amount) AS outflow
       FROM effective_tx e
       WHERE e.amount < 0 AND e.transfer_account_id IS NULL
         AND e.account_id IN (SELECT id FROM accounts WHERE on_budget = 1)
         AND e.category_id IN (SELECT id FROM categories WHERE group_name = ?)
         AND substr(e.date, 1, 7) >= ?
       GROUP BY month`
    )
    .all(group, sinceMonth) as unknown as { month: string; outflow: number }[];

  const inflowByMonth = new Map<string, number>();
  if (offsetPayees.length > 0) {
    const like = offsetPayees.map(() => "LOWER(COALESCE(e.payee_name,'')) LIKE ?").join(" OR ");
    const rows = db
      .prepare(
        `SELECT substr(e.date, 1, 7) AS month, SUM(e.amount) AS inflow
         FROM effective_tx e
         WHERE e.amount > 0 AND e.transfer_account_id IS NULL
           AND e.account_id IN (SELECT id FROM accounts WHERE on_budget = 1)
           AND (${like})
           AND substr(e.date, 1, 7) >= ?
         GROUP BY month`
      )
      .all(...offsetPayees.map((p) => `%${p.toLowerCase()}%`), sinceMonth) as unknown as {
      month: string;
      inflow: number;
    }[];
    for (const r of rows) inflowByMonth.set(r.month, r.inflow);
  }

  const monthSet = new Set([...out.map((r) => r.month), ...inflowByMonth.keys()]);
  return [...monthSet]
    .sort()
    .map((month) => {
      const outflow = out.find((r) => r.month === month)?.outflow ?? 0;
      const offset_inflow = inflowByMonth.get(month) ?? 0;
      return { month, outflow, offset_inflow, net: offset_inflow - outflow };
    });
}

export interface TxRow {
  id: string;
  date: string;
  amount: number;
  payee_name: string | null;
  category_name: string | null;
  account_name: string;
  memo: string | null;
}

export interface TxFilter {
  since?: string; // yyyy-mm-dd or yyyy-mm
  until?: string;
  category?: string; // substring match, case-insensitive
  payee?: string; // substring match, case-insensitive
  minAmount?: number; // dollars, absolute value
  limit?: number;
}

export function listTransactions(db: DatabaseSync, f: TxFilter): TxRow[] {
  const where: string[] = [SPEND_FILTER];
  const params: (string | number)[] = [];
  if (f.since) {
    where.push("date >= ?");
    params.push(f.since.length === 7 ? `${f.since}-01` : f.since);
  }
  if (f.until) {
    where.push("date <= ?");
    params.push(f.until.length === 7 ? `${f.until}-31` : f.until);
  }
  if (f.category) {
    where.push("LOWER(COALESCE(category_name,'')) LIKE ?");
    params.push(`%${f.category.toLowerCase()}%`);
  }
  if (f.payee) {
    where.push("LOWER(COALESCE(payee_name,'')) LIKE ?");
    params.push(`%${f.payee.toLowerCase()}%`);
  }
  if (f.minAmount !== undefined) {
    where.push("ABS(amount) >= ?");
    params.push(Math.round(f.minAmount * 1000));
  }
  params.push(f.limit ?? 100);
  return db
    .prepare(
      `SELECT id, date, amount, payee_name, category_name, account_name, memo
       FROM effective_tx
       WHERE ${where.join(" AND ")}
       ORDER BY date DESC, id LIMIT ?`
    )
    .all(...params) as unknown as TxRow[];
}

export interface AccountRow {
  id: string;
  name: string;
  type: string;
  on_budget: number;
  closed: number;
  balance: number;
}

export function listAccounts(db: DatabaseSync, includeClosed = false): AccountRow[] {
  return db
    .prepare(
      `SELECT id, name, type, on_budget, closed, balance FROM accounts
       WHERE deleted = 0 ${includeClosed ? "" : "AND closed = 0"}
       ORDER BY on_budget DESC, name`
    )
    .all() as unknown as AccountRow[];
}

/** Latest transaction date in the mirror — proxy for data freshness. */
export function latestTxDate(db: DatabaseSync): string | undefined {
  const row = db.prepare("SELECT MAX(date) AS d FROM transactions WHERE deleted = 0").get() as
    | { d: string | null }
    | undefined;
  return row?.d ?? undefined;
}

/** Complete calendar months present in the data, most recent first (excludes current partial month). */
export function completeMonths(db: DatabaseSync, count: number): string[] {
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(date, 1, 7) AS month FROM effective_tx
       WHERE substr(date, 1, 7) < ? ORDER BY month DESC LIMIT ?`
    )
    .all(currentMonth, count) as unknown as { month: string }[];
  return rows.map((r) => r.month);
}
