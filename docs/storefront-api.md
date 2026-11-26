# CartGenie Storefront API

REST contract for building a headless storefront (catalog, cart, checkout) against a CartGenie store with no Webflow connection. This document is self-contained: it can be handed verbatim to a developer or an AI agent building the storefront.

Applies to headless stores (`integration_mode = headless`, `headless_store` feature enabled). Catalog listing endpoints and the payment-methods `payload` respond only for headless stores.

## Base URL and authentication

- Base URL: `https://<dashboard-host>/api` (`https://dash.cartgenie.com/api`)
- Every request sends:
  - `Authorization: Bearer <PUBLIC_API_KEY>`
  - `Accept: application/json`
  - `Content-Type: application/json` (on requests with a body)

The public API key is a store-scoped token shown on the headless onboarding success screen and in the dashboard under Settings → Storefront API, where admins can also copy it or rotate it (rotation invalidates the old key immediately — the storefront must be updated with the new one). It identifies the store; all endpoints operate on that store's data only.

The key is **publishable** — shipping it in a browser bundle is the intended deployment. It is scoped to storefront operations only (catalog reads, cart mutations, checkout); order management, inventory, webhooks and every other privileged operation live on separate APIs with separate credentials that must never appear client-side. Keep the key in an environment variable so repositories and templates stay clean — that is hygiene, not secrecy.

Card data is tokenized in the browser for real gateways: Stripe methods send only the `pm_…` token produced by Stripe Elements — raw card numbers never reach the CartGenie API. The only direct card form is the `dummy` TEST gateway, which accepts test cards only.

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
  "meta_description": "Plain-text summary for the page meta description, or null.",
  "gallery": ["https://.../gallery-1.jpg", "https://.../gallery-2.jpg"],
  "images": { "image_url": "...", "image_url_large": "..." },
  "options": [
    { "name": "Color", "slug": "color", "values": [{ "value": "Red", "value_slug": "red" }] }
  ],
  "variants": [ { "id": 11, "slug": "red-l", "sku": "TS-RL", "price": 1900, "formatted_price": "$19.00",
                  "out_of_stock": false, "stock_quantity": 5, "track_inventory": true,
                  "shippable": true, "image_url": "...", "extra_images": ["..."],
                  "height": 2050, "length": 1000, "width": 500, "weight": 12345,
                  "dimension_unit": "cm", "weight_unit": "kg",
                  "subscription": null } ],
  "kind": "single"
}
```

Notes:

- Add to cart by the variant's `id` (`product_variant_id` below). Do not reconstruct variants from option slugs client-side; per-variant option maps are not in the payload. Render one select per `options[]` entry and track which variant the selection maps to.
- Nullable/inactive fields may be omitted from variant objects.
- Image URLs point at CartGenie-hosted media; hotlink or proxy them as you prefer.
- The listing intentionally omits `description` to keep catalog pages light. Fetch the single product (`GET /product/{slug}`) on the product detail page — that response includes `description`: store-authored HTML, render it in a rich-text block (sanitized). `meta_description` belongs in the page's meta description tag. Both can be `null` when the merchant hasn't filled them in.
- `gallery` (product level) and each variant's `extra_images` are additional image URL lists. On a product page show the selected variant's image(s), not a flat dump of every variant's images; preload the gallery/variant images in the background for instant option switches.
- Variant `height` / `length` / `width` / `weight` come from the API as integer hundredths of the store's configured measurement units (`2050` = 20.5). The SDK's `products` resource converts them to decimals for you — render SDK values as-is, labeled with `dimension_unit` / `weight_unit`. When calling the API directly, divide by 100 before displaying.
- Each variant's `subscription` says whether buying it starts a recurring charge. It is `null` for a one-time purchase and always present, never omitted. For a subscription variant:

  ```json
  "subscription": {
    "interval": "week",
    "interval_count": 1,
    "term": "renews_until_canceled",
    "ends_after": null
  }
  ```

  The shopper is charged `price` now and again every `interval_count` × `interval` (`day`, `week`, `month` or `year`). `term` is `renews_until_canceled`, or `fixed_term` when the subscription stops after `ends_after` payments (`null` otherwise). Show the billing terms next to the price and on the add-to-cart button ("$10 / week", "$10 every 2 weeks, 6 payments") so the shopper sees the recurring charge before checkout. A variant whose renewals cost a different amount also carries `subscription_renewal_price` / `formatted_subscription_renewal_price`.

### Fetch specific products by slug

```
GET /products?slugs=t-shirt,mug
```

Returns up to 50 products matching the given slugs. Works for every store type and is exempt from the catalog rate limit.

### Get one product

```
GET /product/{slug}
```

Single product, same shape as the listing plus `description` (rich-text HTML or `null`) — the endpoint to use on product detail pages.

### List categories

```
GET /categories?limit=50
```

Headless stores only (404 otherwise). Published categories, cursor-paginated, capped at 100:

```json
{ "id": 3, "name": "Apparel", "slug": "apparel", "description": "...",
  "meta_description": "...", "published_at": "2026-07-01T00:00:00+00:00", "main_image_url": "..." }
```

## Page URLs CartGenie links to

CartGenie builds links into your site for product feeds (Google, OpenAI), order emails, PayPal order details, webhooks and the dashboard. It builds them from the site settings in the dashboard (Settings → Storefront), so your routes must match those settings:

| Page | URL | Example with the default paths |
|---|---|---|
| Product | `<site URL>/<product path>/<product slug>` | `https://mystore.com/products/t-shirt` |
| Category | `<site URL>/<category path>/<category slug>` | `https://mystore.com/categories/apparel` |

The site URL and both paths can be changed in the dashboard at any time; change your routes and the settings together. A path can have several segments (`shop/products`).

Product pages must also handle two query parameters:

- `?variant=<variant slug>` — preselect the variant whose `slug` matches (feed and email links point at a specific variant this way). Ignore an unknown slug and fall back to the default selection.
- `?addtocart=<product slug>:<quantity>&opencart=true` — used by upsell links in order emails for single-variant products. Fetch the product by slug, add its variant to the cart with the given quantity (default `1` when the `:<quantity>` part is missing), open the cart when `opencart=true`, then remove both parameters from the address bar (`history.replaceState`) so a reload doesn't add the item again.

## Cart

Append `?checkout=1` to cart reads and mutations (cart CRUD, items, coupon, email, address) — without it the response omits the `checkout` block (totals, discounts, tax, payment methods). The payment-methods and Place-Order endpoints do not take this parameter.

- Create cart + add first item:
  `POST /cart/item?checkout=1` body `{ "product_variant_id": 11, "quantity": 1 }` (`quantity` is required by the API; the SDK sends `1` when you omit it)
  Returns HTTP 201 with the cart. Persist `data.guid` (e.g. localStorage) — it is the `{cart}` segment in every call below. Multi-item form: `{ "items": [{ "product_variant_id": 11, "quantity": 1 }, ...] }`.
- Add item to existing cart: `POST /cart/{cart}/item?checkout=1` (same body)
- Change quantity: `PUT /cart/{cart}/item/{item}?checkout=1` body `{ "quantity": 2 }`
- Remove item: `DELETE /cart/{cart}/item/{item}?checkout=1`
- Read cart: `GET /cart/{cart}?checkout=1`

Cart response essentials:

- `guid`, `items[]` — each item: `id`, `name`, `slug`, `quantity`, `image_url`, `formatted_price`, `formatted_subtotal`, `options: [{ name, value }]`, `sku`, `stock`, `availability`, `subscription` (same shape as the variant's, `null` for a one-time item — show the billing terms on the line)
- `checkout.formatted_subtotal` / `formatted_total` / `formatted_discount_total` (signed, e.g. `-$0.20`) / `formatted_tax_total` / `formatted_shipping_total`
- `checkout.has_shipping`, `checkout.requires_shipping`, `checkout.requires_billing`
- `checkout.payment_methods[]` — see Payment methods below
- `checkout.discounts[]` — `{ code, discount_type, messages[] }`; render `messages` when a coupon attaches but does not apply
- `checkout.coupon_code` — the currently applied code, `null` when none applies

## Coupons

- Apply: `POST /cart/{cart}/coupon?checkout=1` body `{ "coupon": "SAVE10" }`
- Remove: `DELETE /cart/{cart}/coupon?checkout=1`

An unknown code answers HTTP 404 with `message: "Invalid coupon code."` — the same status as a missing cart, so check the cart (`GET /cart/{cart}`) before treating it as gone. The SDK does this for you: `cart.applyCoupon()` rejects an unknown code with a 422 `CartGenieError` whose `errors` are `{ coupon: ["Invalid coupon code."] }`, and keeps the cart.

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

- `type` — the **gateway**, not a customer-facing choice: `dummy`, `stripe`, `test-stripe`, `paypal`, `test-paypal`, `offline`. **Never render `type` as the payment option** (a radio labeled "Stripe" is wrong — the shopper picks Card / Klarna / Apple Pay, not "Stripe").
- `payload` — self-describing requirements: a map of Place-Order body field (dotted path) → validation rules (strings only). `null` for non-headless stores; empty object = no extra fields beyond the base body. For stripe this is just `{ "stripe_payment_method": ["required"] }` — one token covers every sub-method.
- `data` — **the source of the payment options the customer actually sees.**

### Rendering the payment options

**A customer picks a payment METHOD (Card, Klarna, Apple Pay, PayPal, a bank transfer) — never a gateway.** The API groups methods under gateways (`stripe` has a `data.methods` map, `paypal` another, `offline` another, `dummy` is a test card form), so a single radio labeled with the gateway `type` ("Stripe", "PayPal") is wrong.

The SDK flattens all of this for you — `checkout.paymentOptions()` returns one entry per customer-facing method across every gateway, each tagged with a `kind` telling you how to complete it:

```ts
const options = (await cartgenie.checkout.paymentOptions())
  .filter((option) => option.method !== 'paypal_express');
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
- `paypal` — show the standard `paypal` method. Submit `payment_method: option.gateway` and follow the approval redirect.
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

Related cart fields (informational — the render source is `data.methods` above):

- `checkout.enabled_payment_methods` — the store's configured set (e.g. may list `ideal`, `bancontact` that don't apply to a US/USD cart). Broader than `data.methods`; use `data.methods` for what to actually offer.
- `express_payment_methods` (top level of the cart) lists candidates for the built-in Express Payments component. See [Express checkout](#express-checkout) for how to interpret it.

For non-stripe gateways: `dummy` → a plain test-card form; `offline` → options from its `data`, send `offline_payment_method`; `paypal` → the PayPal redirect flow.

## Express checkout

| Shopper experience | Integration |
| --- | --- |
| Pay with Apple Pay or Google Pay after entering checkout details | Use `checkout.paymentOptions()`, filter with `probeWalletSupport()` and pay with `payWithWallet()`. A button above the form can open the same wallet payment once the checkout details are ready. |
| Pay with PayPal after entering checkout details | Submit Place Order with the PayPal option's `gateway` and follow `payment.redirect_url`. |
| Start with PayPal before the headless checkout form | Use PayPal Buttons with CartGenie's Express callbacks. See [PayPal Express in a headless storefront](#paypal-express-in-a-headless-storefront). |
| Start with a wallet or PayPal on Webflow | Use the CartGenie Express Payments component on a Webflow checkout page or in its cart modal. The component owns the Stripe and PayPal express callbacks. [CartGenie Express Payments guide](https://help.cartgenie.com/en/articles/148-adding-express-payment-options-to-your-store) |

`express_payment_methods` may contain `apple_pay`, `google_pay` and `paypal_express`, or be empty. It reflects CartGenie's eligibility for the built-in component. For headless checkout, use the available methods from `checkout.paymentOptions()` and the browser's wallet capability probe to decide what to offer. The gateway response can also list `paypal_express` as a method. For the regular headless payment form, omit that entry and show the standard `paypal` method when available. Use a separate button for the PayPal Express integration below. A headless product-page buy button can add the selected variant to a cart and take the shopper through the [checkout sequence](#checkout-sequence).

### Apple Pay and Google Pay in headless checkout

1. Collect the required contact and address fields and save them with `checkout.setEmail()` and `checkout.setAddress()`. For a shippable cart, call `checkout.setJurisdictions()`, get the matching rates with `checkout.shippingMethods()` and save the shopper's choice with `checkout.setShippingMethod()`.
2. Fetch fresh payment options after those updates. Use the wallet's server-supplied amount and currency from `option.data.options`. Validate the checkout fields before opening the sheet. The Stripe PaymentMethod ID arrives after wallet confirmation.
3. Call `payWithWallet()` in the button's click handler. It can fill an empty top-level customer name or email and pass the Stripe PaymentMethod ID to Place Order. Supply the required `billing_address`, `shipping_address` and selected `shipping_method` in the order input as applicable. The helper handles `paymentmethod` and cancellation. Setting `requestShipping: true` only asks Stripe for a shipping address. It leaves address persistence, shipping events and repricing outside the helper.

Treat the wallet amount as a quote for the cart and shipping selection at the time the sheet opened. If you detect a cart, stock or coupon change while the sheet is open, mark the quote stale. Have your `payWithWallet()` callback reject a stale quote before it calls `checkout.placeOrder()`. The helper closes the sheet with a failure status. If Place Order already started, check its result before starting another attempt. Place Order checks stock server-side. If checkout reports unavailable stock, an invalid coupon or a changed total, show the error. Refresh the cart, shipping choice and payment options, then show the updated CartGenie total for the shopper to confirm.

### How the Webflow Express Payments component handles shipping

- On Stripe's `shippingaddresschange` event, the component sends the wallet address to CartGenie. CartGenie resolves the jurisdiction and postal code, updates the cart for the quote and returns the applicable shipping options and recalculated total. Address details can be limited until wallet confirmation. The component passes the returned options and total to `updateWith()`, using the server's amounts in minor units. The callback reports an address the store cannot ship to. [Payment Request address changes](https://www.w3.org/TR/payment-request/#shipping-address-changed-algorithm)
- On `shippingoptionchange`, it sends the selected option ID. CartGenie checks that the option still applies, saves it and returns the new total including shipping and tax. The component updates the sheet before the shopper confirms.
- On `paymentmethod`, it submits the full wallet address and selected shipping method with the Stripe PaymentMethod ID. The final Place Order address shape uses fields such as `country`, `region`, `line_one` and `zip`. Ordinary headless address updates use the separate [cart address shape](#checkout-sequence).
- PayPal Express starts with a PayPal button. The component uses the Storefront API key to call `paypal-callbacks/create-order` and `paypal-callbacks/on-approve` for the active cart. Order creation requires the store's PayPal Express feature. CartGenie supplies PayPal with a signed HTTPS shipping callback that recalculates totals and returns shipping options for shippable orders. The component uses the approval payload to fill checkout details, collects any remaining required fields and completes Place Order in express mode. Headless storefronts can use the same server callbacks with their own PayPal button and review form.

### PayPal Express in a headless storefront

Use a dedicated PayPal button for Express. For the same active cart, CartGenie creates the PayPal order, PayPal obtains shipping options and updated amounts through CartGenie's signed HTTPS callback, and CartGenie returns the payer and delivery details after approval. Complete the purchase on the storefront with Place Order in express mode.

This flow was verified in PayPal Sandbox with a shippable one-time order, including the shipping option and tax calculated for the PayPal address. With deferred authorization enabled, PayPal showed the order as approved with zero captures before the final storefront submit. Place Order completed one capture for the reviewed amount.

#### Preparation

- Connect PayPal to the CartGenie store and enable PayPal Express for that store. In Sandbox, use the matching PayPal Sandbox integration and buyer account.
- Create a nonempty cart with the Storefront SDK. Use the top-level `express_payment_methods` on that cart to decide whether to mount the Express button.
- Install `@paypal/paypal-js` in the storefront. Use the `partner_client_id` and currency returned by the PayPal entry in `checkout.paymentMethods()` to initialize PayPal Buttons. CartGenie supplies PayPal's signed shipping callback when creating the order.

Keep the Express button separate from the regular payment options. The example assumes the app has already initialized `cartgenie` with its Storefront API key and base URL and added items to the cart.

```html
<div id="paypal-express"></div>
<form id="paypal-express-review" hidden>
  <p id="paypal-express-total"></p>
  <label>Phone <input name="phone" type="tel" autocomplete="tel"></label>
  <button type="submit">Complete checkout</button>
</form>
<p id="paypal-express-status" role="status"></p>
```

```js
import { loadScript } from '@paypal/paypal-js';

async function mountPayPalExpress({ cartgenie, apiKey, baseUrl, environment }) {
  const { data: cart } = await cartgenie.checkout.get();
  if (!cart.express_payment_methods?.includes('paypal_express')) return;

  const gateways = await cartgenie.checkout.paymentMethods();
  const config = gateways.find(({ type }) => type === 'paypal')?.data;
  if (!config?.partner_client_id || !config.currency) {
    throw new Error('PayPal gateway settings are incomplete.');
  }

  const buttonsContainer = document.querySelector('#paypal-express');
  const review = document.querySelector('#paypal-express-review');
  const total = document.querySelector('#paypal-express-total');
  const status = document.querySelector('#paypal-express-status');
  const submit = review.querySelector('button[type="submit"]');
  const callbackBase = `${baseUrl.replace(/\/$/, '')}/cart/${encodeURIComponent(cart.guid)}/paypal-callbacks`;
  let approval;
  let attemptKey;

  async function postPayPalCallback(action, body) {
    const response = await fetch(`${callbackBase}/${action}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(Object.values(data.errors ?? {})[0]?.[0] ?? data.message ?? 'PayPal callback failed.');
    }
    return data;
  }

  const paypal = await loadScript({
    environment,
    clientId: config.partner_client_id,
    currency: config.currency.toUpperCase(),
    intent: 'authorize',
    commit: false,
  });
  if (!paypal?.Buttons) throw new Error('PayPal Buttons did not load.');

  await paypal.Buttons({
    fundingSource: paypal.FUNDING.PAYPAL,
    async createOrder() {
      status.textContent = '';
      const { id } = await postPayPalCallback('create-order');
      if (!id) throw new Error('CartGenie did not return a PayPal order ID.');
      return id;
    },
    async onApprove({ orderID }) {
      approval = await postPayPalCallback('on-approve', { orderID });
      attemptKey = crypto.randomUUID();
      const { totals } = approval;
      total.textContent = `Total ${totals.formatted_total} · Shipping ${totals.formatted_shipping_total} · Tax ${totals.formatted_tax_total}`;
      status.textContent = 'PayPal approved. Review and complete checkout.';
      buttonsContainer.hidden = true;
      review.hidden = false;
    },
    onCancel() {
      status.textContent = 'PayPal was closed. You can try again.';
    },
    onError(error) {
      status.textContent = error.message;
    },
  }).render(buttonsContainer);

  review.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!approval || submit.disabled) return;
    submit.disabled = true;

    const { payload, paypal: approvedPayPal, totals } = approval;
    const phone = review.elements.namedItem('phone').value.trim();
    try {
      const result = await cartgenie.checkout.placeOrder({
        ...payload,
        ...(phone ? { phone } : {}),
        flow: 'express',
        paypal_authorisation: approvedPayPal?.authorisation?.id ?? undefined,
        displayed_total: totals.total,
      }, { idempotencyKey: attemptKey });

      if (result.payment?.state !== 'success') {
        throw new Error(result.payment?.message ?? 'Checkout did not complete.');
      }
      review.hidden = true;
      status.textContent = `Order placed: ${result.order_name}`;
    } catch (error) {
      submit.disabled = false;
      status.textContent = error.message;
    }
  });
}

// Use the same apiKey and baseUrl passed to the SDK, including /api.
await mountPayPalExpress({ cartgenie, apiKey, baseUrl, environment: 'sandbox' });
```

Keep the approved address and shipping method from the callback payload. Collect any remaining checkout fields on the storefront before final submit. When CartGenie defers authorization, the approval response can have a null `paypal.authorisation.id`. CartGenie uses its persisted PayPal order to authorize and capture during Place Order. Use the same idempotency key when retrying the same final submit after a timeout. The order is complete when Place Order reports `payment.state === 'success'`.

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
- `none` — no payment went through (a declined card, including the `dummy` test decline); show `payment.message`, keep the cart open
- `cancelled` — the customer canceled at the gateway; show `payment.message`
- `error` — payment failed; show `payment.message`

Treat every state other than `success` and `redirect` as a failed payment — the cart stays open and the shopper can try again.

After `success`, discard the stored cart guid — the cart is finalized and must not receive further requests.

`GET /order/{order}` returns an order by id (for confirmation deep-links or webhook-driven flows).

Headless orders skip address validation entirely: the shipping address is stored exactly as the shopper entered it, and no "Validated address" badge appears on orders or emails.

## Going live with real payments

The `dummy` gateway is the store's test mode: while it is enabled, real gateways (Stripe, PayPal) are hidden from payment-methods so no live charge can happen. To switch a store to real payments the merchant does it in the CartGenie dashboard — Settings → Payment Gateways: connect Stripe (and/or PayPal), then disable the Dummy gateway. The storefront needs no code change — the payment-methods response starts returning the real gateways and their `payload` / `data.methods`, and the same checkout flow applies.

## Keeping a static frontend fresh

For statically-generated storefronts (prices baked at build time), configure store webhooks (dashboard → Webhooks) and revalidate on:

- `new_product` / `product_updated` — content or price changed
- `inventory_updated` — stock changed
- `new_category` / `category_updated`

CartGenie re-prices every order server-side from live data at checkout, so a stale page can never charge a stale price — revalidation is a display concern only.
