/**
 * Notes: persistent human/agent observations attached to categories, payees,
 * or months. The point is institutional memory — "Happy Hall spike in May is
 * the whole-summer camp prepay" — so drift reports explain themselves instead
 * of re-alarming every agent that reads them.
 */
import type { DatabaseSync } from "node:sqlite";

export interface Note {
  id: number;
  created_at: string;
  month: string | null;
  category: string | null;
  payee: string | null;
  text: string;
}

export interface NoteScope {
  month?: string;
  category?: string;
  payee?: string;
}

export function addNote(db: DatabaseSync, text: string, scope: NoteScope): Note {
  const created = new Date().toISOString();
  const result = db
    .prepare("INSERT INTO notes (created_at, month, category, payee, text) VALUES (?, ?, ?, ?, ?)")
    .run(created, scope.month ?? null, scope.category ?? null, scope.payee ?? null, text);
  return {
    id: Number(result.lastInsertRowid),
    created_at: created,
    month: scope.month ?? null,
    category: scope.category ?? null,
    payee: scope.payee ?? null,
    text,
  };
}

export function listNotes(db: DatabaseSync, scope: NoteScope = {}, limit = 100): Note[] {
  const where: string[] = ["1=1"];
  const params: string[] = [];
  if (scope.month) {
    where.push("month = ?");
    params.push(scope.month);
  }
  if (scope.category) {
    where.push("LOWER(COALESCE(category,'')) LIKE ?");
    params.push(`%${scope.category.toLowerCase()}%`);
  }
  if (scope.payee) {
    where.push("LOWER(COALESCE(payee,'')) LIKE ?");
    params.push(`%${scope.payee.toLowerCase()}%`);
  }
  return db
    .prepare(
      `SELECT id, created_at, month, category, payee, text FROM notes
       WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit) as unknown as Note[];
}

export function removeNote(db: DatabaseSync, id: number): boolean {
  const r = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return r.changes > 0;
}

/** Notes relevant to a category name (exact or substring match), newest first. */
export function notesForCategory(db: DatabaseSync, category: string, limit = 5): Note[] {
  return db
    .prepare(
      `SELECT id, created_at, month, category, payee, text FROM notes
       WHERE category IS NOT NULL AND LOWER(?) LIKE '%' || LOWER(category) || '%'
          OR LOWER(COALESCE(category,'')) LIKE '%' || LOWER(?) || '%' AND category IS NOT NULL
       ORDER BY id DESC LIMIT ?`
    )
    .all(category, category, limit) as unknown as Note[];
}
