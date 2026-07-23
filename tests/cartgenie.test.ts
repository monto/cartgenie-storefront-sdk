import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CartGenie,
  CartGenieError,
  CartGenieNetworkError,
  CartGenieProtocolError,
  defaultStorage,
  parseCheckoutReturn,
  payWithWallet,
  probeWalletSupport,
  type CartStorage,
  type PaymentOption,
  type PlaceOrderInput,
  type PlaceOrderResult,
  type StripeWalletClient,
} from '../src/index';

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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const BASE = 'https://dash.example.com/api';

interface RecordedCall {
  method?: string;
  headers: Record<string, string>;
  body: string;
}

function call(mock: ReturnType<typeof vi.fn>, index: number): [string, RecordedCall] {
  const entry = mock.mock.calls[index];

  if (!entry) {
    throw new Error(`expected fetch call #${index} to have been made`);
  }

  return entry as [string, RecordedCall];
}

describe('CartGenie SDK', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('defaults to the production API host when baseUrl is omitted', async () => {
    const defaultFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ data: [] }));
    const defaultSdk = new CartGenie({
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: defaultFetch as unknown as typeof fetch,
    });

    await defaultSdk.products.list();

    expect(call(defaultFetch, 0)[0]).toBe('https://dash.cartgenie.com/api/products');
  });

  it('sends auth headers and limit on product listing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [], meta: { next_cursor: null } }));

    await sdk.products.list({ limit: 25 });

    const [url, init] = call(fetchMock, 0);
    expect(url).toBe(`${BASE}/products?limit=25`);
    expect(init.headers.Authorization).toBe('Bearer pk_test');
    expect(init.headers.Accept).toBe('application/json');
  });

  it('joins slugs for slug-based product fetches', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    await sdk.products.bySlugs(['t-shirt', 'mug']);

    expect(call(fetchMock, 0)[0]).toBe(`${BASE}/products?slugs=t-shirt%2Cmug`);
  });

  it('creates a cart on first addItem, persists the guid, and reuses it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201));

    await sdk.cart.addItem({ product_variant_id: 11, quantity: 1 });
    await sdk.cart.addItem({ product_variant_id: 12 });

    expect(call(fetchMock, 0)[0]).toBe(`${BASE}/cart/item?checkout=1`);
    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/item?checkout=1`);
    expect(sdk.cart.guid).toBe('CART1');
  });

  it('serializes concurrent first adds so only one cart is created', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201));

    await Promise.all([
      sdk.cart.addItem({ product_variant_id: 11 }),
      sdk.cart.addItem({ product_variant_id: 12 }),
    ]);

    expect(call(fetchMock, 0)[0]).toBe(`${BASE}/cart/item?checkout=1`);
    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/item?checkout=1`);
    expect(sdk.cart.guid).toBe('CART1');
  });

  it('sends the batch items form through addItems', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201));

    await sdk.cart.addItems([{ product_variant_id: 11 }, { product_variant_id: 12, quantity: 2 }]);

    expect(call(fetchMock, 0)[0]).toBe(`${BASE}/cart/item?checkout=1`);
    expect(JSON.parse(call(fetchMock, 0)[1].body)).toEqual({
      items: [{ product_variant_id: 11 }, { product_variant_id: 12, quantity: 2 }],
    });
  });

  it('appends checkout=1 to cart mutations', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    await sdk.cart.updateItem(5, 3);
    await sdk.cart.removeItem(5);

    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/item/5?checkout=1`);
    expect(call(fetchMock, 1)[1].method).toBe('PUT');
    expect(JSON.parse(call(fetchMock, 1)[1].body)).toEqual({ quantity: 3 });
    expect(call(fetchMock, 2)[1].method).toBe('DELETE');
  });

  it('throws before cart-dependent calls when no cart exists', async () => {
    await expect(sdk.cart.get()).rejects.toThrow('No cart yet');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the place-order body through and returns the top-level order_name', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ payment: { state: 'success' }, order_name: '#1001' }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    const result = await sdk.checkout.placeOrder({
      customer_email: 'jane@example.com',
      payment_method: 'dummy',
      card: { number: '4242424242424242', expiry_month: 6, expiry_year: 2030, cvv: '123' },
      billing_address: { full_name: 'Jane Doe', country: 'us', zip: '94105', confirmed: true },
    });

    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/checkout`);
    const sent = JSON.parse(call(fetchMock, 1)[1].body);
    expect(sent.card.number).toBe('4242424242424242');
    expect(sent.billing_address.confirmed).toBe(true);
    expect(result.payment?.state).toBe('success');
    expect(result.order_name).toBe('#1001');
  });

  it('maps 422 dotted errors into nested field errors', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: 'The Card Number field is required.',
            errors: {
              'card.number': ['The Card Number field is required.'],
              'billing_address.region': ['Required.'],
            },
          },
          422,
        ),
      );

    await sdk.cart.addItem({ product_variant_id: 11 });

    try {
      await sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' });
      expect.unreachable('placeOrder should have thrown');
    } catch (error) {
      const e = error as CartGenieError;
      expect(e).toBeInstanceOf(CartGenieError);
      expect(e.status).toBe(422);
      expect(e.isValidationError).toBe(true);
      expect(e.fieldErrors()).toEqual({
        card: { number: ['The Card Number field is required.'] },
        billing_address: { region: ['Required.'] },
      });
    }
  });

  it('exposes Retry-After on rate-limited requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Too Many Requests' }, 429, { 'Retry-After': '30' }));

    try {
      await sdk.products.list();
      expect.unreachable('list should have thrown');
    } catch (error) {
      const e = error as CartGenieError;
      expect(e.isRateLimited).toBe(true);
      expect(e.retryAfterSeconds).toBe(30);
    }
  });

  it('throws a protocol error when a 2xx body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(sdk.products.list()).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('wraps transport failures in a network error with the cause attached', async () => {
    const boom = new TypeError('fetch failed');
    fetchMock.mockRejectedValueOnce(boom);

    try {
      await sdk.products.list();
      expect.unreachable('list should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CartGenieNetworkError);
      expect((error as CartGenieNetworkError).cause).toBe(boom);
    }
  });

  it('fetches shipping methods with encoded segments and typed results', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 7, label: 'Standard', cost_total_formatted: '$5.00' }] }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    const methods = await sdk.checkout.shippingMethods('us ca', '94105');

    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/shipping-methods/us%20ca/94105?checkout=1`);
    expect(methods[0]?.id).toBe(7);
    expect(methods[0]?.label).toBe('Standard');
  });

  it('fetches an order by id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 42, name: '#1001' } }));

    const order = await sdk.orders.get(42);

    expect(call(fetchMock, 0)[0]).toBe(`${BASE}/order/42`);
    expect(order.name).toBe('#1001');
  });

  it('runs the checkout steps against the persisted cart', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ type: 'dummy', payload: { 'card.number': ['required'] }, data: [] }] }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    await sdk.checkout.setEmail('jane@example.com', 'Jane');
    await sdk.checkout.setAddress({ country: 'us', city: 'SF', postal_code: '94105' });
    const methods = await sdk.checkout.paymentMethods();

    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/email?checkout=1`);
    expect(call(fetchMock, 2)[0]).toBe(`${BASE}/cart/CART1/address?checkout=1`);
    expect(JSON.parse(call(fetchMock, 2)[1].body)).toEqual({ country: 'us', city: 'SF', postal_code: '94105' });
    expect(call(fetchMock, 3)[0]).toBe(`${BASE}/cart/CART1/payment-methods`);
    expect(methods[0]?.payload).toEqual({ 'card.number': ['required'] });
  });
});

describe('protocol guards', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('rejects a 2xx response without the data envelope', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ message: 'ok but wrong shape' }));

    await sdk.cart.addItem({ product_variant_id: 11 });

    await expect(sdk.cart.get()).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('rejects a cart response whose data has no guid', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { items: [] } }, 201));

    await expect(sdk.cart.addItem({ product_variant_id: 11 })).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('rejects a non-paginated products response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ something: 'else' }));

    await expect(sdk.products.list()).rejects.toBeInstanceOf(CartGenieProtocolError);
  });
});

describe('checkout safety', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('rejects a second placeOrder while the first is in flight, then allows a deliberate retry', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201));
    await sdk.cart.addItem({ product_variant_id: 11 });

    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));

    const first = sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' });

    await expect(
      sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' }),
    ).rejects.toThrow('already in flight');

    release(jsonResponse({ payment: { state: 'error', message: 'declined' } }));
    await first;

    fetchMock.mockResolvedValueOnce(jsonResponse({ payment: { state: 'error', message: 'declined' } }));
    await expect(
      sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' }),
    ).resolves.toBeTruthy();
  });

  it('sends the Idempotency-Key header when provided', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ payment: { state: 'error' } }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    await sdk.checkout.placeOrder(
      { customer_email: 'x@example.com', payment_method: 'dummy' },
      { idempotencyKey: 'attempt-1' },
    );

    expect(call(fetchMock, 1)[1].headers['Idempotency-Key']).toBe('attempt-1');
  });

  it('clears the stored cart guid after a successful checkout and keeps it after a failed one', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ payment: { state: 'error' } }))
      .mockResolvedValueOnce(jsonResponse({ payment: { state: 'success' }, order_name: '#1001' }));

    await sdk.cart.addItem({ product_variant_id: 11 });

    await sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' });
    expect(sdk.cart.guid).toBe('CART1');

    await sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' });
    expect(sdk.cart.guid).toBeNull();
  });
});

describe('configuration validation', () => {
  it('throws a clear error for an invalid baseUrl', () => {
    expect(() => new CartGenie({ apiKey: 'pk', baseUrl: 'not a url', storage: memoryStorage() })).toThrow(
      'Invalid baseUrl',
    );
  });

  it('throws when baseUrl carries a query string or fragment', () => {
    expect(
      () => new CartGenie({ apiKey: 'pk', baseUrl: 'https://x.example.com/api?foo=1', storage: memoryStorage() }),
    ).toThrow('query string or fragment');
  });
});

describe('field error safety', () => {
  it('drops prototype-polluting paths and uses null-prototype objects', () => {
    const error = new CartGenieError('Validation failed', 422, {
      '__proto__.polluted': ['nope'],
      'constructor.prototype.polluted': ['nope'],
      'card.number': ['Required.'],
    });

    const fields = error.fieldErrors();

    expect(Object.keys(fields)).toEqual(['card']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(fields)).toBeNull();
  });
});

describe('default storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeLocalStorage(failAfterWrites = Infinity) {
    const map = new Map<string, string>();
    let writes = 0;

    return {
      store: map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes > failAfterWrites) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
  }

  it('namespaces the guid key per store so instances do not collide', async () => {
    const fake = fakeLocalStorage();
    vi.stubGlobal('localStorage', fake);

    const first = defaultStorage('store-a');
    const second = defaultStorage('store-b');

    first.set('CART_A');
    second.set('CART_B');

    expect(first.get()).toBe('CART_A');
    expect(second.get()).toBe('CART_B');
    expect(fake.store.size).toBe(2);
  });

  it('keeps serving the guid from memory when localStorage starts throwing mid-session', () => {
    const fake = fakeLocalStorage(1);
    vi.stubGlobal('localStorage', fake);

    const storage = defaultStorage('store-a');

    storage.set('CART_1');
    expect(storage.get()).toBe('CART_1');

    storage.set('CART_2');
    expect(storage.get()).toBe('CART_2');
  });
});

describe('contract hardening', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('rejects a placeOrder response without payment.state', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({}));

    await sdk.cart.addItem({ product_variant_id: 11 });

    await expect(
      sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'dummy' }),
    ).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('rejects a cart response whose data has no items array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1' } }, 201));

    await expect(sdk.cart.addItem({ product_variant_id: 11 })).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('reports the actual response status on protocol errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1' } }, 201));

    try {
      await sdk.cart.addItem({ product_variant_id: 11 });
      expect.unreachable('addItem should have thrown');
    } catch (error) {
      expect((error as CartGenieProtocolError).status).toBe(201);
    }
  });

  it('wraps a mid-response connection drop in a network error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new TypeError('terminated')),
    } as unknown as Response);

    await expect(sdk.products.list()).rejects.toBeInstanceOf(CartGenieNetworkError);
  });
});

describe('storage resilience and namespacing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mirrors successful reads so a later storage failure keeps the guid', () => {
    let reads = 0;
    const fake = {
      getItem: () => {
        reads += 1;
        if (reads > 1) {
          throw new DOMException('blocked', 'SecurityError');
        }

        return 'CART_X';
      },
      setItem: () => {},
      removeItem: () => {},
    };
    vi.stubGlobal('localStorage', fake);

    const storage = defaultStorage('ns');

    expect(storage.get()).toBe('CART_X');
    expect(storage.get()).toBe('CART_X');
  });

  it('namespaces the default storage by host and key so staging and production do not share a cart', async () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    });

    const makeSdk = (baseUrl: string, guid: string) => {
      const mock = vi.fn().mockResolvedValueOnce(jsonResponse({ data: { guid, items: [] } }, 201));

      return new CartGenie({ baseUrl, apiKey: 'pk_same', fetch: mock as unknown as typeof fetch });
    };

    await makeSdk('https://staging.example.com/api', 'CART_STAGING').cart.addItem({ product_variant_id: 1 });
    await makeSdk('https://prod.example.com/api', 'CART_PROD').cart.addItem({ product_variant_id: 1 });

    const guids = [...map.values()].filter((value) => value.startsWith('CART_'));
    expect(guids.sort()).toEqual(['CART_PROD', 'CART_STAGING']);
    expect(map.size).toBe(2);
  });
});

describe('model shape guards', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('rejects a product listing entry without the base product fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 1, name: 'No slug', variants: [] }] }));

    await expect(sdk.products.list()).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('rejects a single product without a variants array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { id: 1, slug: 't-shirt', name: 'T-Shirt' } }));

    await expect(sdk.products.get('t-shirt')).rejects.toBeInstanceOf(CartGenieProtocolError);
  });

  it('accepts a product with the base fields present', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ id: 1, slug: 't-shirt', name: 'T-Shirt', variants: [{ id: 11, slug: '' }] }] }),
    );

    const page = await sdk.products.list();

    expect(page.data[0]?.slug).toBe('t-shirt');
  });

  it('rejects a category entry without the base category fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 3, name: 'Apparel' }] }));

    await expect(sdk.categories.list()).rejects.toBeInstanceOf(CartGenieProtocolError);
  });
});

describe('checkout bootstrap', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('returns the cart with the store-configured country lists', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { guid: 'CART1', items: [], checkout: { has_shipping: true } },
          billing_countries: [
            {
              id: 'us',
              label: 'United States',
              region_label: 'State',
              jurisdiction_region_required: true,
              regions: [{ id: 'us-ca', label: 'California', country: 'us' }],
            },
          ],
          shipping_countries: [
            { id: 'gb', label: 'United Kingdom', jurisdiction_region_required: false, regions: [] },
          ],
        }),
      );

    await sdk.cart.addItem({ product_variant_id: 11 });
    const bootstrap = await sdk.checkout.get();

    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/CART1/checkout`);
    expect(bootstrap.billing_countries[0]?.regions[0]?.id).toBe('us-ca');
    expect(bootstrap.shipping_countries[0]?.id).toBe('gb');
    expect(bootstrap.data.guid).toBe('CART1');
  });

  it('rejects a bootstrap response without the country arrays', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }));

    await sdk.cart.addItem({ product_variant_id: 11 });

    await expect(sdk.checkout.get()).rejects.toBeInstanceOf(CartGenieProtocolError);
  });
});

describe('payment options (gateway → method flattening)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  const mixedGateways = [
    {
      type: 'stripe',
      payload: { stripe_payment_method: ['required'] },
      data: {
        publishable_key: 'pk_live_x',
        account_id: 'acct_x',
        methods: {
          card: { label: 'Card' },
          klarna: { label: 'Klarna', countries: ['us'] },
          apple_pay: { label: 'Apple Pay', options: { country: 'US' } },
          google_pay: { label: 'Google Pay', options: { country: 'US' } },
        },
      },
    },
    { type: 'paypal', payload: {}, data: { methods: { paypal: { label: 'PayPal' } } } },
    {
      type: 'offline',
      payload: {},
      data: { methods: { bank_transfer: { id: 'bank_transfer', label: 'Bank transfer', instructions_html: '<p>Wire…</p>' } } },
    },
  ];

  it('flattens every gateway into one option per customer-facing method', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: mixedGateways }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    const opts = await sdk.checkout.paymentOptions();

    expect(opts.map((o) => o.label)).toEqual(['Card', 'Klarna', 'Apple Pay', 'Google Pay', 'PayPal', 'Bank transfer']);
    expect(opts.every((o) => o.label !== 'Stripe' && o.label !== 'stripe')).toBe(true);
  });

  it('tags each option with the flow that completes it and the gateway to post', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: mixedGateways }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    const opts = await sdk.checkout.paymentOptions();
    const byId = Object.fromEntries(opts.map((o) => [o.id, o]));

    expect(byId['stripe:card']?.kind).toBe('stripe-card');
    expect(byId['stripe:card']?.stripe).toEqual({
      publishableKey: 'pk_live_x',
      accountId: 'acct_x',
      disableLink: false,
      linkInCardElement: false,
    });
    expect(byId['stripe:card']?.gateway).toBe('stripe');
    expect(byId['stripe:card']?.wallet).toBeUndefined();
    expect(byId['stripe:klarna']?.kind).toBe('stripe-redirect');
    expect(byId['stripe:klarna']?.wallet).toBeUndefined();
    expect(byId['stripe:apple_pay']?.kind).toBe('stripe-wallet');
    expect(byId['stripe:apple_pay']?.wallet).toBe('applePay');
    expect(byId['stripe:google_pay']?.wallet).toBe('googlePay');
    expect(byId['paypal:paypal']?.kind).toBe('paypal');
    expect(byId['offline:bank_transfer']?.kind).toBe('offline');
    expect((byId['offline:bank_transfer']?.data as { instructions_html?: string }).instructions_html).toContain('Wire');
  });

  it('represents the dummy test gateway as a single card-fields option', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ data: [{ type: 'dummy', payload: { 'card.number': ['required'] }, data: [] }] }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    const opts = await sdk.checkout.paymentOptions();

    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ id: 'dummy', gateway: 'dummy', kind: 'card-fields' });
  });
});

describe('stripe place-order guard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('throws before the request when a stripe order has no stripe_payment_method', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201));
    await sdk.cart.addItem({ product_variant_id: 11 });

    await expect(
      sdk.checkout.placeOrder({ customer_email: 'x@example.com', payment_method: 'stripe' }),
    ).rejects.toThrow('stripe_payment_method');
    // No checkout request was made — the guard fired client-side.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a stripe order that carries the payment method token', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ payment: { state: 'success' }, order_name: '#1' }));

    await sdk.cart.addItem({ product_variant_id: 11 });
    const result = await sdk.checkout.placeOrder({
      customer_email: 'x@example.com',
      payment_method: 'stripe',
      stripe_payment_method: 'pm_123',
    });

    expect(result.payment?.state).toBe('success');
  });
});

describe('stale cart recovery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sdk: CartGenie;

  beforeEach(() => {
    fetchMock = vi.fn();
    sdk = new CartGenie({
      baseUrl: BASE,
      apiKey: 'pk_test',
      storage: memoryStorage(),
      fetch: fetchMock as unknown as typeof fetch,
    });
  });

  it('starts a fresh cart when addItem hits a 404 on the stored guid', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'OLD', items: [] } }, 201)) // first cart
      .mockResolvedValueOnce(jsonResponse({ message: 'Resource not found' }, 404)) // stale guid add
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'NEW', items: [] } }, 201)); // fresh create

    await sdk.cart.addItem({ product_variant_id: 11 });
    expect(sdk.cart.guid).toBe('OLD');

    const cart = await sdk.cart.addItem({ product_variant_id: 12 });

    expect(call(fetchMock, 1)[0]).toBe(`${BASE}/cart/OLD/item?checkout=1`); // tried the stale cart
    expect(call(fetchMock, 2)[0]).toBe(`${BASE}/cart/item?checkout=1`); // then created fresh
    expect(cart.guid).toBe('NEW');
    expect(sdk.cart.guid).toBe('NEW');
  });

  it('clears the stored guid when cart.get 404s', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'OLD', items: [] } }, 201))
      .mockResolvedValueOnce(jsonResponse({ message: 'Resource not found' }, 404));

    await sdk.cart.addItem({ product_variant_id: 11 });

    await expect(sdk.cart.get()).rejects.toBeInstanceOf(CartGenieError);
    expect(sdk.cart.guid).toBeNull();
  });

  it('propagates disableLink from the stripe gateway to wallet options', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              type: 'stripe',
              payload: { stripe_payment_method: ['required'] },
              data: {
                publishable_key: 'pk',
                account_id: 'acct',
                disable_link: true,
                methods: { apple_pay: { label: 'Apple Pay', options: { country: 'US' } } },
              },
            },
          ],
        }),
      );

    await sdk.cart.addItem({ product_variant_id: 11 });
    const opts = await sdk.checkout.paymentOptions();

    expect(opts[0]?.stripe?.disableLink).toBe(true);
  });

  it('sets linkInCardElement from the cart features', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: { guid: 'CART1', items: [] } }, 201))
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              type: 'stripe',
              payload: { stripe_payment_method: ['required'] },
              data: {
                publishable_key: 'pk',
                account_id: 'acct',
                disable_link: false,
                methods: { google_pay: { label: 'Google Pay', options: { country: 'US' } } },
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { guid: 'CART1', items: [], features: ['stripe_link_option'] } }),
      );

    await sdk.cart.addItem({ product_variant_id: 11 });
    const opts = await sdk.checkout.paymentOptions();

    expect(opts[0]?.stripe?.linkInCardElement).toBe(true);
    expect(opts[0]?.stripe?.disableLink).toBe(false);
  });
});

describe('parseCheckoutReturn', () => {
  it('parses a success return with the cart guid', () => {
    expect(parseCheckoutReturn('?cartgenie_return=success&cart=CART1')).toEqual({
      status: 'success',
      cartGuid: 'CART1',
    });
  });

  it('parses a cancel return', () => {
    expect(parseCheckoutReturn('?cartgenie_return=cancel&cart=CART1')).toEqual({
      status: 'cancel',
      cartGuid: 'CART1',
    });
  });

  it('returns null when the marker parameter is absent', () => {
    expect(parseCheckoutReturn('?utm_source=newsletter')).toBeNull();
    expect(parseCheckoutReturn('')).toBeNull();
  });

  it('returns null for an unknown status value', () => {
    expect(parseCheckoutReturn('?cartgenie_return=paid')).toBeNull();
  });

  it('reports a null cart guid when the parameter is missing', () => {
    expect(parseCheckoutReturn('?cartgenie_return=success')).toEqual({
      status: 'success',
      cartGuid: null,
    });
  });
});

function walletOption(overrides: Partial<PaymentOption> = {}): PaymentOption {
  return {
    id: 'stripe:google_pay',
    label: 'Google Pay',
    gateway: 'stripe',
    method: 'google_pay',
    kind: 'stripe-wallet',
    wallet: 'googlePay',
    stripe: { publishableKey: 'pk', accountId: 'acct', disableLink: false, linkInCardElement: false },
    data: { label: 'Google Pay', options: { country: 'us', currency: 'USD', total: { label: 'Total', amount: 12345 } } },
    ...overrides,
  };
}

const cardOption: PaymentOption = {
  id: 'stripe:card',
  label: 'Card',
  gateway: 'stripe',
  method: 'card',
  kind: 'stripe-card',
  stripe: { publishableKey: 'pk', accountId: 'acct', disableLink: false, linkInCardElement: false },
};

function fakeStripe(capability: Record<string, boolean> | null | Error) {
  const paymentRequest = vi.fn((_options: Record<string, unknown>) => ({
    canMakePayment: vi.fn(() => (capability instanceof Error ? Promise.reject(capability) : Promise.resolve(capability))),
    show: vi.fn(),
    on: vi.fn(),
  }));

  return { stripe: { paymentRequest } as unknown as StripeWalletClient, paymentRequest };
}

describe('probeWalletSupport', () => {
  it('probes once with fixed uppercased args and filters wallets by capability', async () => {
    const { stripe, paymentRequest } = fakeStripe({ applePay: false, googlePay: true, link: true });
    const apple = walletOption({ id: 'stripe:apple_pay', method: 'apple_pay', wallet: 'applePay' });

    const visible = await probeWalletSupport(stripe, [cardOption, apple, walletOption()]);

    expect(visible.map((o) => o.id)).toEqual(['stripe:card', 'stripe:google_pay']);
    expect(paymentRequest).toHaveBeenCalledOnce();
    expect(paymentRequest).toHaveBeenCalledWith({
      country: 'US',
      currency: 'usd',
      total: { label: 'Detect', amount: 1 },
    });

    await probeWalletSupport(stripe, [walletOption()]);
    expect(paymentRequest).toHaveBeenCalledOnce();
  });

  it('passes disableWallets link when the store disables Link', async () => {
    const { stripe, paymentRequest } = fakeStripe({ googlePay: true });
    const option = walletOption({
      stripe: { publishableKey: 'pk', accountId: 'acct', disableLink: true, linkInCardElement: false },
    });

    await probeWalletSupport(stripe, [option]);

    expect(paymentRequest.mock.calls[0]![0]).toMatchObject({ disableWallets: ['link'] });
  });

  it('excludes link from the payment request when Link lives in the card element', async () => {
    const { stripe, paymentRequest } = fakeStripe({ googlePay: true });
    const option = walletOption({
      stripe: { publishableKey: 'pk', accountId: 'acct', disableLink: false, linkInCardElement: true },
    });

    const visible = await probeWalletSupport(stripe, [option]);

    expect(paymentRequest.mock.calls[0]![0]).toMatchObject({ disableWallets: ['link'] });
    expect(visible.map((o) => o.id)).toEqual(['stripe:google_pay']);
  });

  it('drops every wallet when the device reports none', async () => {
    const { stripe } = fakeStripe(null);

    const visible = await probeWalletSupport(stripe, [cardOption, walletOption()]);

    expect(visible).toEqual([cardOption]);
  });

  it('drops wallets instead of throwing when the probe rejects', async () => {
    const { stripe } = fakeStripe(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const visible = await probeWalletSupport(stripe, [cardOption, walletOption()]);

    expect(visible).toEqual([cardOption]);
    warn.mockRestore();
  });

  it('returns the list untouched when no wallet options exist', async () => {
    const { stripe, paymentRequest } = fakeStripe({ googlePay: true });

    const visible = await probeWalletSupport(stripe, [cardOption]);

    expect(visible).toEqual([cardOption]);
    expect(paymentRequest).not.toHaveBeenCalled();
  });
});

describe('payWithWallet', () => {
  function fakeWalletStripe(capability: Record<string, boolean> | null) {
    const handlers: Record<string, (ev: unknown) => void> = {};
    const canMakePayment = vi.fn(() => Promise.resolve(capability));
    const show = vi.fn();
    const paymentRequest = vi.fn((_options: Record<string, unknown>) => ({
      canMakePayment,
      show,
      on: vi.fn((event: string, handler: (ev: unknown) => void) => {
        handlers[event] = handler;
      }),
    }));

    return { stripe: { paymentRequest } as unknown as StripeWalletClient, paymentRequest, canMakePayment, show, handlers };
  }

  const order: PlaceOrderInput = { customer_email: '', payment_method: 'stripe' };

  it('awaits canMakePayment on the same instance, then shows and places the order', async () => {
    const { stripe, paymentRequest, canMakePayment, show, handlers } = fakeWalletStripe({ googlePay: true });
    const placeOrder = vi.fn(async (input: PlaceOrderInput) => ({ payment: { state: 'success' }, order_name: '#1', data: undefined }) as PlaceOrderResult);

    const settled = payWithWallet(stripe, walletOption(), order, placeOrder);

    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    expect(canMakePayment).toHaveBeenCalledOnce();
    expect(paymentRequest.mock.calls[0]![0]).toMatchObject({ country: 'US', currency: 'usd', total: { label: 'Total', amount: 12345 } });

    const complete = vi.fn();
    handlers['paymentmethod']!({ paymentMethod: { id: 'pm_wallet_1' }, payerEmail: 'payer@example.com', payerName: 'Pay Er', complete });

    const result = await settled;

    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_method: 'stripe',
        stripe_payment_method: 'pm_wallet_1',
        customer_email: 'payer@example.com',
        customer_name: 'Pay Er',
      }),
    );
    expect(complete).toHaveBeenCalledWith('success');
    expect(result.order_name).toBe('#1');
  });

  it('keeps the order email when it is already set', async () => {
    const { stripe, show, handlers } = fakeWalletStripe({ googlePay: true });
    const placeOrder = vi.fn(async () => ({ payment: { state: 'success' } }) as PlaceOrderResult);

    const settled = payWithWallet(stripe, walletOption(), { ...order, customer_email: 'form@example.com' }, placeOrder);

    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    handlers['paymentmethod']!({ paymentMethod: { id: 'pm_1' }, payerEmail: 'payer@example.com', complete: vi.fn() });
    await settled;

    expect(placeOrder).toHaveBeenCalledWith(expect.objectContaining({ customer_email: 'form@example.com' }));
  });

  it('completes the sheet with fail and rejects when placeOrder throws', async () => {
    const { stripe, show, handlers } = fakeWalletStripe({ googlePay: true });
    const placeOrder = vi.fn(async () => {
      throw new CartGenieError('validation', 422);
    });

    const settled = payWithWallet(stripe, walletOption(), order, placeOrder);

    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    const complete = vi.fn();
    handlers['paymentmethod']!({ paymentMethod: { id: 'pm_1' }, complete });

    await expect(settled).rejects.toThrow('validation');
    expect(complete).toHaveBeenCalledWith('fail');
  });

  it('rejects when the shopper closes the sheet', async () => {
    const { stripe, show, handlers } = fakeWalletStripe({ googlePay: true });

    const settled = payWithWallet(stripe, walletOption(), order, vi.fn());

    await vi.waitFor(() => expect(show).toHaveBeenCalledOnce());
    handlers['cancel']!(undefined);

    await expect(settled).rejects.toThrow('closed the wallet sheet');
  });

  it('throws before show when the wallet is unavailable on this device', async () => {
    const { stripe, show } = fakeWalletStripe({ googlePay: false });

    await expect(payWithWallet(stripe, walletOption(), order, vi.fn())).rejects.toThrow('not available on this device');
    expect(show).not.toHaveBeenCalled();
  });

  it('rejects non-wallet options outright', async () => {
    const { stripe } = fakeWalletStripe({ googlePay: true });

    await expect(payWithWallet(stripe, cardOption, order, vi.fn())).rejects.toThrow('needs a stripe-wallet option');
  });
});

describe('checkout.validateOrder', () => {
  it('reports required fields that are missing or empty, including dotted paths', () => {
    const sdk = new CartGenie({ apiKey: 'k', baseUrl: 'https://api.example.com', storage: memoryStorage(), fetch: vi.fn() });

    const rules = {
      customer_email: ['required', 'email'],
      customer_name: ['required', 'string'],
      'shipping_address.email': ['required', 'email'],
      'billing_address.zip': ['nullable', 'string'],
      shipping_method: ['nullable'],
    };

    const missing = sdk.checkout.validateOrder(
      {
        customer_email: '',
        customer_name: 'Jane',
        payment_method: 'stripe',
        shipping_address: { country: 'us' },
      },
      rules,
    );

    expect(missing).toEqual(['customer_email', 'shipping_address.email']);

    expect(
      sdk.checkout.validateOrder(
        {
          customer_email: 'jane@example.com',
          customer_name: 'Jane',
          payment_method: 'stripe',
          shipping_address: { country: 'us', email: 'jane@example.com' },
        },
        rules,
      ),
    ).toEqual([]);

    expect(sdk.checkout.validateOrder({ customer_email: 'x@y.z', payment_method: 'stripe' }, null)).toEqual([]);
  });
});
