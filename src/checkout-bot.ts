import { ProfileBook } from "./profile-book";
import { FoetexApiClient } from "./api";
import type {
  Cart,
  CheckoutConfig,
  DeliveryOptionsResponseItem,
  Profile,
  SelectedDelivery
} from "./types";

const HARDCODED_PAYMENT_METHOD = "ALL";
const HARDCODED_DELIVERY_PROVIDER = "STANDARD";
const HARDCODED_DELIVERY_CHOICE_ID = "";
const HARDCODED_TERMS_ACCEPTED = true;
const HARDCODED_TERMS_URL = "https://www.foetex.dk/handelsbetingelser";
const HARDCODED_ACCEPT_URL = "https://www.foetex.dk/kvittering";
const HARDCODED_CANCEL_URL = "https://www.foetex.dk/kurv";
const DIBS_PAY_ENDPOINT = "https://checkout.dibspayment.eu/api/v1/pay";

function normalizeProvider(value: string): string {
  return value.toString().trim().toUpperCase().replace(/[-\s]+/g, "_");
}

function pickDeliveryChoices(
  deliveryOptionsResponse: DeliveryOptionsResponseItem[],
  preferredProvider: string,
  preferredChoiceId: string
): SelectedDelivery[] {
  if (!Array.isArray(deliveryOptionsResponse) || deliveryOptionsResponse.length === 0) {
    return [];
  }

  const normalizedPreferredProvider = normalizeProvider(preferredProvider);

  return deliveryOptionsResponse
    .map((delivery) => {
      const options = Array.isArray(delivery.deliveryOptions) ? delivery.deliveryOptions : [];

      let option = preferredChoiceId
        ? options.find(
            (candidate) =>
              Array.isArray(candidate.choices) &&
              candidate.choices.some((choice) => choice.id === preferredChoiceId)
          )
        : undefined;

      if (!option) {
        option = options.find(
          (candidate) => normalizeProvider(candidate.provider || "") === normalizedPreferredProvider
        );
      }

      if (!option) {
        throw new Error(
          `Preferred delivery provider '${preferredProvider}' not found for delivery '${delivery.id}'. Available providers: ${options
            .map((candidate) => candidate.provider)
            .filter((provider): provider is string => Boolean(provider))
            .join(", ")}`
        );
      }

      const choice = preferredChoiceId
        ? option.choices?.find((candidate) => candidate.id === preferredChoiceId)
        : option.choices?.[0];

      if (!delivery.id || !option.provider || !choice?.id) {
        return null;
      }

      return {
        deliveryId: delivery.id,
        deliveryOptionId: choice.id,
        deliveryOptionProvider: option.provider
      };
    })
    .filter((choice): choice is SelectedDelivery => Boolean(choice));
}

export class CheckoutBot {
  constructor(
    private readonly api: FoetexApiClient,
    private readonly config: CheckoutConfig
  ) {}

  async run(): Promise<void> {
    logStep(this.config.taskId, "Starting checkout run", {
      productId: this.config.productId,
      quantity: this.config.quantity,
      profileId: this.config.profileId
    });

    const profileBook = ProfileBook.fromCsv(this.config.profileCsvPath);
    const profile = profileBook.getProfile(this.config.profileId);
    logStep(this.config.taskId, "Loaded profile", { profileId: profile.profileId });

    logStep(this.config.taskId, "Creating cart");
    const createdCart = await this.api.request<Cart>("/carts", {
      method: "POST",
      body: { managedDevice: false }
    });

    const cartId = createdCart.id;
    if (!cartId) {
      throw new Error(`Cart creation returned no id: ${JSON.stringify(createdCart)}`);
    }
    logStep(this.config.taskId, "Cart created", { cartId });

    let latestCart = await this.addLineItemWithRetry(cartId);
    logStep(this.config.taskId, "Line item added", {
      cartId,
      productId: this.config.productId,
      quantity: this.config.quantity
    });

    logStep(this.config.taskId, "Setting shipping address", { cartId });
    latestCart = await this.api.request<Cart>(`/carts/${cartId}/shipping-address`, {
      method: "PUT",
      body: profile.address
    });
    logStep(this.config.taskId, "Shipping address set", { cartId });

    logStep(this.config.taskId, "Setting billing address", { cartId });
    latestCart = await this.api.request<Cart>(`/carts/${cartId}/billing-address`, {
      method: "PUT",
      body: profile.address
    });
    logStep(this.config.taskId, "Billing address set", { cartId });

    if (this.config.deliveryType === "ONLINE") {
      logStep(this.config.taskId, "Fetching delivery options", { cartId });
      const deliveryOptions = await this.api.request<DeliveryOptionsResponseItem[]>(
        `/carts/${cartId}/delivery-options?brand=foetex.dk`
      );
      const selectedDeliveries = pickDeliveryChoices(
        deliveryOptions,
        HARDCODED_DELIVERY_PROVIDER,
        HARDCODED_DELIVERY_CHOICE_ID
      );

      if (selectedDeliveries.length === 0) {
        throw new Error(`No delivery options available for cart ${cartId}`);
      }

      logStep(this.config.taskId, "Applying delivery selection", {
        cartId,
        selectedDeliveries: selectedDeliveries.length
      });
      latestCart = await this.api.request<Cart>(`/carts/${cartId}/delivery`, {
        method: "POST",
        body: selectedDeliveries
      });
      logStep(this.config.taskId, "Delivery selected", { cartId });
    }

    const hash = latestCart.hash;
    if (!hash) {
      throw new Error(`Cart hash missing before payment init: ${JSON.stringify(latestCart)}`);
    }

    logStep(this.config.taskId, "Initializing payment", { cartId });
    const paymentInitResult = await this.api.request<unknown>(`/carts/${cartId}/payments`, {
      method: "POST",
      body: {
        paymentMethod: HARDCODED_PAYMENT_METHOD,
        cartId,
        site: "foetex",
        acceptUrl: HARDCODED_ACCEPT_URL,
        cancelUrl: HARDCODED_CANCEL_URL,
        termsAndConditionsAccepted: HARDCODED_TERMS_ACCEPTED,
        hash,
        termsAndConditionsUrl: HARDCODED_TERMS_URL
      }
    });

    const paymentUrl = extractPaymentUrl(paymentInitResult);
    const paymentContext = extractHostedPaymentContext(paymentUrl);
    logStep(this.config.taskId, "Payment initialized", {
      cartId,
      checkoutKey: mask(paymentContext.checkoutKey),
      paymentId: mask(paymentContext.paymentId)
    });
    const amountConfirmedByConsumer = extractAmountConfirmedByConsumer(paymentInitResult, latestCart);
    logStep(this.config.taskId, "Submitting card payment", {
      cartId,
      amountConfirmedByConsumer
    });
    const payResult = await submitCardPayment(
      profile,
      paymentContext.checkoutKey,
      paymentContext.paymentId,
      amountConfirmedByConsumer
    );
    logStep(this.config.taskId, "Card payment submitted", {
      cartId,
      is3DsRequired: Boolean(payResult.is3DsRequired),
      redirectUrl: payResult.redirectUrl || null
    });

    if (payResult.is3DsRequired && payResult.redirectUrl) {
      logStep(this.config.taskId, "Preloading 3DS redirect URL", {
        redirectUrl: payResult.redirectUrl
      });
      const preloadResult = await preloadThreeDsRedirect(payResult.redirectUrl);
      logStep(this.config.taskId, "3DS redirect preload finished", preloadResult);
    }

    const productImageUrl = extractProductImageUrl(latestCart, this.config.productId);
    try {
      await sendDiscordCheckoutNotification(this.config.discordWebhookUrl, {
        profileId: this.config.profileId,
        taskId: this.config.taskId,
        productId: this.config.productId,
        quantity: this.config.quantity,
        cartId,
        paymentUrl,
        productImageUrl,
        is3DsRequired: payResult.is3DsRequired,
        redirectUrl: payResult.redirectUrl
      });
      logStep(this.config.taskId, "Checkout notification sent", { cartId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[task ${this.config.taskId}] discord webhook warning: ${message}`);
    }

    logStep(this.config.taskId, "Checkout run complete", { cartId, paymentUrl });

    console.log(
      JSON.stringify(
        {
          cartId,
          taskId: this.config.taskId,
          productId: this.config.productId,
          retryDelayMs: this.config.retryDelayMs,
          maxRetries: this.config.maxRetries,
          quantity: this.config.quantity,
          deliveryType: this.config.deliveryType,
          profileId: this.config.profileId,
          hash,
          checkoutRedirectUrl: paymentInitResult,
          paymentUrl,
          payResult
        },
        null,
        2
      )
    );
  }

  private async addLineItemWithRetry(cartId: string): Promise<Cart> {
    const totalAttempts = this.config.maxRetries + 1;

    for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
      try {
        logStep(this.config.taskId, "Attempting add-to-cart", {
          cartId,
          attempt,
          totalAttempts
        });
        return await this.api.request<Cart>(`/carts/${cartId}/line-items`, {
          method: "POST",
          body: {
            productId: this.config.productId,
            quantity: this.config.quantity,
            deliveryType: this.config.deliveryType
          }
        });
      } catch (error) {
        if (attempt === totalAttempts) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Unable to add product ${this.config.productId} to cart after ${totalAttempts} attempts: ${message}`
          );
        }

        console.warn(
          `[task ${this.config.taskId}] add-to-cart attempt ${attempt}/${totalAttempts} failed; retrying in ${this.config.retryDelayMs}ms`
        );
        await sleep(this.config.retryDelayMs);
      }
    }

    throw new Error("Add-to-cart retry loop exited unexpectedly");
  }
}

function logStep(taskId: string, message: string, metadata?: Record<string, unknown>): void {
  if (metadata && Object.keys(metadata).length > 0) {
    console.log(`[task ${taskId}] ${message}`, metadata);
    return;
  }

  console.log(`[task ${taskId}] ${message}`);
}

function mask(value: string): string {
  if (value.length <= 8) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function sendDiscordCheckoutNotification(
  webhookUrl: string,
  details: {
    profileId: string;
    taskId: string;
    productId: string;
    quantity: number;
    cartId: string;
    paymentUrl: string;
    productImageUrl: string | null;
    is3DsRequired: boolean;
    redirectUrl: string | null;
  }
): Promise<void> {
  if (!webhookUrl) {
    return;
  }

  const embed = {
    title: `Checkout successful: ${details.productId}`,
    url: details.paymentUrl,
    description: "Payment URL ready",
    color: 0x2ecc71,
    fields: [
      { name: "Task", value: details.taskId, inline: true },
      { name: "Profile", value: details.profileId, inline: true },
      { name: "Quantity", value: String(details.quantity), inline: true },
      { name: "Product ID", value: details.productId, inline: true },
      { name: "Cart ID", value: details.cartId, inline: true },
      { name: "3DS Required", value: details.is3DsRequired ? "yes" : "no", inline: true },
      { name: "3DS URL", value: details.redirectUrl || "n/a" },
      { name: "Payment URL", value: details.paymentUrl }
    ],
    timestamp: new Date().toISOString()
  } as {
    title: string;
    url: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp: string;
    thumbnail?: { url: string };
  };

  if (details.productImageUrl) {
    embed.thumbnail = { url: details.productImageUrl };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ embeds: [embed] })
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${response.statusText} ${raw}`);
  }
}

type HostedPaymentContext = {
  checkoutKey: string;
  paymentId: string;
};

type PayResponse = {
  is3DsRequired?: boolean;
  redirectUrl?: string;
  isAuthenticationRequired?: boolean;
};

function extractHostedPaymentContext(paymentUrl: string): HostedPaymentContext {
  let parsed: URL;
  try {
    parsed = new URL(paymentUrl);
  } catch {
    throw new Error(`Invalid payment URL from payment init: ${paymentUrl}`);
  }

  const checkoutKey = parsed.searchParams.get("checkoutKey") || "";
  const paymentId = parsed.searchParams.get("paymentId") || parsed.searchParams.get("pid") || "";

  if (!checkoutKey || !paymentId) {
    throw new Error(
      `Missing checkout context in payment URL. checkoutKey='${checkoutKey}', paymentId='${paymentId}'`
    );
  }

  return { checkoutKey, paymentId };
}

function extractAmountConfirmedByConsumer(paymentInitResult: unknown, latestCart: Cart): number {
  const paymentRecord =
    paymentInitResult && typeof paymentInitResult === "object"
      ? (paymentInitResult as Record<string, unknown>)
      : null;

  const directAmount = toPositiveInteger(paymentRecord?.amountConfirmedByConsumer);
  if (directAmount) {
    return directAmount;
  }

  const nestedAmountRecord =
    paymentRecord?.amount && typeof paymentRecord.amount === "object"
      ? (paymentRecord.amount as Record<string, unknown>)
      : null;

  const primaryAmount = toPositiveInteger(nestedAmountRecord?.primary);
  if (primaryAmount) {
    return primaryAmount;
  }

  const latestCartRecord = latestCart as Record<string, unknown>;
  const totalSalesPriceNumber = latestCartRecord.totalSalesPriceNumber;
  if (typeof totalSalesPriceNumber === "number" && Number.isFinite(totalSalesPriceNumber)) {
    const cents = Math.round(totalSalesPriceNumber * 100);
    if (cents > 0) {
      return cents;
    }
  }

  const totalSalesPrice = latestCartRecord.totalSalesPrice;
  if (typeof totalSalesPrice === "string") {
    const normalized = totalSalesPrice.replace(/\./g, "").replace(",", ".").replace(/[^0-9.]/g, "");
    const parsed = Number.parseFloat(normalized);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * 100);
    }
  }

  throw new Error("Unable to determine amountConfirmedByConsumer for DIBS pay request");
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

async function submitCardPayment(
  profile: Profile,
  checkoutKey: string,
  paymentId: string,
  amountConfirmedByConsumer: number
): Promise<{ is3DsRequired: boolean; redirectUrl: string | null }> {
  const payload = {
    type: "card",
    paymentType: {
      card: {
        cardNumber: profile.card.cardNumber,
        cardVerificationCode: profile.card.cardVerificationCode,
        expiryMonth: profile.card.expiryMonth,
        expiryYear: profile.card.expiryYear,
        cardholderName: profile.card.cardholderName
      },
      issuer: detectIssuer(profile.card.cardNumber)
    },
    acceptedTermsAndConditions: true,
    amountConfirmedByConsumer,
    surchargeAmount: 0,
    consumerCheckedSaveNewPaymentMethod: false,
    consumerHasConsentedToRememberingNewDevice: false,
    consumerWantsToBeAnonymous: true,
    language: "da-DK"
  };

  const response = await fetch(DIBS_PAY_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/json",
      checkoutkey: checkoutKey,
      paymentid: paymentId,
      Referer: `https://checkout.dibspayment.eu/v1/?checkoutKey=${checkoutKey}&paymentId=${paymentId}&language=da-DK`
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  let parsed: PayResponse = {};
  try {
    parsed = raw ? (JSON.parse(raw) as PayResponse) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    throw new Error(`DIBS pay request failed: ${response.status} ${response.statusText} ${raw}`);
  }

  return {
    is3DsRequired: Boolean(parsed.is3DsRequired),
    redirectUrl: typeof parsed.redirectUrl === "string" ? parsed.redirectUrl : null
  };
}

function detectIssuer(cardNumber: string): "Visa" | "MasterCard" {
  const digits = cardNumber.replace(/\s+/g, "");
  if (digits.startsWith("4")) {
    return "Visa";
  }

  return "MasterCard";
}

async function preloadThreeDsRedirect(
  redirectUrl: string
): Promise<{ status: number; finalUrl: string; ok: boolean }> {
  const response = await fetch(redirectUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"
    }
  });

  return {
    status: response.status,
    finalUrl: response.url,
    ok: response.ok
  };
}

function extractProductImageUrl(latestCart: Cart, productId: string): string | null {
  const cartRecord = latestCart as Record<string, unknown>;
  const lineItems = cartRecord.lineItems as Record<string, unknown> | undefined;
  const products = lineItems?.products;

  if (!Array.isArray(products)) {
    return null;
  }

  for (const candidate of products) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const product = candidate as Record<string, unknown>;
    if (String(product.productId || "") !== productId) {
      continue;
    }

    const imageUrl = product.image;
    if (typeof imageUrl === "string" && imageUrl.startsWith("http")) {
      return imageUrl;
    }
  }

  return null;
}

function extractPaymentUrl(payload: unknown): string {
  if (typeof payload === "string" && payload.startsWith("http")) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(`Payment initialization did not return a URL: ${JSON.stringify(payload)}`);
  }

  const keysToCheck = ["paymentUrl", "redirectUrl", "url", "href"];
  for (const key of keysToCheck) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === "string" && value.startsWith("http")) {
      return value;
    }
  }

  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (typeof value === "object" && value) {
      try {
        return extractPaymentUrl(value);
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Unable to extract payment URL from payment payload: ${JSON.stringify(payload)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
