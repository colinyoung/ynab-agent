import type { DatabaseSync } from "node:sqlite";
import {
  YnabClient,
  type Account,
  type CategoryGroupWithCategories,
  type Payee,
  type TransactionDetail,
} from "./api.js";
import { getMeta, setMeta } from "./db.js";

export interface SyncResult {
  budgetId: string;
  accounts: number;
  categories: number;
  payees: number;
  transactions: number;
  syncedAt: string;
}

function skKey(budgetId: string, resource: string): string {
  return `sk:${budgetId}:${resource}`;
}

function lastKnowledge(db: DatabaseSync, budgetId: string, resource: string): number | undefined {
  const v = getMeta(db, skKey(budgetId, resource));
  return v === undefined ? undefined : Number(v);
}

export async function syncBudget(
  client: YnabClient,
  db: DatabaseSync,
  budgetId: string
): Promise<SyncResult> {
  // --- accounts ---
  const acctData = await client.get<{ accounts: Account[]; server_knowledge: number }>(
    `/budgets/${budgetId}/accounts`,
    { last_knowledge_of_server: lastKnowledge(db, budgetId, "accounts") }
  );
  const upsertAcct = db.prepare(`
    INSERT INTO accounts (id, name, type, on_budget, closed, balance, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, type=excluded.type, on_budget=excluded.on_budget,
      closed=excluded.closed, balance=excluded.balance, deleted=excluded.deleted
  `);
  for (const a of acctData.accounts) {
    upsertAcct.run(a.id, a.name, a.type, a.on_budget ? 1 : 0, a.closed ? 1 : 0, a.balance, a.deleted ? 1 : 0);
  }
  setMeta(db, skKey(budgetId, "accounts"), String(acctData.server_knowledge));

  // --- categories ---
  const catData = await client.get<{
    category_groups: CategoryGroupWithCategories[];
    server_knowledge: number;
  }>(`/budgets/${budgetId}/categories`, {
    last_knowledge_of_server: lastKnowledge(db, budgetId, "categories"),
  });
  const upsertCat = db.prepare(`
    INSERT INTO categories (id, group_id, group_name, name, hidden, budgeted, activity, balance, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      group_id=excluded.group_id, group_name=excluded.group_name, name=excluded.name,
      hidden=excluded.hidden, budgeted=excluded.budgeted, activity=excluded.activity,
      balance=excluded.balance, deleted=excluded.deleted
  `);
  let catCount = 0;
  for (const g of catData.category_groups) {
    for (const c of g.categories) {
      upsertCat.run(
        c.id, c.category_group_id, g.name, c.name,
        c.hidden ? 1 : 0, c.budgeted, c.activity, c.balance, c.deleted ? 1 : 0
      );
      catCount++;
    }
  }
  setMeta(db, skKey(budgetId, "categories"), String(catData.server_knowledge));

  // --- payees ---
  const payeeData = await client.get<{ payees: Payee[]; server_knowledge: number }>(
    `/budgets/${budgetId}/payees`,
    { last_knowledge_of_server: lastKnowledge(db, budgetId, "payees") }
  );
  const upsertPayee = db.prepare(`
    INSERT INTO payees (id, name, deleted) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, deleted=excluded.deleted
  `);
  for (const p of payeeData.payees) {
    upsertPayee.run(p.id, p.name, p.deleted ? 1 : 0);
  }
  setMeta(db, skKey(budgetId, "payees"), String(payeeData.server_knowledge));

  // --- transactions (incl. subtransactions) ---
  const txData = await client.get<{
    transactions: TransactionDetail[];
    server_knowledge: number;
  }>(`/budgets/${budgetId}/transactions`, {
    last_knowledge_of_server: lastKnowledge(db, budgetId, "transactions"),
  });
  const upsertTx = db.prepare(`
    INSERT INTO transactions (
      id, date, amount, memo, cleared, approved, account_id, account_name,
      payee_id, payee_name, category_id, category_name, transfer_account_id,
      has_subtransactions, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      date=excluded.date, amount=excluded.amount, memo=excluded.memo,
      cleared=excluded.cleared, approved=excluded.approved,
      account_id=excluded.account_id, account_name=excluded.account_name,
      payee_id=excluded.payee_id, payee_name=excluded.payee_name,
      category_id=excluded.category_id, category_name=excluded.category_name,
      transfer_account_id=excluded.transfer_account_id,
      has_subtransactions=excluded.has_subtransactions, deleted=excluded.deleted
  `);
  const upsertSub = db.prepare(`
    INSERT INTO subtransactions (
      id, transaction_id, amount, memo, payee_name, category_id, category_name,
      transfer_account_id, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      transaction_id=excluded.transaction_id, amount=excluded.amount, memo=excluded.memo,
      payee_name=excluded.payee_name, category_id=excluded.category_id,
      category_name=excluded.category_name, transfer_account_id=excluded.transfer_account_id,
      deleted=excluded.deleted
  `);
  for (const t of txData.transactions) {
    upsertTx.run(
      t.id, t.date, t.amount, t.memo, t.cleared, t.approved ? 1 : 0,
      t.account_id, t.account_name, t.payee_id, t.payee_name,
      t.category_id, t.category_name, t.transfer_account_id,
      t.subtransactions.length > 0 ? 1 : 0, t.deleted ? 1 : 0
    );
    for (const s of t.subtransactions) {
      upsertSub.run(
        s.id, t.id, s.amount, s.memo, s.payee_name,
        s.category_id, s.category_name, s.transfer_account_id, s.deleted ? 1 : 0
      );
    }
  }
  setMeta(db, skKey(budgetId, "transactions"), String(txData.server_knowledge));

  const syncedAt = new Date().toISOString();
  setMeta(db, `last_sync:${budgetId}`, syncedAt);

  return {
    budgetId,
    accounts: acctData.accounts.length,
    categories: catCount,
    payees: payeeData.payees.length,
    transactions: txData.transactions.length,
    syncedAt,
  };
}
