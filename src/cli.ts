import { FoetexApiClient } from "./api";
import { CheckoutBot } from "./checkout-bot";
import { loadConfig } from "./config";
import type { CheckoutConfig } from "./types";

async function main(): Promise<void> {
  const appConfig = loadConfig();
  if (!appConfig.discordWebhookUrl) {
    console.warn("DISCORD_WEBHOOK_URL is not set; successful checkouts will not be sent to Discord.");
  } else {
    await sendDiscordStartPing(appConfig.discordWebhookUrl, appConfig.tasks.length);
  }
  const { tasks, ...sharedConfig } = appConfig;

  const botRuns = tasks.map(async (task) => {
    const api = new FoetexApiClient(sharedConfig.apiBaseUrl);
    const botConfig: CheckoutConfig = {
      ...sharedConfig,
      ...task
    };
    const bot = new CheckoutBot(api, botConfig);

    await bot.run();
  });

  const results = await Promise.allSettled(botRuns);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");

  if (failures.length > 0) {
    failures.forEach((failure, index) => {
      const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      console.error(`Task failure ${index + 1}: ${reason}`);
    });
    throw new Error(`${failures.length} task(s) failed`);
  }
}

async function sendDiscordStartPing(webhookUrl: string, taskCount: number): Promise<void> {
  const content = [
    "Checkout bot started",
    `Tasks queued: ${taskCount}`,
    `Started at: ${new Date().toISOString()}`
  ].join("\n");

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      const raw = await response.text();
      console.warn(`Discord start ping failed: ${response.status} ${response.statusText} ${raw}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Discord start ping failed: ${message}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
