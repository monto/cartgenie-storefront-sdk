# Prompt library

Copy-paste prompts for AI site builders (Lovable, v0, Bolt, Cursor, …). Start with the master prompt, then apply add-ons as needed. Replace `<PUBLIC_API_KEY>` (and `baseUrl` when not targeting production) before sending.

## Master prompt — full store

```text
Build me a complete, ready-to-sell online store on top of the official CartGenie Storefront SDK.

Setup: install the SDK with `npm install github:monto/cartgenie-storefront-sdk` (package name @cartgenie/storefront). Before writing any code, read the SDK documentation and follow it exactly — it covers the entire commerce contract (catalog, cart, discounts, shipping, taxes, payments) and every integration detail, including how card payments must be built:

- https://raw.githubusercontent.com/monto/cartgenie-storefront-sdk/main/README.md
- https://raw.githubusercontent.com/monto/cartgenie-storefront-sdk/main/docs/storefront-api.md

My store's config: apiKey "<PUBLIC_API_KEY>". Keep the key in an environment variable (e.g. VITE_CARTGENIE_API_KEY in .env, with .env gitignored) rather than hardcoding it in source — it is a publishable storefront key, but config belongs in the environment.

The SDK and its docs are the single source of truth for all commerce behavior — prices, totals, taxes, country and region lists, shipping options, payment methods and their forms. Never invent, hardcode or calculate any of that yourself; when in doubt, the docs win.

If any SDK call fails or returns unexpected data, render the actual error state. Never fall back to placeholder products, hardcoded country or region lists, or client-side price/tax math. If the docs don't specify something, stop and say so instead of inventing it.

What the store should be:

Catalog — a tidy grid of products with photos and prices, linking to a product detail page for each product.

Product detail page — the product's name, rich description, photo gallery, SKU, price, and stock/availability state. If the product comes in variations (size, colour, etc.), the shopper picks each option; the price, photo, SKU, dimensions and availability update to match the selected variant, and the gallery shows the selected variant's images (never a flat dump of every variant's images). Show physical dimensions and weight with their units when present. Preload gallery and variant images in the background so switching options is instant. Put the product's meta description into the page's meta description tag.

Cart — every item with its photo, the chosen options (e.g. "Size: M, Colour: Red"), a quantity selector and a remove button. A box for a discount code. A clear total that lists subtotal, discount, shipping and tax separately.

Checkout — a guided, friendly flow, not a bare form. Country and state/region are dropdowns filled from the store's data. When the order ships, shipping options appear as selectable choices with their prices. Payment methods appear as clear options — exactly the ones this store offers, looking professional. The shopper only types their email and street address; everything else is picked from options. Validation problems show as friendly messages next to the field that needs fixing.

Confirmation — after a successful purchase, a clear screen with the order number.

Make it responsive, mobile-friendly, accessible and clean. Remove any sections that don't apply to my products.
```

## Add-on prompts

Apply after the master prompt, one at a time.

**Colour swatches**

```text
On product pages, render the colour option as clickable swatches instead of a dropdown. Use the option values from the API; highlight the selected swatch and update the gallery to the matching variant's images.
```

**Category navigation**

```text
Add category navigation: fetch the store's categories from the SDK and render them as a menu; each category page lists its products in the same grid style. Use each category's description and meta description on its page.
```

**Instant image switching**

```text
Preload every variant image and gallery image on the product page in the background as soon as the page renders, so option changes and gallery browsing never show a loading flash.
```

**Stock badges**

```text
Show an "Out of stock" badge on unavailable variants and disable adding them to the cart; when a variant tracks inventory and has fewer than 5 left, show a "Only N left" hint using the stock quantity from the API.
```

**Quantity limits**

```text
Clamp the cart quantity selector to the variant's available stock when it tracks inventory; show a friendly message when the shopper hits the limit.
```

## Evaluation run (internal)

For comparing builders or prototypes side by side — not for merchant builds. Append to the master prompt:

```text
This is an evaluation build. Additional constraints:

Use exactly this stack: <FRAMEWORK + VERSION>. Do not pick your own.

Install the SDK pinned to a commit so runs are comparable: npm install github:monto/cartgenie-storefront-sdk#<COMMIT_SHA>.

Produce INTEGRATION-NOTES.md recording every point where the docs were ambiguous, incomplete, or contradicted actual API behavior; every workaround you had to invent; and every TypeScript type that was missing or wrong.

Definition of done: typecheck and production build pass, and one end-to-end test order is placed with the documented test card — paste the order number into INTEGRATION-NOTES.md. Also exercise and note the behavior of: an out-of-stock variant, an invalid discount code, an address that returns no shipping options, and a declined card.
```

## Claude Code / Cursor builds

For agentic-CLI builds, put the docs URLs, the no-mock rule and the acceptance criteria into the repo's `CLAUDE.md` (or the tool's equivalent context file) instead of relying on the prompt alone — the agent re-reads it every session, so the constraints survive compaction and follow-up turns.
