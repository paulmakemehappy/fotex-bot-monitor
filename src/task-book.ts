import { existsSync, readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import type { CheckoutTask } from "./types";

type RawTaskRecord = {
  taskId?: string;
  profileId?: string;
  productId?: string;
  quantity?: string;
  retryDelayMs?: string;
  maxRetries?: string;
  [key: string]: string | undefined;
};

export class TaskBook {
  static fromCsv(path: string): TaskBook {
    if (!existsSync(path)) {
      throw new Error(`Tasks CSV not found: ${path}`);
    }

    const raw = readFileSync(path, "utf8");
    const rows = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }) as RawTaskRecord[];

    if (rows.length === 0) {
      throw new Error(`Tasks CSV must include at least one task row: ${path}`);
    }

    const firstHeader = raw.split(/\r?\n/, 1)[0]?.split(",")[0]?.trim().toLowerCase();
    if (firstHeader !== "taskid") {
      throw new Error(`Tasks CSV must have 'taskId' as the first column in ${path}`);
    }

    for (const requiredColumn of ["profileId", "productId", "quantity", "retryDelayMs", "maxRetries"]) {
      if (!(requiredColumn in rows[0])) {
        throw new Error(`Tasks CSV is missing required column '${requiredColumn}' in ${path}`);
      }
    }

    const tasks = new Map<string, CheckoutTask>();
    for (const [index, row] of rows.entries()) {
      const taskId = row.taskId?.trim();
      const profileId = row.profileId?.trim();
      const productId = row.productId?.trim();
      const quantity = parsePositiveInteger(row.quantity, "quantity", index);
      const retryDelayMs = parseNonNegativeInteger(row.retryDelayMs, "retryDelayMs", index);
      const maxRetries = parseNonNegativeInteger(row.maxRetries, "maxRetries", index);

      if (!taskId) {
        throw new Error(`Tasks CSV row ${index + 2} is missing 'taskId'`);
      }

      if (!productId) {
        throw new Error(`Tasks CSV row ${index + 2} is missing 'productId'`);
      }

      if (!profileId) {
        throw new Error(`Tasks CSV row ${index + 2} is missing 'profileId'`);
      }

      tasks.set(taskId, {
        taskId,
        profileId,
        productId,
        quantity,
        retryDelayMs,
        maxRetries
      });
    }

    return new TaskBook(tasks, path);
  }

  constructor(
    private readonly tasks: Map<string, CheckoutTask>,
    private readonly sourcePath: string
  ) {}

  getAllTasks(): CheckoutTask[] {
    return Array.from(this.tasks.values());
  }
}

function parsePositiveInteger(value: string | undefined, field: string, rowIndex: number): number {
  const numericValue = Number.parseInt(value || "", 10);

  if (!Number.isInteger(numericValue) || numericValue < 1) {
    throw new Error(`Tasks CSV row ${rowIndex + 2} has invalid '${field}', expected a positive integer`);
  }

  return numericValue;
}

function parseNonNegativeInteger(
  value: string | undefined,
  field: string,
  rowIndex: number
): number {
  const numericValue = Number.parseInt(value || "", 10);

  if (!Number.isInteger(numericValue) || numericValue < 0) {
    throw new Error(`Tasks CSV row ${rowIndex + 2} has invalid '${field}', expected a non-negative integer`);
  }

  return numericValue;
}
