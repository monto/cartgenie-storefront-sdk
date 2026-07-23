# CartGenie Storefront API

REST contract for building a headless storefront (catalog, cart, checkout) against a CartGenie store with no Webflow connection. This document is self-contained: it can be handed verbatim to a developer or an AI agent building the storefront.

Applies to headless stores (`integration_mode = headless`, `headless_store` feature enabled). Catalog listing endpoints and the payment-methods `payload` respond only for headless stores.

## Base URL and authentication

- Base URL: `https://<dashboard-host>/api` (`https://dash.cartgenie.com/api`)
- Every request sends:
  - `Authorization: Bearer <PUBLIC_API_KEY>`
  - `Accept: application/json`
  - `Content-Type: application/json` (on requests with a body)

The public API key is a store-scoped token shown on the headless onboarding success screen (and in the store dashboard). It identifies the store; all endpoints operate on that store's data only.

## Conventions

- Every response wraps the result in `{ "data": ... }`. Paginated collections add `links` and `meta`.
- Money is server-computed and pre-formatted. Never compute totals, tax, or discounts client-side — display the server's `formatted_*` strings; raw numeric fields (`price`, `total`, …) are integer minor units (cents) for display-adjacent logic only.
- Validation failures return HTTP 422 with `errors` keyed by dotted paths (`card.number`, `billing_address.region`). Map each key back to its form field.
- The catalog listing is rate-limited per IP and per store. Slug-based product fetches are exempt. On HTTP 429 back off using the `Retry-After` response header (seconds).

## Catalog

### List products

```
GET /products?limit=50
```

Headless stores only (400 without `slugs` otherwise). Cursor-paginated, ordered by name; `limit` is capped at 100. Follow `links.next` (or `meta.next_cursor`) for subsequent pages.

Each product:

```json
{
  "id": 1,
  "name": "T-Shirt",
  "slug": "t-shirt",
  "images": { "image_url": "...", "image_url_large": "..." },
  "options": [
    { "name": "Color", "slug": "color", "values": [{ "value": "Red", "value_slug": "red" }] }
  ],
  "variants": [ { "id": 11, "slug": "red-l", "sku": "TS-RL", "price": 1900, "formatted_price": "$19.00",
                  "out_of_stock": false, "stock_quantity": 5, "track_inventory": true,
                  "shippable": true, "image_url": "..." } ],
  "kind": "single"
}
```

Notes:

- Add to cart by the variant's `id` (`product_variant_id` below). Do not reconstruct variants from option slugs client-side; per-variant option maps are not in the payload. Render one select per `options[]` entry and track which variant the selection maps to.
- Nullable/inactive fields may be omitted from variant objects.
- Image URLs point at CartGenie-hosted media; hotlink or proxy them as you prefer.

### Fetch specific products by slug

```
GET /products?slugs=t-shirt,mug
```

Returns up to 50 products matching the given slugs. Works for every store type and is exempt from the catalog rate limit.

### Get one product

```
GET /product/{slug}
```

Single product, same shape as the listing.

### List categories

```
GET /categories?limit=50
```

Headless stores only (404 otherwise). Published categories, cursor-paginated, capped at 100:

```json
{ "id": 3, "name": "Apparel", "slug": "apparel", "description": "...",
  "meta_description": "...", "published_at": "2026-07-01T00:00:00+00:00", "main_image_url": "..." }
```

## Cart

Append `?checkout=1` to cart reads and mutations (cart CRUD, items, coupon, email, address) — without it the response omits the `checkout` block (totals, discounts, tax, payment methods). The payment-methods and Place-Order endpoints do not take this parameter.

- Create cart + add first item:
  `POST /cart/item?checkout=1` body `{ "product_variant_id": 11, "quantity": 1 }`
  Returns HTTP 201 with the cart. Persist `data.guid` (e.g. localStorage) — it is the `{cart}` segment in every call below. Multi-item form: `{ "items": [{ "product_variant_id": 11, "quantity": 1 }, ...] }`.
- Add item to existing cart: `POST /cart/{cart}/item?checkout=1` (same body)
- Change quantity: `PUT /cart/{cart}/item/{item}?checkout=1` body `{ "quantity": 2 }`
- Remove item: `DELETE /cart/{cart}/item/{item}?checkout=1`
- Read cart: `GET /cart/{cart}?checkout=1`

Cart response essentials:

- `guid`, `items[]` — each item: `id`, `name`, `slug`, `quantity`, `image_url`, `formatted_price`, `formatted_subtotal`, `options: [{ name, value }]`, `sku`, `stock`, `availability`
- `checkout.formatted_subtotal` / `formatted_total` / `formatted_discount_total` (signed, e.g. `-$0.20`) / `formatted_tax_total` / `formatted_shipping_total`
- `checkout.has_shipping`, `checkout.requires_shipping`, `checkout.requires_billing`
- `checkout.payment_methods[]` — see Payment methods below
- `checkout.discounts[]` — `{ code, discount_type, messages[] }`; render `messages` when a coupon attaches but does not apply
- `checkout.coupon_code` — the currently applied code, `null` when none applies

## Coupons

- Apply: `POST /cart/{cart}/coupon?checkout=1` body `{ "coupon": "SAVE10" }`
- Remove: `DELETE /cart/{cart}/coupon?checkout=1`

Set the customer email (next section) before applying — some discounts resolve against the customer, and without an email the code can attach without applying (`coupon_code` stays `null`, reason in `checkout.discounts[].messages`).

## Checkout bootstrap: countries, regions, jurisdictions

Country and region are **select fields bound to API-provided ids — never free-text inputs**. The store configures which countries it bills and ships to; server-side validation rejects any value that is not in these lists (a typed-in "USA" or "California" fails — only `"us"` / `"us-ca"` ids are accepted). Do not hardcode the lists either:

```
GET /cart/{cart}/checkout
```

Returns the cart (with the `checkout` block) in `data`, plus two top-level arrays next to it:

```json
{
  "data": { ...cart with checkout block... },
  "billing_countries":  [ { "id": "us", "label": "United States", "region_label": "State",
                            "jurisdiction_region_required": true, "per_region_shipping": true,
                            "postal_code_required": true,
                            "regions": [ { "id": "us-ca", "label": "California", "country": "us" } ] } ],
  "shipping_countries": [ { ...same shape..., "has_per_region_methods": true, "has_per_postal_code_methods": true } ]
}
```

- Render the billing country select from `billing_countries` and the shipping country select from `shipping_countries` — they can differ (the store ships to a subset).
- When a country has `jurisdiction_region_required: true`, render a region select from its `regions`; the **region `id` (e.g. `us-ca`) is the jurisdiction** used in `PUT /jurisdiction` and `GET /shipping-methods/{jurisdiction}`. When it's `false`, `regions` is empty and the **country `id` itself is the jurisdiction**.
- `region_label` is the display name for the region field ("State", "Province", …); `postal_code_required` drives the ZIP field.
- On the first call the API pre-selects a `shipping_jurisdiction` from the caller's IP when the cart requires shipping — treat it as a default, not a constraint.

## Checkout sequence

Run in this order:

1. `GET /cart/{cart}/checkout` — bootstrap: totals, `billing_countries` / `shipping_countries` for the address selects (section above).
2. `PATCH /cart/{cart}/email` — `{ "email": "...", "name": "..." }`
3. `PATCH /cart/{cart}/address` — exact keys:
   `{ "country": "us", "region": "us-ca", "city": "...", "address_line_one": "...", "address_line_two": "...", "postal_code": "...", "name": "...", "phone": "...", "email": "..." }`
   All keys optional per store requirements; `country` is the CartGenie country id — a lowercase ISO code string like `"us"`, not a number. There is no `confirmed` key on this endpoint. The response returns the refreshed cart including recalculated `payment_methods`.
4. Only when `checkout.has_shipping` is `true`:
   - `PUT /cart/{cart}/jurisdiction` — `{ "billing": "us-ca", "shipping": "us-ca" }` (jurisdiction = region id, or country id when the country has no regions)
   - `GET /cart/{cart}/shipping-methods/{jurisdiction}/{postalCode?}` — list of matched methods
   - `PATCH /cart/{cart}/shipping-method/{method}` — select one by id
5. `GET /cart/{cart}/payment-methods`
6. `POST /cart/{cart}/checkout` — Place Order (next section)

## Payment methods

```
GET /cart/{cart}/payment-methods
```

```json
{ "data": [ {
  "type": "dummy",
  "payload": {
    "card.number":       ["required"],
    "card.expiry_month": ["required", "integer", "min:1", "max:12"],
    "card.expiry_year":  ["required", "integer", "min:2026", "max:2036"],
    "card.cvv":          ["required", "digits_between:3,4"]
  },
  "data": []
} ] }
```

- `type` — the **gateway**, not a customer-facing choice: `dummy`, `stripe`, `test-stripe`, `paypal`, `test-paypal`, `offline`. **Never render `type` as the payment option** (a radio labelled "Stripe" is wrong — the shopper picks Card / Klarna / Apple Pay, not "Stripe").
- `payload` — self-describing requirements: a map of Place-Order body field (dotted path) → validation rules (strings only). `null` for non-headless stores; empty object = no extra fields beyond the base body. For stripe this is just `{ "stripe_payment_method": ["required"] }` — one token covers every sub-method.
- `data` — **the source of the payment options the customer actually sees.**

### Rendering the payment options

**A customer picks a payment METHOD (Card, Klarna, Apple Pay, PayPal, a bank transfer) — never a gateway.** The API groups methods under gateways (`stripe` has a `data.methods` map, `paypal` another, `offline` another, `dummy` is a test card form), so a single radio labelled with the gateway `type` ("Stripe", "PayPal") is wrong.

The SDK flattens all of this for you — `checkout.paymentOptions()` returns one entry per customer-facing method across every gateway, each tagged with a `kind` telling you how to complete it:

```ts
const options = await cartgenie.checkout.paymentOptions();
// [{ id:'stripe:card', label:'Card', gateway:'stripe', method:'card', kind:'stripe-card', stripe:{ publishableKey, accountId } },
//  { id:'stripe:apple_pay', label:'Apple Pay', kind:'stripe-wallet', ... },
//  { id:'stripe:klarna', label:'Klarna', kind:'stripe-redirect', ... },
//  { id:'paypal:paypal', label:'PayPal', gateway:'paypal', kind:'paypal' },
//  { id:'offline:bank_transfer', label:'Bank transfer', gateway:'offline', kind:'offline', data:{ instructions_html } }]
```

Render one option per entry, using `option.label`, and always send `payment_method: option.gateway` in the Place Order body. Complete each by its `kind`:

- `stripe-card` — mount a Stripe Elements card field (`option.stripe.publishableKey` / `.accountId`), `createPaymentMethod({ type: 'card', card, billing_details })`, send its `pm_…` id as `stripe_payment_method`.
- `stripe-wallet` (Apple Pay / Google Pay / Link) — **capability-gated: render ONLY after probing.** With the SDK, filter the option list through `probeWalletSupport(stripe, options)` (one fixed-args `canMakePayment()` probe for all wallets, result cached per Stripe instance) and submit with `payWithWallet(stripe, option, order, placeOrder)`. Doing it by hand instead: probe with `stripe.paymentRequest({ country: <UPPERCASE two-letter>, currency, total: { label: 'Detect', amount: 1 }, …disableWallets rule below })`, check `canMakePayment()`, and show the option only when its `option.wallet` key is `true`; on submit build the paymentRequest from `option.data.options`, **await `canMakePayment()` on that same instance before `show()`** (Stripe throws an `IntegrationError` otherwise), take `ev.paymentMethod.id` from the `paymentmethod` event as `stripe_payment_method`, and call `ev.complete('success'|'fail')` after Place Order settles. Validate the required Place-Order fields (the gateway's `payload` rules) BEFORE `show()` — the sheet opens instantly and a 422 otherwise appears only after the shopper confirms. Never probe with the live cart total and never cancel/restart an in-flight probe on re-render: Chrome rate-limits varying-args `canMakePayment` per origin (~30 min of silent `false`).

  **Link masks wallets in a Payment Request.** Link surfaces in two independent places: inline in the Card Element (account-level autofill widget; no code, unaffected by `disableWallets`) and inside a wallet Payment Request, where it takes priority — with Link available, `canMakePayment()` answers `{ link: true, googlePay: false }` and Google/Apple Pay never show. Rule: pass `disableWallets: ['link']` — in the probe AND in the `show()` request — whenever `option.stripe.linkInCardElement || option.stripe.disableLink`. This does not remove Link from the checkout: it stays inline in the Card Element; the coexistence comes from the two SEPARATE surfaces, not from one Payment Request. Raw-HTTP source of the two flags: the stripe gateway's `data.disable_link` (Link switched off store-wide) and the cart's `features` array containing `stripe_link_option` (Link served in the card element) — the SDK maps them to `option.stripe.disableLink` / `option.stripe.linkInCardElement` so integrators never touch the feature string.
- `stripe-redirect` (Klarna, iDEAL, Bancontact, Afterpay/Clearpay, Twint) — **no Stripe.js involved**: send the literal method key as the token — `stripe_payment_method: option.method` (e.g. `"klarna"`). The server prepares the Stripe payment itself and responds `payment.state === 'redirect'` → send the shopper to `payment.redirect_url` to approve.
- `paypal` — send only `payment_method: option.gateway`; handle the `redirect` state.
- `offline` — show `option.data.instructions_html`; add `offline_payment_method: option.method`.
- `card-fields` — the `dummy` test gateway: a plain card form driven by `option.data` (the `payload` rules); add the `card` object.

`stripe_payment_method` therefore accepts two forms: a `pm_…` id (card, wallets) or a known method key (redirect methods). Anything else is rejected. It is required for every stripe option — there is no "place the order, pay afterwards" path.

Everything below is the raw wire shape behind `paymentOptions()` — read it only if you consume `GET /payment-methods` directly instead of the SDK.

The raw list is one entry per GATEWAY. The `stripe` entry's `data.methods` holds its sub-methods:

```
"payment_methods": [ {
  "type": "stripe",
  "payload": { "stripe_payment_method": ["required"] },
  "data": {
    "publishable_key": "pk_test_…",
    "account_id": "acct_…",
    "methods": {
      "card":       { "label": "Card" },
      "klarna":     { "label": "Klarna", "countries": ["us"] },
      "apple_pay":  { "label": "Apple Pay",  "options": { "country": "US", "currency": "usd", "total": { "amount": 4900 }, … } },
      "google_pay": { "label": "Google Pay", "options": { … } }
    }
  }
} ]
```

Render one selectable option per `data.methods` key, using its `.label` ("Card", "Klarna", "Apple Pay", "Google Pay"). A method absent from the map is not available for this cart (wrong country/currency, or off on the store) — do not show it. Then, by the picked key, all through **Stripe.js** initialized once as `Stripe(data.publishable_key, { stripeAccount: data.account_id })`:

- **`card`** — mount a Stripe **card Element**, `createPaymentMethod({ type: 'card', card, billing_details })`, send `stripe_payment_method: paymentMethod.id`.
- **`apple_pay` / `google_pay`** — a Stripe **Payment Request Button** built from `methods.<key>.options` (already carries country/currency/total); its result yields the PaymentMethod id for `stripe_payment_method`.
- **`klarna` / `ideal` / `bancontact` / other redirect methods** — confirm via Stripe with that `payment_method_types`; the Place Order response comes back `payment.state === "redirect"` → send the shopper to `payment.redirect_url`.

Every stripe sub-method ends the same way: `payment_method: "stripe"` + `stripe_payment_method: "<pm_… id>"` in the Place Order body. There is no separate `payment_method: "card"` value — `"card"` is a Stripe sub-method key, not a gateway.

Two related lists (informational — the render source is `data.methods` above):

- `checkout.enabled_payment_methods` — the store's configured set (e.g. may list `ideal`, `bancontact` that don't apply to a US/USD cart). Broader than `data.methods`; use `data.methods` for what to actually offer.
- `express_payment_methods` (top level of the cart) — wallet keys for one-tap **express buttons** rendered ABOVE the form (Apple/Google Pay express), separate from the in-form payment step.

For non-stripe gateways: `dummy` → a plain test-card form; `offline` → options from its `data`, send `offline_payment_method`; `paypal` → the PayPal redirect flow.

## Place Order

```
POST /cart/{cart}/checkout
```

Base body (note: this endpoint's address keys differ from `PATCH /address`):

```json
{
  "customer_email": "jane@example.com",
  "customer_name": "Jane Doe",
  "payment_method": "<type from payment-methods>",
  "billing_address": {
    "full_name": "Jane Doe",
    "email": "jane@example.com",
    "country": "us",
    "region": "us-ca",
    "city": "San Francisco",
    "line_one": "123 Main St",
    "line_two": "Apt 4",
    "zip": "94105",
    "confirmed": true
  }
}
```

Key differences from the `PATCH /address` shape: `full_name` (not `name`), `line_one` / `line_two` (not `address_line_*`), `zip` (not `postal_code`), and `confirmed: true` belongs here. When the cart ships, also send `shipping_address` (same key shape) and `shipping_method` (selected method id). **`shipping_address.email` is required whenever the cart ships** — copy the customer's email into both address objects; the shopper should not be asked twice.

Per-gateway additions — branch only on `type`, guided by `payload`:

- `dummy` — test gateway; add
  `"card": { "number": "4242424242424242", "expiry_month": 6, "expiry_year": 2030, "cvv": "123" }`.
  Only test cards are accepted: `4242424242424242` (approved), `1313131313131313` (declined). Formatted numbers with spaces are accepted. Card values are cast to integers server-side, so a CVV with a leading zero is not representable — use the test values above.
- `stripe` / `test-stripe` — add `"stripe_payment_method"`, which takes one of two forms depending on the chosen sub-method (see "Rendering the payment options" above):
  - **card / wallets**: a Stripe PaymentMethod id (`pm_...`) created client-side with Stripe.js (`@stripe/stripe-js`; card fields are Stripe-hosted Elements, wallets go through `paymentRequest(...).show()`):

    ```js
    import { loadStripe } from '@stripe/stripe-js';

    const gateway = methods.find((m) => m.type === 'stripe');
    const stripe = await loadStripe(gateway.data.publishable_key, { stripeAccount: gateway.data.account_id });

    const elements = stripe.elements();
    const card = elements.create('card');
    card.mount('#card-element');

    const { paymentMethod, error } = await stripe.createPaymentMethod({
      type: 'card',
      card,
      billing_details: { name: fullName, email },
    });
    // send paymentMethod.id (pm_...) as stripe_payment_method in the Place Order body
    ```

  - **redirect methods** (Klarna, iDEAL, Bancontact, Afterpay/Clearpay, Twint): the literal method key, e.g. `"stripe_payment_method": "klarna"` — no Stripe.js involved; the server prepares the payment and responds with the approval redirect.

  When the Place Order response comes back with `payment.state === "redirect"`, send the shopper to `payment.redirect_url` (3-D Secure or the redirect method's approval page). No `card` object is ever sent for Stripe.

  For redirect methods also send `return_url` in the Place Order body — the URL on your store's site where the platform lands the shopper after the provider finishes. The host must match your store's registered site URL; a `return_url` on any other host is ignored and the shopper is sent to the site root instead. Without a `return_url` the site root is used. Either way the shopper arrives with `?cartgenie_return=success|cancel&cart=<guid>` appended; the URL is revisit-safe (refreshing it shows the same outcome). On `success` the cart is finalized — clear the stored guid and show the confirmation.
- `offline` — add `"offline_payment_method": "<custom attribute of the chosen method>"` (available methods are in the gateway's `data`).
- `paypal` / `test-paypal` — PayPal flow; follow the redirect returned in the response.

### Retries and idempotency

Send an `Idempotency-Key` header with Place Order (any stable string, one per checkout attempt; reuse it when retrying after a timeout). When a headless store receives a retry whose key already produced an order, the API replays the original response — marked with an `Idempotency-Replay: true` header — instead of creating a duplicate order or answering 404 for the finalized cart. Only order-creating outcomes are replayed; a failed payment can be retried with the same key.

### Result

The response carries the updated cart in `data`, plus two top-level keys: `payment` and `order_name` (the human-facing order number, e.g. `#1001` — it sits NEXT TO `payment`, not inside it).

`payment.state` is one of:

- `success` — order placed; show the top-level `order_name`
- `redirect` — send the customer to `payment.redirect_url` (PayPal, 3DS approval)
- `cancelled` — the customer cancelled at the gateway; show `payment.message`
- `error` — payment failed; show `payment.message`

After `success`, discard the stored cart guid — the cart is finalized and must not receive further requests.

`GET /order/{order}` returns an order by id (for confirmation deep-links or webhook-driven flows).

## Keeping a static frontend fresh

For statically-generated storefronts (prices baked at build time), configure store webhooks (dashboard → Webhooks) and revalidate on:

- `new_product` / `product_updated` — content or price changed
- `inventory_updated` — stock changed
- `new_category` / `category_updated`

CartGenie re-prices every order server-side from live data at checkout, so a stale page can never charge a stale price — revalidation is a display concern only.
