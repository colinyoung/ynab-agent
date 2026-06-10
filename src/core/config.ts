import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Modeled expense floor: either a flat dollars/month, or a dated schedule
 * mapping "yyyy-mm" → dollars/month. With a schedule, each month is compared
 * against the floor in effect at that time, so drift history stays honest
 * across plan changes (e.g. {"2026-01": 13705, "2030-07": 21500}).
 */
export type FloorSchedule = number | Record<string, number>;

export interface Config {
  /** YNAB budget ID; "last-used" works for most single-budget setups */
  budgetId: string;
  /** Path to the local SQLite mirror */
  dbPath: string;
  /** Modeled monthly expense floor (used by observe drift report) */
  expenseFloor: FloorSchedule;
  /** Transactions above this (dollars, absolute) get flagged by observe */
  largeTxThreshold: number;
  /**
   * Category GROUP names excluded from the floor comparison (e.g. an
   * investment property whose cashflows the household floor doesn't model).
   * Excluded groups get their own netted P&L section in observe instead.
   */
  floorExcludeGroups: string[];
  /**
   * Inflow offsets for excluded groups: group name → payee substrings whose
   * inflows count against that group's costs (e.g. {"Investment Property":
   * ["Winnemac"]} nets rental income against property costs).
   */
  offsets: Record<string, string[]>;
  /** Secret gist id for observed.md publishing (set automatically on first --gist) */
  gistId: string;
}

/** Floor in effect for a given "yyyy-mm" month; 0 if unset/no entry yet. */
export function floorForMonth(floor: FloorSchedule, month: string): number {
  if (typeof floor === "number") return floor;
  let best = 0;
  let bestKey = "";
  for (const [key, value] of Object.entries(floor)) {
    if (key <= month && key >= bestKey) {
      bestKey = key;
      best = value;
    }
  }
  return best;
}

export function describeFloor(floor: FloorSchedule): string {
  if (typeof floor === "number") {
    return floor > 0 ? `$${floor.toLocaleString("en-US")}/mo (flat)` : "_not set_";
  }
  const entries = Object.entries(floor).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "_not set_";
  return entries
    .map(([m, v]) => `$${v.toLocaleString("en-US")}/mo ${m === "0000-01" ? "(baseline)" : `from ${m}`}`)
    .join("; ");
}

const CONFIG_DIR = join(homedir(), ".config", "ynab-agent");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_DB = join(homedir(), ".local", "share", "ynab-agent", "ynab.db");

const DEFAULTS: Config = {
  budgetId: "last-used",
  dbPath: DEFAULT_DB,
  expenseFloor: 0,
  largeTxThreshold: 1000,
  floorExcludeGroups: [],
  offsets: {},
  gistId: "",
};

export function loadConfig(): Config {
  let fileCfg: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      console.error(`warning: could not parse ${CONFIG_PATH}, using defaults`);
    }
  }
  return { ...DEFAULTS, ...fileCfg };
}

export function saveConfig(cfg: Partial<Config>): Config {
  const merged = { ...loadConfig(), ...cfg };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function getToken(): string {
  const token = process.env.YNAB_TOKEN;
  if (!token) {
    throw new Error(
      "YNAB_TOKEN is not set. Create a Personal Access Token at " +
        "https://app.ynab.com/settings/developer and export YNAB_TOKEN=<token>."
    );
  }
  return token;
}

export function ensureDirFor(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
