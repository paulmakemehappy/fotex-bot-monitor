import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AppSettings = {
  apiBaseUrl: string;
  taskCsvPath: string;
  profileCsvPath: string;
  monitorCsvPath: string;
  monitorStatePath: string;
  discordWebhookUrl: string;
};

type RawSettings = Partial<AppSettings>;

const DEFAULT_SETTINGS: AppSettings = {
  apiBaseUrl: "https://api.sallinggroup.com/v1/ecommerce/foetex",
  taskCsvPath: "./tasks.csv",
  profileCsvPath: "./profile.csv",
  monitorCsvPath: "./monitor.csv",
  monitorStatePath: "./.monitor-state.json",
  discordWebhookUrl: ""
};

export function loadAppSettings(): AppSettings {
  const configPath = resolve(process.cwd(), "config.json");
  if (!existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}`);
  }

  let rawSettings: RawSettings = {};
  try {
    const raw = readFileSync(configPath, "utf8");
    rawSettings = raw.trim() ? (JSON.parse(raw) as RawSettings) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config.json: ${message}`);
  }

  return {
    apiBaseUrl: rawSettings.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl,
    taskCsvPath: rawSettings.taskCsvPath || DEFAULT_SETTINGS.taskCsvPath,
    profileCsvPath: rawSettings.profileCsvPath || DEFAULT_SETTINGS.profileCsvPath,
    monitorCsvPath: rawSettings.monitorCsvPath || DEFAULT_SETTINGS.monitorCsvPath,
    monitorStatePath: rawSettings.monitorStatePath || DEFAULT_SETTINGS.monitorStatePath,
    discordWebhookUrl: rawSettings.discordWebhookUrl || DEFAULT_SETTINGS.discordWebhookUrl
  };
}
