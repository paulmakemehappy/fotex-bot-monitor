import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { loadAppSettings } from "./app-settings";

type MonitorTask = {
  taskId: string;
  keyword: string;
};

type ProductHit = {
  id?: string | number;
  pid?: string | number;
  objectID?: string;
  name?: string;
  product_url?: string;
  canonical_url?: string;
  image_primary?: string;
  is_in_stock_online?: boolean;
  stock_count_online?: number;
  stock_count_status_online?: string;
  sold_online?: boolean;
  is_exposed?: boolean;
  is_reservable?: boolean;
  display_sales_price?: string;
  sales_price?: number;
  online_from?: string;
  epoch_updated_at?: number;
};

type AlgoliaResponse = {
  results?: Array<{
    hits?: ProductHit[];
    page?: number;
    nbPages?: number;
  }>;
};

type MonitorState = {
  tasks: Record<
    string,
    {
      keyword: string;
      products: Record<
        string,
        {
          name: string;
          inStock: boolean;
          lastSeenAt: string;
        }
      >;
    }
  >;
};

const PRODUCTS_ENDPOINT = "https://drp4o45g5t-dsn.algolia.net/1/indexes/*/queries";
const MONITOR_INTERVAL_MS = 10_000;

const ALGOLIA_FILTERS =
  'cfh_nodes:"CFH.CollectionCards"';

const ALGOLIA_ATTRIBUTES = [
  "id",
  "pid",
  "objectID",
  "name",
  "product_url",
  "canonical_url",
  "image_primary",
  "is_in_stock_online",
  "stock_count_online",
  "stock_count_status_online",
  "is_exposed",
  "sold_online",
  "is_reservable",
  "display_sales_price",
  "sales_price",
  "online_from",
  "epoch_updated_at"
];

const HITS_PER_PAGE = 100;
const MAX_PAGES = 20;

async function main(): Promise<void> {
  const settings = loadAppSettings();
  const monitorCsvPath = settings.monitorCsvPath;
  const statePath = settings.monitorStatePath;
  const webhookUrl = settings.discordWebhookUrl;

  const tasks = loadMonitorTasks(monitorCsvPath);
  if (tasks.length === 0) {
    throw new Error(`No monitor tasks found in ${monitorCsvPath}`);
  }

  logMonitor("Monitor started", {
    monitorCsvPath,
    statePath,
    tasks: tasks.length,
    intervalMs: MONITOR_INTERVAL_MS
  });

  if (webhookUrl) {
    logMonitor("Sending startup ping to Discord");
    await sendDiscordMessage(
      webhookUrl,
      [
        "Monitor bot started",
        `Tasks queued: ${tasks.length}`,
        `Started at: ${new Date().toISOString()}`
      ].join("\n")
    );
  } else {
    console.warn("DISCORD_WEBHOOK_URL is not set; monitor notifications will not be sent to Discord.");
  }

  let cycle = 0;
  while (true) {
    cycle += 1;
    logMonitor("Starting monitor cycle", { cycle });
    await runMonitorCycle(tasks, statePath, webhookUrl);
    logMonitor("Monitor cycle finished", { cycle });
    await sleep(MONITOR_INTERVAL_MS);
  }
}

async function runMonitorCycle(
  tasks: MonitorTask[],
  statePath: string,
  webhookUrl: string
): Promise<void> {
  const state = loadState(statePath);
  const products = await fetchProducts();
  const now = new Date().toISOString();
  logMonitor("Fetched products", { count: products.length });

  for (const task of tasks) {
    logTask(task.taskId, "Evaluating task", { keyword: task.keyword });
    const matchedProducts = products.filter((product) => {
      const name = (product.name || "").toLowerCase();
      return name.includes(task.keyword.toLowerCase());
    });
    matchedProducts.sort(sortByNewestRelease);
    logTask(task.taskId, "Keyword matching complete", { matches: matchedProducts.length });

    const previousTaskState = state.tasks[task.taskId]?.products || {};
    const nextTaskProducts: MonitorState["tasks"][string]["products"] = {};

    for (const product of matchedProducts) {
      const productId = getProductId(product);
      if (!productId) {
        continue;
      }

      const name = product.name || "Unnamed product";
      const inStock = isInStockOnline(product);
      const previous = previousTaskState[productId];

      if (!previous) {
        logTask(task.taskId, "Detected new matching product", {
          productId,
          name,
          inStock
        });
        await maybeNotify(
          webhookUrl,
          buildProductEmbed("New product detected", task, product, productId)
        );
      } else if (!previous.inStock && inStock) {
        logTask(task.taskId, "Detected restock", { productId, name });
        await maybeNotify(
          webhookUrl,
          buildProductEmbed("Product restocked online", task, product, productId)
        );
      }

      nextTaskProducts[productId] = {
        name,
        inStock,
        lastSeenAt: now
      };
    }

    state.tasks[task.taskId] = {
      keyword: task.keyword,
      products: nextTaskProducts
    };
  }

  writeFileSync(statePath, JSON.stringify(state, null, 2));
  logMonitor("State updated", { statePath });
}

function loadMonitorTasks(csvPath: string): MonitorTask[] {
  if (!existsSync(csvPath)) {
    throw new Error(`Monitor CSV not found: ${csvPath}`);
  }

  const raw = readFileSync(csvPath, "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  }) as Array<{ taskId?: string; keyword?: string }>;

  if (rows.length === 0) {
    return [];
  }

  const firstHeader = raw.split(/\r?\n/, 1)[0]?.split(",")[0]?.trim().toLowerCase();
  if (firstHeader !== "taskid") {
    throw new Error(`Monitor CSV must have 'taskId' as the first column in ${csvPath}`);
  }

  if (!("keyword" in rows[0])) {
    throw new Error(`Monitor CSV is missing required column 'keyword' in ${csvPath}`);
  }

  return rows.map((row, index) => {
    const taskId = row.taskId?.trim();
    const keyword = row.keyword?.trim();

    if (!taskId) {
      throw new Error(`Monitor CSV row ${index + 2} is missing 'taskId'`);
    }

    if (!keyword) {
      throw new Error(`Monitor CSV row ${index + 2} is missing 'keyword'`);
    }

    return { taskId, keyword };
  });
}

function loadState(statePath: string): MonitorState {
  if (!existsSync(statePath)) {
    return { tasks: {} };
  }

  try {
    const raw = readFileSync(statePath, "utf8");
    if (!raw.trim()) {
      return { tasks: {} };
    }

    const parsed = JSON.parse(raw) as MonitorState;
    if (!parsed.tasks || typeof parsed.tasks !== "object") {
      return { tasks: {} };
    }

    return parsed;
  } catch {
    return { tasks: {} };
  }
}

async function fetchProducts(): Promise<ProductHit[]> {
  const allHits: ProductHit[] = [];
  let page = 0;
  let nbPages = 1;

  while (page < nbPages && page < MAX_PAGES) {
    const payload = await fetchProductsPage(page);
    const result = payload.results?.[0];
    const hits = Array.isArray(result?.hits) ? result.hits : [];
    allHits.push(...hits);

    nbPages = Math.max(1, Number(result?.nbPages || 1));
    page += 1;
  }

  logMonitor("Fetched paginated Algolia results", {
    pagesFetched: page,
    totalPages: nbPages,
    hits: allHits.length,
    hitsPerPage: HITS_PER_PAGE
  });

  return allHits;
}

async function fetchProductsPage(page: number): Promise<AlgoliaResponse> {
  const response = await fetch(PRODUCTS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json; charset=UTF-8",
      "x-algolia-api-key": "f3a34fc94874579eaf3cd39fef660948",
      "x-algolia-application-id": "DRP4O45G5T",
      Referer: "https://www.foetex.dk/"
    },
    body: JSON.stringify(buildProductsRequestBody(page))
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Monitor request failed: ${response.status} ${response.statusText} ${raw}`);
  }

  return (await response.json()) as AlgoliaResponse;
}

function buildProductsRequestBody(page: number): {
  requests: Array<{ indexName: string; params: string }>;
  strategy: string;
} {
  return {
    requests: [
      {
        indexName: "prod_FOETEX_PRODUCTS",
        params: new URLSearchParams({
          query: "",
          attributesToRetrieve: JSON.stringify(ALGOLIA_ATTRIBUTES),
          filters: ALGOLIA_FILTERS,
          distinct: "true",
          page: String(page),
          hitsPerPage: String(HITS_PER_PAGE)
        }).toString()
      }
    ],
    strategy: "none"
  };
}

function getProductId(product: ProductHit): string | null {
  const id = product.id ?? product.pid ?? product.objectID;
  if (id == null) {
    return null;
  }

  return String(id);
}

function isInStockOnline(product: ProductHit): boolean {
  if (typeof product.is_in_stock_online === "boolean") {
    return product.is_in_stock_online;
  }

  if (typeof product.stock_count_online === "number") {
    return product.stock_count_online > 0;
  }

  const status = (product.stock_count_status_online || "").toLowerCase();
  return status === "in_stock" || status === "low_stock";
}

function resolveProductUrl(product: ProductHit): string {
  const path = product.product_url || product.canonical_url;
  if (!path) {
    return "n/a";
  }

  if (path.startsWith("http")) {
    return path;
  }

  return `https://www.foetex.dk${path}`;
}

type DiscordEmbed = {
  title: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
  timestamp?: string;
};

function buildProductEmbed(
  eventTitle: string,
  task: MonitorTask,
  product: ProductHit,
  productId: string
): DiscordEmbed {
  const url = resolveProductUrl(product);
  const purchasable = isPurchasable(product);
  const stockStatus = product.stock_count_status_online || "unknown";
  const stockCount =
    typeof product.stock_count_online === "number" ? String(product.stock_count_online) : "unknown";
  const exposed = typeof product.is_exposed === "boolean" ? (product.is_exposed ? "yes" : "no") : "unknown";
  const soldOnline =
    typeof product.sold_online === "boolean" ? (product.sold_online ? "yes" : "no") : "unknown";
  const reservable =
    typeof product.is_reservable === "boolean" ? (product.is_reservable ? "yes" : "no") : "unknown";
  const price = product.display_sales_price || (typeof product.sales_price === "number" ? String(product.sales_price) : "unknown");

  const embed: DiscordEmbed = {
    title: truncateText(product.name || "Unnamed product", 240),
    url: url !== "n/a" ? url : undefined,
    description: eventTitle,
    color: eventTitle.includes("restocked") ? 0x2ecc71 : 0x3498db,
    fields: [
      { name: "Task", value: task.taskId, inline: true },
      { name: "Keyword", value: task.keyword, inline: true },
      { name: "Product ID", value: productId, inline: true },
      { name: "Purchasable", value: purchasable ? "yes" : "no", inline: true },
      { name: "In Stock Online", value: isInStockOnline(product) ? "yes" : "no", inline: true },
      { name: "Stock Status", value: stockStatus, inline: true },
      { name: "Stock Count", value: stockCount, inline: true },
      { name: "Exposed", value: exposed, inline: true },
      { name: "Sold Online", value: soldOnline, inline: true },
      { name: "Reservable", value: reservable, inline: true },
      { name: "Price", value: price, inline: true }
    ],
    timestamp: new Date().toISOString()
  };

  if (product.image_primary && product.image_primary.startsWith("http")) {
    embed.thumbnail = { url: product.image_primary };
  }

  return embed;
}

async function maybeNotify(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
  if (!webhookUrl) {
    console.log(`${embed.description}: ${embed.title} (${embed.url || "n/a"})`);
    return;
  }

  logMonitor("Sending Discord embed", {
    title: embed.title,
    url: embed.url || null
  });
  await sendDiscordEmbed(webhookUrl, embed);
}

async function sendDiscordMessage(webhookUrl: string, content: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });

  if (response.status === 429) {
    const raw = await response.text();
    console.warn(`Discord webhook rate limited (startup ping skipped): ${raw}`);
    return;
  }

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${raw}`);
  }
}

async function sendDiscordEmbed(webhookUrl: string, embed: DiscordEmbed): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ embeds: [embed] })
  });

  if (response.status === 429) {
    const raw = await response.text();
    console.warn(`Discord webhook rate limited (embed skipped): ${raw}`);
    return;
  }

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${raw}`);
  }
}

function isPurchasable(product: ProductHit): boolean {
  const soldOnline = product.sold_online !== false;
  return soldOnline && isInStockOnline(product);
}

function sortByNewestRelease(a: ProductHit, b: ProductHit): number {
  const aTs = extractReleaseTimestamp(a);
  const bTs = extractReleaseTimestamp(b);
  return bTs - aTs;
}

function extractReleaseTimestamp(product: ProductHit): number {
  if (typeof product.epoch_updated_at === "number" && Number.isFinite(product.epoch_updated_at)) {
    return product.epoch_updated_at * 1000;
  }

  if (typeof product.online_from === "string" && product.online_from.trim()) {
    const isoLike = product.online_from.replace(" ", "T").replace("+00", "Z");
    const parsed = Date.parse(isoLike);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logMonitor(message: string, metadata?: Record<string, unknown>): void {
  if (metadata && Object.keys(metadata).length > 0) {
    console.log(`[monitor] ${message}`, metadata);
    return;
  }

  console.log(`[monitor] ${message}`);
}

function logTask(taskId: string, message: string, metadata?: Record<string, unknown>): void {
  if (metadata && Object.keys(metadata).length > 0) {
    console.log(`[monitor][task ${taskId}] ${message}`, metadata);
    return;
  }

  console.log(`[monitor][task ${taskId}] ${message}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
