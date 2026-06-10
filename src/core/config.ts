import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  /** YNAB budget ID; "last-used" works for most single-budget setups */
  budgetId: string;
  /** Path to the local SQLite mirror */
  dbPath: string;
  /** Modeled monthly expense floor in dollars (used by observe drift report) */
  expenseFloor: number;
  /** Transactions above this (dollars, absolute) get flagged by observe */
  largeTxThreshold: number;
}

const CONFIG_DIR = join(homedir(), ".config", "ynab-agent");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const DEFAULT_DB = join(homedir(), ".local", "share", "ynab-agent", "ynab.db");

const DEFAULTS: Config = {
  budgetId: "last-used",
  dbPath: DEFAULT_DB,
  expenseFloor: 0,
  largeTxThreshold: 1000,
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
