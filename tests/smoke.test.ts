import { beforeAll, describe, expect, it } from 'vitest';
import { CartGenie, type CartStorage } from '../src/index';

/**
 * Live contract smoke: catalog → cart → checkout against a real CartGenie API.
 * No mocks — this is what catches drift between the SDK and the server.
 *
 * Requires a headless store with the Dummy (test) gateway enabled:
 *   CARTGENIE_SMOKE_BASE_URL=https://<host>/api \
 *   CARTGENIE_SMOKE_API_KEY=<public api key> \
 *   npm run test:smoke
 *
 * Skips entirely when the env vars are absent, so `npm test` and CI stay hermetic.
 * Tolerates servers that don't yet expose the self-describing payload or
 * idempotent replay — those assertions tighten automatically once deployed.
 */
// CI without secrets passes these as EMPTY STRINGS, not undefined — normalize.
const baseUrl = process.env.CARTGENIE_SMOKE_BASE_URL || undefined;
const apiKey = process.env.CARTGENIE_SMOKE_API_KEY || undefined;
const smokeEnabled = Boolean(baseUrl && apiKey);

function memoryStorage(): CartStorage {
  let value: string | null = null;

  return {
    get: () => value,
    set: (guid) => {
      value = guid;
    },
    clear: () => {
      value = null;
    },
  };
}

describe.skipIf(!smokeEnabled)('live smoke: catalog → cart → dummy checkout', () => {
  // The describe body runs at collection time even when the suite is skipped —
  // construct the client only when the suite actually executes.
  let sdk: CartGenie;

  beforeAll(() => {
    sdk = new CartGenie({
      baseUrl: baseUrl as string,
      apiKey: apiKey as string,
      storage: memoryStorage(),
    });
  });

  it('reads the catalog', { timeout: 60_000 }, async () => {
    const products = await sdk.products.list({ limit: 10 });

    expect(products.data.length).toBeGreaterThan(0);

    const bySlug = await sdk.products.bySlugs([products.data[0]!.slug]);
    expect(bySlug.data[0]?.slug).toBe(products.data[0]!.slug);

    const categories = await sdk.categories.list({ limit: 10 });
    expect(Array.isArray(categories.data)).toBe(true);
  });

  it('runs the full cart → checkout flow on the dummy gateway', { timeout: 120_000 }, async () => {
    const products = await sdk.products.list({ limit: 50 });
    const sellable = products.data
      .flatMap((product) => product.variants)
      .filter((candidate) => !candidate.out_of_stock && !candidate.disabled);
    // Prefer a variant that can hold quantity 2 — repeated smoke runs eat stock.
    const variant = sellable.find((c) => !c.track_inventory || (c.stock_quantity ?? 0) >= 2) ?? sellable[0];

    expect(variant, 'smoke store needs at least one sellable variant').toBeTruthy();

    let cart = await sdk.cart.addItem({ product_variant_id: variant!.id, quantity: 1 });
    expect(cart.guid).toBeTruthy();
    expect(cart.items.length).toBe(1);
    expect(cart.checkout?.formatted_total).toBeTruthy();

    // Address selects must be renderable from the API alone.
    const bootstrap = await sdk.checkout.get();
    expect(bootstrap.billing_countries.length).toBeGreaterThan(0);
    const us = bootstrap.billing_countries.find((c) => c.id === 'us');
    expect(us, 'smoke store must bill to the US').toBeTruthy();
    expect(us!.jurisdiction_region_required ? us!.regions.length : 1).toBeGreaterThan(0);

    if (!variant!.track_inventory || (variant!.stock_quantity ?? 0) >= 2) {
      const itemId = cart.items[0]!.id;
      cart = await sdk.cart.updateItem(itemId, 2);
      expect(cart.items[0]?.quantity).toBe(2);
    }

    await sdk.checkout.setEmail('smoke@example.com', 'Smoke Test');
    cart = await sdk.checkout.setAddress({
      country: 'us',
      region: 'us-ca',
      state: 'CA',
      city: 'San Francisco',
      address_line_one: '123 Main St',
      postal_code: '94105',
      name: 'Smoke Test',
    });

    let shippingMethodId: number | undefined;

    if (cart.checkout?.has_shipping) {
      await sdk.checkout.setJurisdictions('us-ca');
      const shippingMethods = await sdk.checkout.shippingMethods('us-ca', '94105');
      expect(shippingMethods.length, 'smoke store needs a shipping method matching the US address').toBeGreaterThan(0);
      shippingMethodId = shippingMethods[0]!.id;
      await sdk.checkout.setShippingMethod(shippingMethodId);
    }

    const methods = await sdk.checkout.paymentMethods();
    const dummy = methods.find((method) => method.type === 'dummy');
    expect(dummy, 'smoke store must have the Dummy (test) gateway enabled').toBeTruthy();

    if (dummy!.payload !== null) {
      expect(dummy!.payload).toHaveProperty('card.number');
    }

    // The flat option list must never surface a raw gateway type as a choice.
    const paymentOptions = await sdk.checkout.paymentOptions();
    expect(paymentOptions.length).toBeGreaterThan(0);
    expect(paymentOptions.every((o) => o.kind && o.label && o.gateway)).toBe(true);
    expect(paymentOptions.some((o) => o.label.toLowerCase() === 'stripe')).toBe(false);

    const guidBeforeOrder = sdk.cart.guid;
    const attemptKey = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const smokeAddress = {
      full_name: 'Smoke Test',
      email: 'smoke@example.com',
      country: 'us',
      region: 'us-ca',
      state: 'CA',
      city: 'San Francisco',
      line_one: '123 Main St',
      zip: '94105',
      confirmed: true,
    };
    const orderBody = {
      customer_email: 'smoke@example.com',
      customer_name: 'Smoke Test',
      payment_method: 'dummy',
      card: { number: '4242424242424242', expiry_month: 6, expiry_year: 2030, cvv: '123' },
      billing_address: smokeAddress,
      ...(cart.checkout?.has_shipping
        ? { shipping_method: shippingMethodId, shipping_address: smokeAddress }
        : {}),
    };

    const result = await sdk.checkout.placeOrder(orderBody, { idempotencyKey: attemptKey });

    expect(result.payment?.state).toBe('success');
    expect(result.order_name).toBeTruthy();
    expect(sdk.cart.guid).toBeNull();

    // Idempotent replay (servers with the feature answer 200 + Idempotency-Replay;
    // older servers 404 the finalized cart — both prove no duplicate was created).
    const replay = await fetch(`${baseUrl}/cart/${guidBeforeOrder}/checkout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': attemptKey,
      },
      body: JSON.stringify(orderBody),
    });

    if (replay.status === 200) {
      const body = (await replay.json()) as { order_name?: string };
      expect(replay.headers.get('Idempotency-Replay')).toBe('true');
      expect(body.order_name).toBe(result.order_name);
    } else {
      expect(replay.status).toBe(404);
    }
  });
});
