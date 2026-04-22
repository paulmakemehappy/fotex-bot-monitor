import { loadAppSettings } from "./app-settings";
import { TaskBook } from "./task-book";
import type { AppConfig } from "./types";

export function loadConfig(): AppConfig {
  const settings = loadAppSettings();
  const taskCsvPath = settings.taskCsvPath;
  const taskBook = TaskBook.fromCsv(taskCsvPath);
  const tasks = taskBook.getAllTasks();

  return {
    apiBaseUrl: settings.apiBaseUrl,
    taskCsvPath,
    tasks,
    deliveryType: "ONLINE",
    profileCsvPath: settings.profileCsvPath,
    discordWebhookUrl: settings.discordWebhookUrl
  };
}
