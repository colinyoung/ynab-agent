/**
 * Minimal YNAB v1 API client with exponential backoff + jitter.
 *
 * YNAB rate limit: 200 requests/hour per token. The real mitigation is the
 * local SQLite mirror + delta requests (last_knowledge_of_server), not retries
 * — but we back off politely on 429/5xx anyway.
 */

const BASE_URL = "https://api.ynab.com/v1";
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

export class YnabApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "YnabApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const s = Number(retryAfterHeader);
    if (Number.isFinite(s)) return Math.min(s * 1000, MAX_DELAY_MS);
  }
  const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return exp / 2 + Math.random() * (exp / 2); // full-ish jitter
}

export class YnabClient {
  constructor(private readonly token: string) {}

  async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {}
  ): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
          },
        });
      } catch (err) {
        // network error — retry
        lastErr = err as Error;
        await sleep(backoffDelay(attempt, null));
        continue;
      }

      if (res.ok) {
        const body = (await res.json()) as { data: T };
        return body.data;
      }

      const retriable = res.status === 429 || res.status >= 500;
      const detail = await res.text().catch(() => "");
      if (!retriable || attempt === MAX_RETRIES) {
        if (res.status === 401) {
          throw new YnabApiError(
            "YNAB rejected the token (401). Check YNAB_TOKEN.",
            401,
            detail
          );
        }
        if (res.status === 429) {
          throw new YnabApiError(
            "YNAB rate limit exhausted (200 req/hr). Rely on the local mirror; retry later.",
            429,
            detail
          );
        }
        throw new YnabApiError(`YNAB API error ${res.status} on ${path}`, res.status, detail);
      }
      lastErr = new YnabApiError(`HTTP ${res.status}`, res.status, detail);
      await sleep(backoffDelay(attempt, res.headers.get("Retry-After")));
    }
    throw lastErr ?? new Error("unreachable");
  }
}

// ---- Response types (only the fields we mirror) ----

export interface BudgetSummary {
  id: string;
  name: string;
  last_modified_on: string;
}

export interface Account {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  balance: number; // milliunits
  deleted: boolean;
}

export interface CategoryGroupWithCategories {
  id: string;
  name: string;
  hidden: boolean;
  deleted: boolean;
  categories: Category[];
}

export interface Category {
  id: string;
  category_group_id: string;
  name: string;
  hidden: boolean;
  budgeted: number;
  activity: number;
  balance: number;
  deleted: boolean;
}

export interface Payee {
  id: string;
  name: string;
  deleted: boolean;
}

export interface SubTransaction {
  id: string;
  transaction_id: string;
  amount: number;
  memo: string | null;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
}

export interface TransactionDetail {
  id: string;
  date: string; // ISO yyyy-mm-dd
  amount: number; // milliunits; negative = outflow
  memo: string | null;
  cleared: string;
  approved: boolean;
  account_id: string;
  account_name: string;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  transfer_account_id: string | null;
  deleted: boolean;
  subtransactions: SubTransaction[];
}
