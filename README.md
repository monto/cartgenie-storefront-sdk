# CartGenie Storefront SDK

TypeScript SDK for the CartGenie Storefront API. Wraps auth, the cart lifecycle, and checkout so a headless storefront (Next.js, Lovable, plain HTML — anything that runs JS) is a few calls instead of hand-wired REST.

Zero runtime dependencies; works in the browser and in Node ≥ 18 (native `fetch`).

The canonical API contract lives in this repository at [`docs/storefront-api.md`](docs/storefront-api.md) (also shipped inside the npm package). The SDK follows it exactly — endpoint shapes, the two address key-sets, `checkout=1` handling, and the self-describing payment `payload` are all encoded here so integrators don't have to remember them.

## Install

```bash
npm install @cartgenie/storefront
```

## Quickstart

```ts
import { CartGenie } from '@cartgenie/storefront';

const cartgenie = new CartGenie({
  apiKey: process.env.CARTGENIE_PUBLIC_API_KEY!,
  // baseUrl defaults to production; override it for testing or self-hosted setups.
});

// Catalog
const { data: products } = await cartgenie.products.list({ limit: 50 });
const product = await cartgenie.products.get('t-shirt');
const { data: categories } = await cartgenie.categories.list();

// Cart — created on first addItem; the guid persists in localStorage automatically
const variant = product.variants[0];
if (!variant) {
  throw new Error('Product has no purchasable variants');
}
await cartgenie.cart.addItem({ product_variant_id: variant.id, quantity: 1 });
// Several at once: await cartgenie.cart.addItems([{ product_variant_id: 11 }, { product_variant_id: 12 }]);

let cart = await cartgenie.cart.get();
console.log(cart.checkout?.formatted_total);

// Checkout — bootstrap FIRST: countries and regions come from the API only.
// Render country/region as selects bound to these ids; free-text values are rejected.
const bootstrap = await cartgenie.checkout.get();
const country = bootstrap.billing_countries[0]!;           // e.g. { id: 'us', regions: [{ id: 'us-ca', ... }] }
const region = country.jurisdiction_region_required ? country.regions[0]!.id : country.id;

await cartgenie.checkout.setEmail('jane@example.com', 'Jane Doe');
cart = await cartgenie.checkout.setAddress({
  country: country.id, region, city: 'San Francisco',
  address_line_one: '123 Main St', postal_code: '94105', name: 'Jane Doe',
});

// Physical goods: pick a shipping method before placing the order
if (cart.checkout?.has_shipping) {
  await cartgenie.checkout.setJurisdictions('us-ca');
  const shippingMethods = await cartgenie.checkout.shippingMethods('us-ca', '94105');
  const method = shippingMethods[0];
  if (!method) {
    throw new Error('No shipping methods matched the address');
  }
  await cartgenie.checkout.setShippingMethod(method.id);
}

const methods = await cartgenie.checkout.paymentMethods();
// methods[n].payload tells you which fields each gateway needs — render the form from it.
// methods[n].data carries the visible payment OPTIONS: for stripe, data.methods is the map of
// enabled sub-methods (card / klarna / apple_pay / google_pay / link) — offer exactly those keys.

const result = await cartgenie.checkout.placeOrder({
  customer_email: 'jane@example.com',
  customer_name: 'Jane Doe',
  payment_method: 'dummy',
  card: { number: '4242424242424242', expiry_month: 6, expiry_year: 2030, cvv: '123' },
  billing_address: {
    full_name: 'Jane Doe', country: 'us', region: 'us-ca', city: 'San Francisco',
    line_one: '123 Main St', zip: '94105', confirmed: true,
  },
});

switch (result.payment?.state) {
  case 'success':
    // order_name lives at the top level of the result, next to `payment`.
    // The SDK clears the stored cart guid automatically after success.
    console.log(`Order placed: ${result.order_name}`);
    break;
  case 'redirect':
    location.href = result.payment.redirect_url!;
    break;
  default:
    // 'error' / 'cancelled' — show result.payment?.message
    break;
}
```

## Payment forms from `payload`

`checkout.paymentMethods()` returns each gateway with a `payload`: a map of Place-Order body field (dotted path) to its validation rules. Render inputs from it instead of hardcoding per gateway:

```ts
const dummy = methods.find((m) => m.type === 'dummy');
// dummy.payload = { "card.number": ["required"], "card.expiry_month": ["required","integer","min:1","max:12"], ... }
```

Test cards for the `dummy` gateway: `4242424242424242` (approved), `1313131313131313` (declined).

### Payment options

**A shopper picks a payment method (Card, Klarna, Apple Pay, PayPal, a bank transfer), never a gateway.** `checkout.paymentOptions()` flattens every gateway into that flat list — never render the gateway `type` ("Stripe", "PayPal") as a choice:

```ts
const options = await cartgenie.checkout.paymentOptions();
// each: { id, label, gateway, method?, kind, stripe?, data? }
// kinds: 'stripe-card' | 'stripe-wallet' | 'stripe-redirect' | 'paypal' | 'offline' | 'card-fields'
```

Render one selectable option per entry using `option.label` — **except wallet options, which must pass the device probe first (next section)**. On submit send `payment_method: option.gateway`, plus the field for its `kind`:

- `stripe-card` → Stripe Elements card; `stripe_payment_method` = the created `pm_...` id
- `stripe-wallet` → filter through `probeWalletSupport()` first; on submit `payWithWallet()` — both helpers ship in this SDK
- `stripe-redirect` (Klarna, iDEAL, Bancontact, …) → **no Stripe.js at all**: `stripe_payment_method: option.method` (the literal key); the response comes back `payment.state === 'redirect'` → send the shopper to `payment.redirect_url`
- `paypal` → just `payment_method: option.gateway`; handle the `redirect` state
- `offline` → show `option.data.instructions_html`, send `offline_payment_method: option.method`
- `card-fields` → the `dummy` test gateway's plain card form, send the `card` object

`placeOrder()` throws early if a stripe order is missing `stripe_payment_method` — there is no pay-after-order flow.

### Wallet availability — `probeWalletSupport()` before rendering

Apple Pay exists only in Safari with a wallet card; Google Pay needs Chrome with a saved card. **Never render a wallet option unchecked — filter the list through the probe helper:**

```ts
import { loadStripe } from '@stripe/stripe-js';
import { probeWalletSupport } from '@cartgenie/storefront';

const stripeOpt = options.find((o) => o.stripe)!;
const stripe = await loadStripe(stripeOpt.stripe!.publishableKey, { stripeAccount: stripeOpt.stripe!.accountId });

const visibleOptions = await probeWalletSupport(stripe!, options);
```

`probeWalletSupport()` runs ONE `canMakePayment()` for all wallets with fixed arguments (`total: { label: 'Detect', amount: 1 }`, country from the API force-uppercased — a lowercase country makes `paymentRequest()` throw, and a swallowed throw silently hides every wallet), applies `disableWallets: ['link']` when the store disables Link or serves it inline in the Card Element, and filters by each option's `wallet` capability key. Non-wallet options pass through untouched; on `null` capability or a probe error the wallet options are dropped, never thrown.

**Framework footgun (React/Vue effects):** the probe result is cached per Stripe instance, so calling `probeWalletSupport()` on every re-render is safe — it never re-probes. Do NOT hand-roll this with a cancel-on-cleanup effect: cancelling the in-flight probe while a run-once guard is already set hides wallets for the rest of the session. And never probe with the live cart total — Chrome rate-limits `canMakePayment` per origin when the arguments vary, silently answering `false` for ~30 minutes on your domain only.

**Link masks wallets inside a Payment Request.** Within one `paymentRequest`, Link takes priority: when it is available, `canMakePayment()` answers `{ link: true, googlePay: false, applePay: false }` — Google/Apple Pay look unavailable even though they are. That is why `disableWallets: ['link']` must be applied both in the probe AND in the request you `show()` whenever Link lives in the Card Element (`option.stripe.linkInCardElement`) or is switched off (`option.stripe.disableLink`) — the helpers do this automatically. `disableWallets` is a `paymentRequest`-only option: it never touches the inline Link widget in the Card Element, so Link-in-card and Google/Apple Pay coexist because they live in DIFFERENT elements, not inside one Payment Request.

### Card payments (`stripe-card`)

Card fields are Stripe-hosted Elements (`@stripe/stripe-js`) — never your own inputs:

```ts
const elements = stripe!.elements();
const card = elements.create('card');
card.mount('#card-element');

const { paymentMethod } = await stripe!.createPaymentMethod({
  type: 'card',
  card,
  billing_details: { name, email, address: { line1, city, state, postal_code, country } },
});
await cartgenie.checkout.placeOrder({
  ...order,
  payment_method: 'stripe',
  stripe_payment_method: paymentMethod!.id,
});
```

`payment.state === 'redirect'` in the result means 3-D Secure — send the shopper to `payment.redirect_url`.

When the store serves Link inline (`option.stripe.linkInCardElement === true`), the Card Element itself shows the Link autofill widget ("link · VISA · 4242") — that's an account-level Stripe feature, needs no extra code, and is unaffected by `disableWallets`. `option.stripe.disableLink === true` means Link is switched off for the store entirely and won't appear in the card either.

### Wallet payments (`stripe-wallet`) — use `payWithWallet()`

When the (probed) wallet option is selected and the shopper hits Pay, call `payWithWallet()` **directly in the click handler** (the native sheet needs the user gesture) — no button element needed:

```ts
import { payWithWallet } from '@cartgenie/storefront';

const walletOption = visibleOptions.find((o) => o.kind === 'stripe-wallet')!;

// ⚠️ VALIDATE BEFORE THE SHEET OPENS. The sheet appears instantly, and a
// missing required field (customer_email!) otherwise surfaces as a 422 only
// AFTER the shopper confirms payment. The rules come from the gateway's
// `payload` in paymentMethods():
const missing = cartgenie.checkout.validateOrder(order, stripeGateway.payload);
if (missing.length) return showFieldErrors(missing);

const result = await payWithWallet(stripe!, walletOption, order, (input) =>
  cartgenie.checkout.placeOrder(input, { idempotencyKey: crypto.randomUUID() }),
);
if (result.payment?.state === 'redirect') location.href = result.payment.redirect_url!;
```

`payWithWallet()` does the fragile parts for you: it builds the `paymentRequest` from `option.data.options` (country force-uppercased), **awaits `canMakePayment()` on that same instance before `show()`** — skipping that call is Stripe's `IntegrationError: canMakePayment() must be called before show()`, the single most common wallet crash — fills empty `customer_email` / `customer_name` from the wallet sheet, completes the sheet with `success`/`fail` from the Place Order outcome, and rejects with a `CartGenieError` when the shopper closes the sheet.

<details>
<summary>What it does under the hood (only if you need the raw flow)</summary>

```ts
const paymentRequest = stripe.paymentRequest({ ...walletOptions, ...(disableLink ? { disableWallets: ['link'] } : {}) });
paymentRequest.on('paymentmethod', async (ev) => { /* placeOrder + ev.complete(...) */ });
await paymentRequest.canMakePayment(); // ⚠️ REQUIRED on this exact instance before show()
paymentRequest.show();
```

</details>

`walletOptions.requestShipping` is `false` when the checkout form already collected the address (the usual case). The `disableWallets: ['link']` exclusion follows `linkInCardElement || disableLink` (see the callout in the probe section): it unmasks Google/Apple Pay inside the Payment Request and never affects the inline Link widget in the Card Element.

### Redirect methods (`stripe-redirect`: Klarna, iDEAL, Bancontact, Afterpay, Twint)

The simplest flow — no Stripe.js involved. Send the literal method key; the server prepares the payment and returns the approval redirect:

```ts
const klarna = visibleOptions.find((o) => o.id === 'stripe:klarna')!;
const result = await cartgenie.checkout.placeOrder(
  {
    ...order,
    payment_method: klarna.gateway,
    stripe_payment_method: klarna.method!,
    // Where the shopper lands after approving (or cancelling) on the provider's
    // site. Must be a URL on your store's registered site host.
    return_url: `${location.origin}/checkout/complete`,
  },
  { idempotencyKey: crypto.randomUUID() },
);
if (result.payment?.state === 'redirect') location.href = result.payment.redirect_url!;
```

When the cart ships, `shipping_address.email` is required — copy the customer's email into both address objects.

#### Handling the return

After the shopper approves the payment on the provider's site, the platform redirects them to your `return_url` (or your store's site root when none was sent) with `?cartgenie_return=success|cancel&cart=<guid>` appended. Detect it on page load:

```ts
import { parseCheckoutReturn } from '@cartgenie/storefront';

const checkoutReturn = parseCheckoutReturn(location.search);
if (checkoutReturn?.status === 'success') {
  cartgenie.cart.reset(); // the cart is finalized — drop the stored guid
  // show the order confirmation screen
} else if (checkoutReturn?.status === 'cancel') {
  // show "payment cancelled" and offer to retry — the cart is still open
}
```

The return URL is revisit-safe: refreshing it lands on the same confirmation.

## Concurrency and double-submit safety

Cart mutations are serialized per `CartGenie` instance: parallel `addItem` calls queue, so the first one creates the cart and the rest join it. You can fire add-to-cart handlers without awaiting the previous one.

`placeOrder()` is guarded against double submission **within a single `CartGenie` instance**: while one checkout request is in flight, further calls throw immediately instead of creating a second order. A deliberate retry after the first call settles is allowed. Multiple tabs or instances are not covered by this guard — cross-tab safety relies on the server-side idempotency key below. For retry-after-timeout safety, pass a per-attempt idempotency key — it is sent as the `Idempotency-Key` header, and the API replays the original response for a retry whose key already produced an order (response carries `Idempotency-Replay: true`) instead of creating a duplicate:

```ts
const attemptKey = crypto.randomUUID(); // generate once per checkout attempt, reuse on retry
await cartgenie.checkout.placeOrder(order, { idempotencyKey: attemptKey });
```

Never auto-retry a checkout that failed with an ambiguous error (timeout, network) without an idempotency key — with one, the retry is safe.

## Errors

Every failed request throws a typed error:

- `CartGenieError` — non-2xx API response. For HTTP 422, dotted server keys are pre-mapped for forms via `fieldErrors()`; for HTTP 429, `retryAfterSeconds` carries the server's `Retry-After`.
- `CartGenieProtocolError` — 2xx response whose body fails the contract checks: the `{ data }` envelope, container types, and the key model fields the SDK renders from (cart `guid` + `items`, product `id`/`slug`/`name`/`variants`, category `id`/`slug`/`name`, checkout `payment.state`). Fields beyond those are passed through as-is.
- `CartGenieNetworkError` — the request never reached the API (offline, DNS, CORS, abort); inspect `cause`.

```ts
import { CartGenieError } from '@cartgenie/storefront';

try {
  await cartgenie.checkout.placeOrder(order);
} catch (e) {
  if (e instanceof CartGenieError && e.isValidationError) {
    e.fieldErrors(); // { card: { number: ["The Card Number field is required."] }, ... }
  }
  if (e instanceof CartGenieError && e.isRateLimited) {
    scheduleRetry(e.retryAfterSeconds ?? 5);
  }
}
```

Read calls (`products.*`, `categories.list`, `cart.get`, `checkout.shippingMethods` / `paymentMethods`, `orders.get`) accept an `AbortSignal`:

```ts
const controller = new AbortController();
cartgenie.products.list({ limit: 50, signal: controller.signal });
controller.abort();
```

## Orders

```ts
const order = await cartgenie.orders.get(orderId); // id from a confirmation deep-link or webhook payload
```

## Stale carts

A stored cart guid can stop resolving — a completed checkout finalizes it, or it expires. Any cart call that gets a `404` for the stored guid clears it automatically, and the next `cart.addItem(...)` transparently starts a fresh cart, so a shopper is never stuck with a "cart not found" after ordering. `cart.get()` / `updateItem` / coupon calls still surface the `404` as a `CartGenieError` (the stored guid is already cleared) — treat it as "the cart is gone, show an empty cart".

## SSR / custom persistence

The cart guid persists in `localStorage` by default, namespaced per store — several storefronts (or SDK instances with different API keys) on one origin don't overwrite each other's cart. When storage is unavailable or starts throwing mid-session (Node, Safari private mode, quota, sandboxed iframes), the SDK degrades to an in-memory mirror without losing the current guid. Provide your own adapter (cookies, session) via `storage`:

```ts
const cartgenie = new CartGenie({ apiKey, storage: myCookieStorage });
```

## Overriding the API host

`baseUrl` defaults to the production API. Point it elsewhere for tests or a different environment:

```ts
const cartgenie = new CartGenie({ apiKey, baseUrl: 'https://my-env.example.com/api' });
```

## Development

```bash
npm install
npm test        # unit tests, fully mocked — no network
npm run build   # tsup → dist (esm + cjs + d.ts); also runs automatically on npm pack/publish
```

### Live contract smoke

`tests/smoke.test.ts` runs the real flow (catalog → cart → dummy checkout, including the idempotent-replay check) against a live API. It needs a headless store with the Dummy gateway enabled and skips itself when the env vars are absent, so `npm test` and CI stay hermetic:

```bash
CARTGENIE_SMOKE_BASE_URL=https://<host>/api \
CARTGENIE_SMOKE_API_KEY=<public api key> \
npm run test:smoke
```

The CI workflow runs it automatically when the `CARTGENIE_SMOKE_BASE_URL` / `CARTGENIE_SMOKE_API_KEY` repository secrets are configured. The smoke places a real test order on the target store — point it at a staging/test store only.
