# Foetex Checkout Bot

TypeScript CLI bot that drives the Foetex checkout payment flow via API calls.

## What it does

1. Creates a cart
2. Adds a product line item
3. Sets shipping and billing addresses
4. Selects delivery options for online orders
5. Initializes payment, submits card details to DIBS pay API, and returns payment/3DS payload
6. Sends successful checkouts to Discord webhook with payment URL

## Monitor

`npm run monitor` checks Foetex product feed and matches products against keywords from `monitor.csv`.

The API query is scoped only to `CFH.CollectionCards` (no brand/series filter),
then keywords from `monitor.csv` are matched against product names.

- New matching product -> Discord notification
- Previously out-of-stock matching product becomes in-stock online -> Discord notification
- Monitor query includes non-exposed products (not restricted to `is_exposed:true`)

`monitor.csv` format:

```csv
taskId,keyword
1,pokemon
```

Monitor state is stored in `.monitor-state.json` by default.
Monitor runs continuously and checks every 10 seconds.

## Setup

```bash
npm install
```

Bot settings are loaded from `config.json`.

Bearer token is currently hardcoded in `src/api.ts`.

## Tasks

Products are loaded from `tasks.csv`.

Required format:

```csv
taskId,profileId,productId,quantity,retryDelayMs,maxRetries
1,1,200353696,1,2000,10
```

The first column must be `taskId`.

- `quantity`: line-item quantity for this task
- `profileId`: profile row to use from `profile.csv` for this task
- `retryDelayMs`: wait time between add-to-cart retries
- `maxRetries`: number of retries after the first add-to-cart attempt

All rows in `tasks.csv` are executed concurrently on each run.

Delivery type is fixed to `ONLINE` for all tasks.

## Profiles

Shipping/contact details are loaded from `profile.csv`.
Billing uses the same address as shipping.
Card details used for automatic payment are also loaded from profile.

Required format:

```csv
profile,name,street,postalCode,city,country,mobile,email,cardNumber,cardVerificationCode,expiryMonth,expiryYear,cardholderName
1,Test User,Plantagevej 38,6270,Tonder,DK,04938204,test@example.com,4111111111111111,123,03,31,TEST USER
```

The first column must be `profile`.

Hardcoded checkout values used by the bot:

- paymentMethod: `ALL`
- delivery provider: `STANDARD`
- delivery choice id: empty (provider default)
- terms accepted: `true`
- terms URL: `https://www.foetex.dk/handelsbetingelser`
- accept URL: `https://www.foetex.dk/kvittering`
- cancel URL: `https://www.foetex.dk/kurv`

3DS note:

- The DIBS `/api/v1/pay` response is used directly.
- If `is3DsRequired=true`, use `redirectUrl` from that response for the challenge flow.
- The bot also performs a best-effort GET preload on `redirectUrl` to kick off challenge setup,
  but manual browser interaction may still be required by issuer/bank risk checks.

## Discord webhook

Set `discordWebhookUrl` in `config.json` to receive successful checkout notifications.
The bot also sends a startup ping when a run begins.
Checkout notifications are sent as embeds with clickable title to the payment URL,
plus task/profile/product/cart/quantity fields.

Monitor notifications are sent as Discord embeds with clickable product title,
product image thumbnail, and key fields (purchasable, stock, exposure, price, etc.).

## Run

```bash
npm run checkout
```

## Scripts

- `npm run checkout` - run the bot via tsx
- `npm run monitor` - run monitor keyword scan
- `npm run typecheck` - run TypeScript checks
- `npm run build` - compile to `dist/`
- `npm run start` - run compiled output
