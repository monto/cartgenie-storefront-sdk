// src/errors.ts
var CartGenieError = class extends Error {
  constructor(message, status, errors = {}, options = {}) {
    super(message);
    this.name = "CartGenieError";
    this.status = status;
    this.errors = errors;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.cause = options.cause;
  }
  get isValidationError() {
    return this.status === 422;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  /**
   * Dotted error keys expanded into a nested object so each message can be
   * attached to its form field: { card: { number: ["..."] } }.
   *
   * Built on null-prototype objects, and paths containing prototype-polluting
   * segments (__proto__, prototype, constructor) are dropped entirely.
   */
  fieldErrors() {
    const unsafeSegments = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
    const nested = /* @__PURE__ */ Object.create(null);
    for (const [path, messages] of Object.entries(this.errors)) {
      const segments = path.split(".");
      if (segments.some((segment) => unsafeSegments.has(segment))) {
        continue;
      }
      let cursor = nested;
      segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
          cursor[segment] = messages;
          return;
        }
        if (typeof cursor[segment] !== "object" || cursor[segment] === null || Array.isArray(cursor[segment])) {
          cursor[segment] = /* @__PURE__ */ Object.create(null);
        }
        cursor = cursor[segment];
      });
    }
    return nested;
  }
};
var CartGenieProtocolError = class extends CartGenieError {
  constructor(message, status) {
    super(message, status);
    this.name = "CartGenieProtocolError";
  }
};
var CartGenieNetworkError = class extends CartGenieError {
  constructor(message, cause) {
    super(message, 0, {}, { cause });
    this.name = "CartGenieNetworkError";
  }
};

// src/http.ts
var Http = class {
  constructor(config) {
    this.config = config;
    let parsed;
    try {
      parsed = new URL(config.baseUrl);
    } catch (cause) {
      throw new CartGenieError(
        `Invalid baseUrl "${config.baseUrl}" \u2014 expected an absolute URL like https://dash.cartgenie.com/api`,
        0,
        {},
        { cause }
      );
    }
    if (parsed.search || parsed.hash) {
      throw new CartGenieError(`baseUrl must not contain a query string or fragment: "${config.baseUrl}"`, 0);
    }
    this.base = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  }
  async request(method, path, options = {}) {
    const { body } = await this.requestRaw(method, path, options);
    return body;
  }
  async requestRaw(method, path, options = {}) {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== void 0) {
        url.searchParams.set(key, String(value));
      }
    }
    const doFetch = this.config.fetch ?? globalThis.fetch;
    let response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
          ...options.body !== void 0 ? { "Content-Type": "application/json" } : {},
          ...options.headers ?? {}
        },
        body: options.body !== void 0 ? JSON.stringify(options.body) : void 0,
        signal: options.signal
      });
    } catch (cause) {
      throw new CartGenieNetworkError(`CartGenie request to ${url.pathname} failed before reaching the API`, cause);
    }
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      throw new CartGenieNetworkError(
        `CartGenie response body from ${url.pathname} could not be read \u2014 the connection dropped mid-response`,
        cause
      );
    }
    const json = text ? safeParse(text) : void 0;
    if (!response.ok) {
      const message = (json && typeof json === "object" && "message" in json && typeof json.message === "string" ? json.message : void 0) ?? `CartGenie request failed with status ${response.status}`;
      const errors = json && typeof json === "object" && "errors" in json && json.errors && typeof json.errors === "object" ? json.errors : {};
      throw new CartGenieError(message, response.status, errors, {
        retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After"))
      });
    }
    if (json === void 0) {
      throw new CartGenieProtocolError(
        `CartGenie returned status ${response.status} for ${url.pathname} but the body was not valid JSON`,
        response.status
      );
    }
    return { status: response.status, body: json };
  }
};
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function parseRetryAfter(header) {
  if (!header) {
    return void 0;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : void 0;
}

// src/contract.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProductShape(value) {
  return isRecord(value) && typeof value.id === "number" && typeof value.slug === "string" && typeof value.name === "string" && Array.isArray(value.variants);
}
function isCategoryShape(value) {
  return isRecord(value) && typeof value.id === "number" && typeof value.slug === "string" && typeof value.name === "string";
}
function dataOf(payload, endpoint, status) {
  if (!isRecord(payload) || !("data" in payload)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} is missing the { data } envelope the contract promises`,
      status
    );
  }
  return payload.data;
}
function cartOf(payload, endpoint, status) {
  const data = dataOf(payload, endpoint, status);
  if (!isRecord(data) || typeof data.guid !== "string" || !Array.isArray(data.items)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include a cart with a string guid and an items array`,
      status
    );
  }
  return data;
}
function arrayOf(payload, endpoint, status) {
  const data = dataOf(payload, endpoint, status);
  if (!Array.isArray(data) || !data.every(isRecord)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include a data array of objects`,
      status
    );
  }
  return data;
}
function objectOf(payload, endpoint, status) {
  const data = dataOf(payload, endpoint, status);
  if (!isRecord(data)) {
    throw new CartGenieProtocolError(`CartGenie response from ${endpoint} did not include a data object`, status);
  }
  return data;
}
function paginatedOf(payload, endpoint, status) {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.every(isRecord)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} is not a paginated collection with a data array of objects`,
      status
    );
  }
  return payload;
}
function productOf(payload, endpoint, status) {
  const data = dataOf(payload, endpoint, status);
  if (!isProductShape(data)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include a product with id, slug, name, and variants`,
      status
    );
  }
  return data;
}
function productsOf(payload, endpoint, status) {
  const page = paginatedOf(payload, endpoint, status);
  if (!page.data.every(isProductShape)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} contained a product entry without id, slug, name, or variants`,
      status
    );
  }
  return page;
}
function categoriesOf(payload, endpoint, status) {
  const page = paginatedOf(payload, endpoint, status);
  if (!page.data.every(isCategoryShape)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} contained a category entry without id, slug, or name`,
      status
    );
  }
  return page;
}
function checkoutBootstrapOf(payload, endpoint, status) {
  cartOf(payload, endpoint, status);
  if (!isRecord(payload) || !Array.isArray(payload.billing_countries) || !Array.isArray(payload.shipping_countries)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include the billing_countries and shipping_countries arrays`,
      status
    );
  }
  return payload;
}
function placeOrderResultOf(payload, endpoint, status) {
  if (!isRecord(payload) || !isRecord(payload.payment) || typeof payload.payment.state !== "string") {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include the payment.state the checkout contract promises`,
      status
    );
  }
  return payload;
}

// src/resources/cart.ts
var CartResource = class {
  constructor(http, storage) {
    this.http = http;
    this.storage = storage;
    this.chain = Promise.resolve();
  }
  get guid() {
    return this.storage.get();
  }
  /** Forget the persisted cart. Called automatically after a successful checkout. */
  reset() {
    this.storage.clear();
  }
  /** Adds an item, creating the cart on first use (or a fresh one if the stored guid is stale). */
  addItem(input) {
    return this.enqueue(() => this.postItems(input));
  }
  /** Adds several items in one request (`{ items: [...] }` form). */
  addItems(items) {
    return this.enqueue(() => this.postItems({ items }));
  }
  async get(options = {}) {
    const endpoint = `/cart/${this.encodedGuid()}`;
    return this.forgetStoredCartOn404(async () => {
      const { status, body } = await this.http.requestRaw("GET", endpoint, {
        query: { checkout: 1 },
        signal: options.signal
      });
      return cartOf(body, endpoint, status);
    });
  }
  updateItem(itemId, quantity) {
    return this.enqueue(
      () => this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/item/${itemId}`;
        const { status, body } = await this.http.requestRaw("PUT", endpoint, {
          query: { checkout: 1 },
          body: { quantity }
        });
        return cartOf(body, endpoint, status);
      })
    );
  }
  removeItem(itemId) {
    return this.enqueue(
      () => this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/item/${itemId}`;
        const { status, body } = await this.http.requestRaw("DELETE", endpoint, { query: { checkout: 1 } });
        return cartOf(body, endpoint, status);
      })
    );
  }
  /** Set the customer email before applying a coupon — some discounts resolve against the customer. */
  applyCoupon(coupon) {
    return this.enqueue(
      () => this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/coupon`;
        const { status, body } = await this.http.requestRaw("POST", endpoint, {
          query: { checkout: 1 },
          body: { coupon }
        });
        return cartOf(body, endpoint, status);
      })
    );
  }
  removeCoupon() {
    return this.enqueue(
      () => this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/coupon`;
        const { status, body } = await this.http.requestRaw("DELETE", endpoint, { query: { checkout: 1 } });
        return cartOf(body, endpoint, status);
      })
    );
  }
  requireGuid() {
    const guid = this.storage.get();
    if (!guid) {
      throw new CartGenieError("No cart yet \u2014 add an item first.", 0);
    }
    return guid;
  }
  encodedGuid() {
    return encodeURIComponent(this.requireGuid());
  }
  async postItems(body) {
    const guid = this.storage.get();
    if (!guid) {
      return this.createCart(body);
    }
    try {
      const endpoint = `/cart/${encodeURIComponent(guid)}/item`;
      const { status, body: responseBody } = await this.http.requestRaw("POST", endpoint, {
        query: { checkout: 1 },
        body
      });
      const cart = cartOf(responseBody, endpoint, status);
      this.storage.set(cart.guid);
      return cart;
    } catch (error) {
      if (error instanceof CartGenieError && error.status === 404) {
        this.storage.clear();
        return this.createCart(body);
      }
      throw error;
    }
  }
  async createCart(body) {
    const { status, body: responseBody } = await this.http.requestRaw("POST", "/cart/item", {
      query: { checkout: 1 },
      body
    });
    const cart = cartOf(responseBody, "/cart/item", status);
    this.storage.set(cart.guid);
    return cart;
  }
  async forgetStoredCartOn404(operation) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CartGenieError && error.status === 404) {
        this.storage.clear();
      }
      throw error;
    }
  }
  enqueue(operation) {
    const result = this.chain.then(operation, operation);
    this.chain = result.catch(() => void 0);
    return result;
  }
};

// src/resources/categories.ts
var Categories = class {
  constructor(http) {
    this.http = http;
  }
  /** Published categories, cursor-paginated (headless stores). */
  async list(options = {}) {
    const { status, body } = await this.http.requestRaw("GET", "/categories", {
      query: { limit: options.limit, cursor: options.cursor },
      signal: options.signal
    });
    return categoriesOf(body, "/categories", status);
  }
};

// src/payment-options.ts
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var WALLET_KEYS = {
  apple_pay: "applePay",
  google_pay: "googlePay",
  link: "link"
};
function stripeKind(methodKey) {
  if (methodKey === "card") {
    return "stripe-card";
  }
  if (methodKey in WALLET_KEYS) {
    return "stripe-wallet";
  }
  return "stripe-redirect";
}
function toPaymentOptions(methods, context = {}) {
  const options = [];
  const linkInCardElement = (context.features ?? []).includes("stripe_link_option");
  for (const gateway of methods) {
    const type = gateway.type;
    const data = isRecord2(gateway.data) ? gateway.data : {};
    const subMethods = isRecord2(data.methods) ? data.methods : {};
    if (type === "dummy") {
      options.push({ id: "dummy", label: "Card (test)", gateway: type, kind: "card-fields", data: gateway.payload });
      continue;
    }
    const isStripe = type === "stripe" || type === "test-stripe";
    const isPaypal = type === "paypal" || type === "test-paypal";
    const stripe = isStripe ? {
      publishableKey: String(data.publishable_key ?? ""),
      accountId: String(data.account_id ?? ""),
      disableLink: data.disable_link === true,
      linkInCardElement
    } : void 0;
    for (const [key, raw] of Object.entries(subMethods)) {
      const entry = isRecord2(raw) ? raw : {};
      const label = typeof entry.label === "string" ? entry.label : key;
      if (isStripe) {
        options.push({
          id: `stripe:${key}`,
          label,
          gateway: type,
          method: key,
          kind: stripeKind(key),
          wallet: WALLET_KEYS[key],
          stripe,
          data: entry
        });
      } else if (isPaypal) {
        options.push({ id: `paypal:${key}`, label, gateway: type, method: key, kind: "paypal", data: entry });
      } else if (type === "offline") {
        options.push({ id: `offline:${key}`, label, gateway: type, method: key, kind: "offline", data: entry });
      }
    }
  }
  return options;
}

// src/resources/checkout.ts
var Checkout = class {
  constructor(http, cart) {
    this.http = http;
    this.cart = cart;
    this.placing = false;
  }
  /**
   * Checkout bootstrap: the cart plus the store-configured billing_countries /
   * shipping_countries. Country and region selects MUST be rendered from these
   * lists — the API rejects values outside them; a region's id (e.g. "us-ca")
   * is the jurisdiction for setJurisdictions() and shippingMethods().
   */
  async get(options = {}) {
    const endpoint = `/cart/${this.cart.encodedGuid()}/checkout`;
    const { status, body } = await this.http.requestRaw("GET", endpoint, { signal: options.signal });
    return checkoutBootstrapOf(body, endpoint, status);
  }
  async setEmail(email, name) {
    const endpoint = `/cart/${this.cart.encodedGuid()}/email`;
    const { status, body } = await this.http.requestRaw("PATCH", endpoint, {
      query: { checkout: 1 },
      body: { email, name }
    });
    return cartOf(body, endpoint, status);
  }
  async setAddress(address) {
    const endpoint = `/cart/${this.cart.encodedGuid()}/address`;
    const { status, body } = await this.http.requestRaw("PATCH", endpoint, {
      query: { checkout: 1 },
      body: address
    });
    return cartOf(body, endpoint, status);
  }
  async setJurisdictions(billing, shipping = billing) {
    const endpoint = `/cart/${this.cart.encodedGuid()}/jurisdiction`;
    const { status, body } = await this.http.requestRaw("PUT", endpoint, {
      query: { checkout: 1 },
      body: { billing, shipping }
    });
    return cartOf(body, endpoint, status);
  }
  async shippingMethods(jurisdiction, postalCode, options = {}) {
    const segment = postalCode ? `/${encodeURIComponent(postalCode)}` : "";
    const endpoint = `/cart/${this.cart.encodedGuid()}/shipping-methods/${encodeURIComponent(jurisdiction)}${segment}`;
    const { status, body } = await this.http.requestRaw("GET", endpoint, {
      query: { checkout: 1 },
      signal: options.signal
    });
    return arrayOf(body, endpoint, status);
  }
  async setShippingMethod(methodId) {
    const endpoint = `/cart/${this.cart.encodedGuid()}/shipping-method/${encodeURIComponent(String(methodId))}`;
    const { status, body } = await this.http.requestRaw("PATCH", endpoint, { query: { checkout: 1 } });
    return cartOf(body, endpoint, status);
  }
  /**
   * Available gateways. Each entry's `payload` maps Place-Order body fields
   * (dotted paths) to their validation rules — render the payment form from it.
   */
  async paymentMethods(options = {}) {
    const endpoint = `/cart/${this.cart.encodedGuid()}/payment-methods`;
    const { status, body } = await this.http.requestRaw("GET", endpoint, { signal: options.signal });
    return arrayOf(body, endpoint, status);
  }
  /**
   * The flat list of payment options the customer chooses from — one per
   * method across every gateway (Card, Klarna, Apple Pay, PayPal, offline …),
   * not one per gateway. Each carries a `kind` describing how to complete it.
   * Render these; do not surface the gateway `type` as a choice.
   *
   * The cart is fetched alongside the gateways: its `features` decide
   * `stripe.linkInCardElement`, which the wallet helpers use to keep Link from
   * masking Apple/Google Pay in Payment Requests.
   */
  async paymentOptions(options = {}) {
    const [methods, features] = await Promise.all([
      this.paymentMethods(options),
      this.cart.get(options).then((cart) => Array.isArray(cart.features) ? cart.features : []).catch(() => [])
    ]);
    return toPaymentOptions(methods, { features });
  }
  /**
   * Checks a Place Order body against a gateway's `payload` rules from
   * paymentMethods() and returns the dotted paths of required fields that are
   * missing or empty. Run it BEFORE opening a wallet sheet — the sheet opens
   * instantly, and a missing required field otherwise surfaces as a 422 only
   * after the shopper confirms payment. Only plain `required` rules are
   * evaluated client-side (conditional rules need server state); the server
   * stays the source of truth.
   */
  validateOrder(input, rules) {
    const missing = [];
    for (const [path, fieldRules] of Object.entries(rules ?? {})) {
      if (!fieldRules.includes("required")) {
        continue;
      }
      const value = path.split(".").reduce(
        (node, key) => typeof node === "object" && node !== null ? node[key] : void 0,
        input
      );
      if (value === void 0 || value === null || value === "") {
        missing.push(path);
      }
    }
    return missing;
  }
  /**
   * Places the order. Concurrent calls on this instance are rejected while one
   * is in flight (double-click protection); cross-tab / multi-instance safety
   * relies on the idempotency key. On payment.state === 'success' the stored
   * cart guid is cleared automatically: the cart is finalized and must not be reused.
   */
  async placeOrder(input, options = {}) {
    if ((input.payment_method === "stripe" || input.payment_method === "test-stripe") && !input.stripe_payment_method) {
      throw new CartGenieError(
        'Stripe payments require stripe_payment_method in the Place Order body: a PaymentMethod "pm_\u2026" id from Stripe.js for card and wallet options, or the literal method key (e.g. "klarna") for redirect options. There is no pay-after-order path. See the SDK docs, "Payment options".',
        0
      );
    }
    if (this.placing) {
      throw new CartGenieError(
        "A checkout request is already in flight for this cart \u2014 wait for it to settle before retrying.",
        0
      );
    }
    this.placing = true;
    try {
      const endpoint = `/cart/${this.cart.encodedGuid()}/checkout`;
      const { status, body } = await this.http.requestRaw("POST", endpoint, {
        body: input,
        headers: options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : void 0
      });
      const result = placeOrderResultOf(body, endpoint, status);
      if (result.payment?.state === "success") {
        this.cart.reset();
      }
      return result;
    } finally {
      this.placing = false;
    }
  }
};

// src/resources/orders.ts
var Orders = class {
  constructor(http) {
    this.http = http;
  }
  /** Fetch an order by its id (e.g. from a confirmation deep-link or webhook payload). */
  async get(orderId, options = {}) {
    const endpoint = `/order/${encodeURIComponent(String(orderId))}`;
    const { status, body } = await this.http.requestRaw("GET", endpoint, { signal: options.signal });
    return objectOf(body, endpoint, status);
  }
};

// src/resources/products.ts
var Products = class {
  constructor(http) {
    this.http = http;
  }
  /** Cursor-paginated catalog listing (headless stores). Follow meta.next_cursor for more pages. */
  async list(options = {}) {
    const { status, body } = await this.http.requestRaw("GET", "/products", {
      query: { limit: options.limit, cursor: options.cursor },
      signal: options.signal
    });
    return productsOf(body, "/products", status);
  }
  /** Fetch specific products by slug (exempt from the catalog rate limit). */
  async bySlugs(slugs, options = {}) {
    const { status, body } = await this.http.requestRaw("GET", "/products", {
      query: { slugs: slugs.join(",") },
      signal: options.signal
    });
    return productsOf(body, "/products", status);
  }
  async get(slug, options = {}) {
    const endpoint = `/product/${encodeURIComponent(slug)}`;
    const { status, body } = await this.http.requestRaw("GET", endpoint, { signal: options.signal });
    return productOf(body, endpoint, status);
  }
};

// src/storage.ts
var KEY_PREFIX = "cartgenie.cart.guid";
function memoryStorage() {
  let memory = null;
  return {
    get: () => memory,
    set: (guid) => {
      memory = guid;
    },
    clear: () => {
      memory = null;
    }
  };
}
function defaultStorage(namespace = "") {
  const key = namespace ? `${KEY_PREFIX}.${namespace}` : KEY_PREFIX;
  const memory = memoryStorage();
  let usable = true;
  const attempt = (operation, fallback) => {
    if (!usable) {
      return fallback;
    }
    try {
      return operation();
    } catch {
      usable = false;
      return fallback;
    }
  };
  return {
    get: () => {
      const stored = attempt(() => localStorage.getItem(key), null);
      if (!usable) {
        return memory.get();
      }
      if (stored !== null) {
        memory.set(stored);
      }
      return stored;
    },
    set: (guid) => {
      memory.set(guid);
      attempt(() => localStorage.setItem(key, guid), void 0);
    },
    clear: () => {
      memory.clear();
      attempt(() => localStorage.removeItem(key), void 0);
    }
  };
}

// src/checkout-return.ts
function parseCheckoutReturn(search) {
  const params = new URLSearchParams(search);
  const status = params.get("cartgenie_return");
  if (status !== "success" && status !== "cancel") {
    return null;
  }
  return { status, cartGuid: params.get("cart") };
}

// src/wallets.ts
function walletRequestArgs(option) {
  const options = option.data?.options;
  return {
    // paymentRequest() throws on a lowercase country, and the throw is easy
    // to swallow — wallets then silently vanish. Force the correct case here.
    country: String(options?.country ?? "US").toUpperCase(),
    currency: String(options?.currency ?? "usd").toLowerCase()
  };
}
function disabledWallets(option) {
  return option.stripe?.disableLink || option.stripe?.linkInCardElement ? { disableWallets: ["link"] } : {};
}
var probeCache = /* @__PURE__ */ new WeakMap();
async function probeWalletSupport(stripe, options) {
  const walletOptions = options.filter((option) => option.kind === "stripe-wallet");
  if (walletOptions.length === 0) {
    return options;
  }
  const args = walletRequestArgs(walletOptions[0]);
  const disable = disabledWallets(walletOptions[0]);
  const cacheKey = `${args.country}|${args.currency}|${"disableWallets" in disable ? "no-link" : "all"}`;
  let byArgs = probeCache.get(stripe);
  if (!byArgs) {
    byArgs = /* @__PURE__ */ new Map();
    probeCache.set(stripe, byArgs);
  }
  let probe = byArgs.get(cacheKey);
  if (!probe) {
    probe = (async () => {
      const request = stripe.paymentRequest({
        country: args.country,
        currency: args.currency,
        total: { label: "Detect", amount: 1 },
        ...disable
      });
      return request.canMakePayment();
    })().catch((error) => {
      probeCache.get(stripe)?.delete(cacheKey);
      console.warn("[cartgenie] wallet probe failed \u2014 hiding wallet options", error);
      return null;
    });
    byArgs.set(cacheKey, probe);
  }
  const capability = await probe;
  return options.filter(
    (option) => option.kind !== "stripe-wallet" || capability !== null && option.wallet !== void 0 && capability[option.wallet] === true
  );
}
async function payWithWallet(stripe, option, order, placeOrder) {
  if (option.kind !== "stripe-wallet" || !option.wallet) {
    throw new CartGenieError(
      `payWithWallet() needs a stripe-wallet option; got kind "${option.kind}" (${option.id}). Card and redirect options go through placeOrder() directly.`,
      0
    );
  }
  const walletOptions = option.data?.options ?? {};
  const args = walletRequestArgs(option);
  const request = stripe.paymentRequest({
    ...walletOptions,
    ...args,
    ...disabledWallets(option)
  });
  const settled = new Promise((resolve, reject) => {
    request.on("paymentmethod", (async (ev) => {
      try {
        const result = await placeOrder({
          ...order,
          customer_email: order.customer_email || ev.payerEmail || "",
          customer_name: order.customer_name || ev.payerName || void 0,
          payment_method: option.gateway,
          stripe_payment_method: ev.paymentMethod.id
        });
        ev.complete(result.payment?.state === "error" ? "fail" : "success");
        resolve(result);
      } catch (error) {
        ev.complete("fail");
        reject(error);
      }
    }));
    request.on("cancel", (() => {
      reject(new CartGenieError("The shopper closed the wallet sheet without paying.", 0));
    }));
  });
  const capability = await request.canMakePayment();
  if (!capability || capability[option.wallet] !== true) {
    throw new CartGenieError(
      `The ${option.wallet} wallet is not available on this device \u2014 filter options through probeWalletSupport() before rendering.`,
      0
    );
  }
  request.show();
  return settled;
}

// src/index.ts
var DEFAULT_BASE_URL = "https://dash.cartgenie.com/api";
var CartGenie = class {
  constructor(config) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const http = new Http({
      baseUrl,
      apiKey: config.apiKey,
      fetch: config.fetch
    });
    const storage = config.storage ?? defaultStorage(fingerprint(`${baseUrl}|${config.apiKey}`));
    this.products = new Products(http);
    this.categories = new Categories(http);
    this.cart = new CartResource(http, storage);
    this.checkout = new Checkout(http, this.cart);
    this.orders = new Orders(http);
  }
};
function fingerprint(value) {
  let hash = 5381;
  for (let index = 0; index < value.length; index++) {
    hash = (hash << 5) + hash + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}
export {
  CartGenie,
  CartGenieError,
  CartGenieNetworkError,
  CartGenieProtocolError,
  DEFAULT_BASE_URL,
  defaultStorage,
  parseCheckoutReturn,
  payWithWallet,
  probeWalletSupport,
  toPaymentOptions
};
