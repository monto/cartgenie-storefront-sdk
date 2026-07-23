interface HttpConfig {
    baseUrl: string;
    apiKey: string;
    fetch?: typeof fetch;
}
interface RequestOptions {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
}
/** Per-call options accepted by the public resource methods. */
interface CallOptions {
    signal?: AbortSignal;
}
declare class Http {
    private readonly config;
    private readonly base;
    constructor(config: HttpConfig);
    request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
    requestRaw(method: string, path: string, options?: RequestOptions): Promise<{
        status: number;
        body: unknown;
    }>;
}

/** Where the cart guid is persisted between page loads. */
interface CartStorage {
    get(): string | null;
    set(guid: string): void;
    clear(): void;
}
/**
 * localStorage-backed guid persistence, namespaced per store so multiple
 * storefronts on one origin (or several SDK instances) don't overwrite each
 * other's cart.
 *
 * Every operation is guarded: localStorage can throw not just on the first
 * access but on any later call (Safari private mode, quota, sandboxed
 * iframes). The in-memory mirror always holds the current value, so after the
 * first failure the storage degrades to memory without losing the guid.
 */
declare function defaultStorage(namespace?: string): CartStorage;

interface ProductOptionValue {
    value: string;
    value_slug: string;
    [key: string]: unknown;
}
interface ProductOption {
    name: string;
    slug: string;
    values: ProductOptionValue[];
    [key: string]: unknown;
}
interface ProductVariant {
    id: number;
    slug: string;
    sku?: string | null;
    price?: number;
    formatted_price?: string;
    formatted_compare_at_price?: string;
    out_of_stock?: boolean;
    stock_quantity?: number | null;
    track_inventory?: boolean;
    shippable?: boolean;
    image_url?: string | null;
    image_url_large?: string | null;
    [key: string]: unknown;
}
interface Product {
    id: number;
    name: string;
    slug: string;
    images?: {
        image_url?: string | null;
        image_url_large?: string | null;
    };
    options: ProductOption[];
    variants: ProductVariant[];
    kind?: string;
    [key: string]: unknown;
}
interface Category {
    id: number;
    name: string;
    slug: string;
    description?: string | null;
    meta_description?: string | null;
    published_at?: string | null;
    main_image_url?: string | null;
    [key: string]: unknown;
}
interface Paginated<T> {
    data: T[];
    links?: {
        first?: string | null;
        last?: string | null;
        prev?: string | null;
        next?: string | null;
    };
    meta?: {
        per_page?: number;
        next_cursor?: string | null;
        prev_cursor?: string | null;
        [key: string]: unknown;
    };
}
interface CartItemOption {
    name: string;
    value: string;
}
interface CartItem {
    id: number;
    name: string;
    slug: string;
    quantity: number;
    image_url?: string | null;
    formatted_price?: string;
    formatted_subtotal?: string;
    options?: CartItemOption[];
    sku?: string | null;
    stock?: number | null;
    availability?: string;
    [key: string]: unknown;
}
interface CartDiscount {
    code: string;
    discount_type?: string;
    messages?: string[];
}
/** Map of Place-Order body field (dotted path) to its validation rules. Null for non-headless stores. */
type PaymentFieldRules = Record<string, string[]> | null;
interface PaymentMethod {
    type: string;
    payload: PaymentFieldRules;
    data: unknown;
}
/**
 * How a payment option is completed on the client. The customer picks a
 * METHOD (Card, Klarna, Apple Pay, PayPal, a bank transfer) — never a gateway;
 * `kind` tells you which flow to render for the picked method.
 */
type PaymentOptionKind = 'card-fields' | 'stripe-card' | 'stripe-wallet' | 'stripe-redirect' | 'paypal' | 'offline';
/** One customer-facing payment choice, flattened across every gateway. */
interface PaymentOption {
    /** Stable selection key, e.g. `stripe:card`, `paypal:paypal`, `offline:bank_transfer`, `dummy`. */
    id: string;
    /** Customer-facing label — "Card", "Klarna", "Apple Pay", "PayPal", "Bank transfer". */
    label: string;
    /** Send this as `payment_method` in the Place Order body. */
    gateway: string;
    /** Sub-method key within the gateway (undefined for single-method gateways like dummy). */
    method?: string;
    /** Which client flow completes this option. */
    kind: PaymentOptionKind;
    /**
     * For `stripe-wallet` options: the `canMakePayment()` result key that must be
     * `true` on this device before the option is shown (Apple Pay exists only in
     * Safari with a saved card, Google Pay in Chrome, etc.). Never render a
     * wallet option without probing.
     */
    wallet?: 'applePay' | 'googlePay' | 'link';
    /**
     * Stripe publishable key + connected account, present for `stripe-*` kinds.
     *
     * Link appears through TWO independent surfaces:
     *  - inline in the Card/Payment Element (saved-card autofill) — controlled by
     *    the account's Link setting; `disableWallets` never affects it;
     *  - inside a wallet Payment Request (Apple/Google Pay). There Link COMPETES
     *    with the wallets: when Link is available, `canMakePayment()` answers
     *    `{ link: true, googlePay: false }` — Link MASKS the wallets. For
     *    Apple/Google Pay to be detected and to open, build the Payment Request
     *    with `disableWallets: ['link']` — in the `canMakePayment()` probe AND
     *    in the one you `show()`.
     *
     * `disableLink` = Link is switched off for the store entirely (never shown).
     * `linkInCardElement` = Link is served inline in the Card Element, so it must
     * be excluded from wallet Payment Requests (or it masks the wallets) — the
     * inline card widget is unaffected by that exclusion. The SDK wallet helpers
     * apply the exclusion automatically when either flag is `true`.
     */
    stripe?: {
        publishableKey: string;
        accountId: string;
        disableLink: boolean;
        linkInCardElement: boolean;
    };
    /** Raw per-option data from the gateway (Stripe wallet `options`, offline `instructions_html`, …). */
    data?: unknown;
}
/**
 * `PaymentOption.data.options` for a `stripe-wallet` option (Apple/Google Pay).
 * Maps directly onto `stripe.paymentRequest(...)`.
 */
interface StripeWalletOptions {
    country: string;
    currency: string;
    total: {
        label: string;
        amount: number;
    };
    requestShipping?: boolean;
    requestPayerName?: boolean;
    requestPayerEmail?: boolean;
    requestPayerPhone?: boolean;
    [key: string]: unknown;
}
/** Shape of `PaymentMethod.data` for the stripe / test-stripe gateways. */
interface StripeGatewayData {
    publishable_key: string;
    account_id: string;
    disable_link?: boolean;
    /** Enabled sub-methods to offer (card, klarna, apple_pay, google_pay, link, …). */
    methods: Record<string, {
        label: string;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}
interface CheckoutBlock {
    email?: string | null;
    currency_code?: string;
    has_shipping?: boolean;
    requires_shipping?: boolean;
    requires_billing?: boolean;
    formatted_subtotal?: string;
    formatted_total?: string;
    formatted_discount_total?: string;
    formatted_tax_total?: string;
    formatted_shipping_total?: string;
    coupon_code?: string | null;
    discounts?: CartDiscount[];
    payment_methods?: PaymentMethod[];
    shipping_methods?: Array<{
        id: number;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}
interface Cart {
    guid: string;
    items: CartItem[];
    formatted_subtotal?: string;
    checkout?: CheckoutBlock;
    [key: string]: unknown;
}
interface AddItemInput {
    product_variant_id: number;
    quantity?: number;
    [key: string]: unknown;
}
/** Keys for PATCH /cart/{cart}/address (differs from the Place-Order billing_address shape). */
interface CheckoutAddressInput {
    country?: number | string;
    region?: string;
    state?: string;
    city?: string;
    address_line_one?: string;
    address_line_two?: string;
    postal_code?: string;
    name?: string;
    phone?: string;
    email?: string;
}
/** Keys for the Place-Order billing_address / shipping_address objects. */
interface OrderAddress {
    full_name?: string;
    /** Required on shipping_address whenever the cart ships — copy the customer's email in. */
    email?: string;
    country?: string;
    region?: string;
    state?: string;
    city?: string;
    line_one?: string;
    line_two?: string;
    zip?: string;
    confirmed?: boolean;
    [key: string]: unknown;
}
interface PlaceOrderInput {
    customer_email: string;
    customer_name?: string;
    payment_method: string;
    billing_address?: OrderAddress;
    shipping_address?: OrderAddress;
    shipping_method?: number | string;
    card?: {
        number: string;
        expiry_month: number | string;
        expiry_year: number | string;
        cvv: string;
    };
    stripe_payment_method?: string;
    offline_payment_method?: string;
    /**
     * Where the platform sends the shopper after a redirect payment method
     * (Klarna, iDEAL, …) completes on the provider's site. Must live on the
     * store's registered site host — other hosts are ignored and the shopper
     * lands on the store's site root instead. The shopper arrives with
     * `?cartgenie_return=success|cancel&cart=<guid>` appended — see
     * `parseCheckoutReturn()`.
     */
    return_url?: string;
    [key: string]: unknown;
}
interface PlaceOrderResult {
    /** The updated cart resource. */
    data?: Cart;
    payment?: {
        state?: 'success' | 'redirect' | 'none' | 'cancelled' | 'error' | string;
        redirect_url?: string | null;
        message?: string;
        [key: string]: unknown;
    };
    /** Human-facing order number (e.g. "#1001") — top-level, next to `payment`. */
    order_name?: string | null;
    [key: string]: unknown;
}
interface RegionOption {
    id: string;
    label: string;
    country: string;
}
interface CountryOption {
    id: string;
    label: string;
    region_label?: string | null;
    /** Empty when the country has no regions — the country id itself is the jurisdiction then. */
    regions: RegionOption[];
    jurisdiction_region_required: boolean;
    per_region_shipping?: boolean;
    postal_code_required?: boolean;
    [key: string]: unknown;
}
interface ShippingCountryOption extends CountryOption {
    has_per_region_methods?: boolean;
    has_per_postal_code_methods?: boolean;
}
/** GET /cart/{cart}/checkout — the cart plus the store-configured address selects. */
interface CheckoutBootstrap {
    data: Cart;
    billing_countries: CountryOption[];
    shipping_countries: ShippingCountryOption[];
    [key: string]: unknown;
}
interface ShippingMethod {
    id: number;
    label?: string;
    description?: string | null;
    cost?: number;
    cost_formatted?: string;
    is_taxable?: boolean;
    tax_amount_formatted?: string;
    cost_total?: number;
    cost_total_formatted?: string;
    selected?: boolean;
    [key: string]: unknown;
}
interface Order {
    id?: number;
    name?: string;
    [key: string]: unknown;
}

/**
 * Cart lifecycle. The cart guid is persisted through the configured storage;
 * cart reads and mutations carry checkout=1 so responses include the totals block.
 *
 * Mutations are serialized per instance: concurrent addItem calls queue up so
 * the first one creates the cart and the rest join it — without this, parallel
 * first-adds would each create their own cart and strand items.
 *
 * Stale-cart recovery: a stored guid can become unresolvable (checkout
 * finalized it, TTL, admin action). Any cart call that 404s on the stored guid
 * clears it, and `addItem` transparently starts a fresh cart — so a shopper is
 * never stuck after a completed order.
 */
declare class CartResource {
    private readonly http;
    private readonly storage;
    private chain;
    constructor(http: Http, storage: CartStorage);
    get guid(): string | null;
    /** Forget the persisted cart. Called automatically after a successful checkout. */
    reset(): void;
    /** Adds an item, creating the cart on first use (or a fresh one if the stored guid is stale). */
    addItem(input: AddItemInput): Promise<Cart>;
    /** Adds several items in one request (`{ items: [...] }` form). */
    addItems(items: AddItemInput[]): Promise<Cart>;
    get(options?: CallOptions): Promise<Cart>;
    updateItem(itemId: number, quantity: number): Promise<Cart>;
    removeItem(itemId: number): Promise<Cart>;
    /** Set the customer email before applying a coupon — some discounts resolve against the customer. */
    applyCoupon(coupon: string): Promise<Cart>;
    removeCoupon(): Promise<Cart>;
    requireGuid(): string;
    encodedGuid(): string;
    private postItems;
    private createCart;
    private forgetStoredCartOn404;
    private enqueue;
}

interface ListCategoriesOptions extends CallOptions {
    limit?: number;
    cursor?: string;
}
declare class Categories {
    private readonly http;
    constructor(http: Http);
    /** Published categories, cursor-paginated (headless stores). */
    list(options?: ListCategoriesOptions): Promise<Paginated<Category>>;
}

interface PlaceOrderOptions {
    /**
     * Sent as the Idempotency-Key header. Generate one key per checkout attempt
     * and reuse it when retrying after a network timeout — the API replays the
     * original response for a retry whose key already produced an order.
     */
    idempotencyKey?: string;
}
/**
 * Checkout steps, in order: setEmail → setAddress → (when the cart ships)
 * setJurisdictions → shippingMethods → setShippingMethod → paymentMethods → placeOrder.
 */
declare class Checkout {
    private readonly http;
    private readonly cart;
    private placing;
    constructor(http: Http, cart: CartResource);
    /**
     * Checkout bootstrap: the cart plus the store-configured billing_countries /
     * shipping_countries. Country and region selects MUST be rendered from these
     * lists — the API rejects values outside them; a region's id (e.g. "us-ca")
     * is the jurisdiction for setJurisdictions() and shippingMethods().
     */
    get(options?: CallOptions): Promise<CheckoutBootstrap>;
    setEmail(email: string, name?: string): Promise<Cart>;
    setAddress(address: CheckoutAddressInput): Promise<Cart>;
    setJurisdictions(billing: string, shipping?: string): Promise<Cart>;
    shippingMethods(jurisdiction: string, postalCode?: string, options?: CallOptions): Promise<ShippingMethod[]>;
    setShippingMethod(methodId: number | string): Promise<Cart>;
    /**
     * Available gateways. Each entry's `payload` maps Place-Order body fields
     * (dotted paths) to their validation rules — render the payment form from it.
     */
    paymentMethods(options?: CallOptions): Promise<PaymentMethod[]>;
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
    paymentOptions(options?: CallOptions): Promise<PaymentOption[]>;
    /**
     * Checks a Place Order body against a gateway's `payload` rules from
     * paymentMethods() and returns the dotted paths of required fields that are
     * missing or empty. Run it BEFORE opening a wallet sheet — the sheet opens
     * instantly, and a missing required field otherwise surfaces as a 422 only
     * after the shopper confirms payment. Only plain `required` rules are
     * evaluated client-side (conditional rules need server state); the server
     * stays the source of truth.
     */
    validateOrder(input: PlaceOrderInput, rules: Record<string, string[]> | null | undefined): string[];
    /**
     * Places the order. Concurrent calls on this instance are rejected while one
     * is in flight (double-click protection); cross-tab / multi-instance safety
     * relies on the idempotency key. On payment.state === 'success' the stored
     * cart guid is cleared automatically: the cart is finalized and must not be reused.
     */
    placeOrder(input: PlaceOrderInput, options?: PlaceOrderOptions): Promise<PlaceOrderResult>;
}

declare class Orders {
    private readonly http;
    constructor(http: Http);
    /** Fetch an order by its id (e.g. from a confirmation deep-link or webhook payload). */
    get(orderId: number | string, options?: CallOptions): Promise<Order>;
}

interface ListProductsOptions extends CallOptions {
    limit?: number;
    cursor?: string;
}
declare class Products {
    private readonly http;
    constructor(http: Http);
    /** Cursor-paginated catalog listing (headless stores). Follow meta.next_cursor for more pages. */
    list(options?: ListProductsOptions): Promise<Paginated<Product>>;
    /** Fetch specific products by slug (exempt from the catalog rate limit). */
    bySlugs(slugs: string[], options?: CallOptions): Promise<Paginated<Product>>;
    get(slug: string, options?: CallOptions): Promise<Product>;
}

declare class CartGenieError extends Error {
    readonly status: number;
    /** Validation errors keyed by dotted path, e.g. { "card.number": ["..."] }. */
    readonly errors: Record<string, string[]>;
    /** Parsed Retry-After header (seconds) when the API rate-limited the request (HTTP 429). */
    readonly retryAfterSeconds?: number;
    /** Underlying failure for network errors (the rejected fetch error). */
    readonly cause?: unknown;
    constructor(message: string, status: number, errors?: Record<string, string[]>, options?: {
        cause?: unknown;
        retryAfterSeconds?: number;
    });
    get isValidationError(): boolean;
    get isRateLimited(): boolean;
    /**
     * Dotted error keys expanded into a nested object so each message can be
     * attached to its form field: { card: { number: ["..."] } }.
     *
     * Built on null-prototype objects, and paths containing prototype-polluting
     * segments (__proto__, prototype, constructor) are dropped entirely.
     */
    fieldErrors(): Record<string, unknown>;
}
/** The API answered 2xx but the body was not the JSON the contract promises. */
declare class CartGenieProtocolError extends CartGenieError {
    constructor(message: string, status: number);
}
/** The request never reached the API (DNS, offline, CORS, abort). Inspect `cause`. */
declare class CartGenieNetworkError extends CartGenieError {
    constructor(message: string, cause: unknown);
}

interface CheckoutReturn {
    status: 'success' | 'cancel';
    cartGuid: string | null;
}
/**
 * Parses the query string the platform appends when it sends the shopper back
 * to the store after a redirect payment method (Klarna, iDEAL, …). Call it on
 * page load with `location.search`; a non-null result means this visit is a
 * checkout return — show the confirmation (or cancellation) screen, and on
 * `success` clear the finalized cart with `cartgenie.cart.reset()`.
 */
declare function parseCheckoutReturn(search: string): CheckoutReturn | null;

/**
 * Flattens the gateway list from `GET /payment-methods` into the flat list of
 * payment options a customer actually chooses from.
 *
 * The API groups options by GATEWAY (`stripe`, `paypal`, `offline`, `dummy`),
 * but a shopper picks a METHOD — Card, Klarna, Apple Pay, PayPal, a bank
 * transfer — so a single "Stripe" radio is wrong. This expands each gateway's
 * `data.methods` (or the dummy card form) into one option per method, each
 * tagged with a `kind` that tells the UI how to complete it. Send
 * `option.gateway` as `payment_method` in the Place Order body.
 *
 * `context.features` is the cart's `features` array — it drives
 * `stripe.linkInCardElement` (Link served inline in the Card Element, so the
 * wallet helpers exclude it from Payment Requests). `checkout.paymentOptions()`
 * passes it automatically.
 */
declare function toPaymentOptions(methods: PaymentMethod[], context?: {
    features?: unknown[];
}): PaymentOption[];

/**
 * The slice of a Stripe.js instance the wallet helpers need. Pass the object
 * returned by `loadStripe(...)` — the SDK stays zero-dependency by not
 * importing `@stripe/stripe-js` itself.
 */
interface StripeWalletClient {
    paymentRequest(options: Record<string, unknown>): StripePaymentRequestLike;
}
interface StripePaymentRequestLike {
    canMakePayment(): Promise<Record<string, boolean> | null>;
    show(): void;
    on(event: string, handler: (ev: never) => void): unknown;
}
/** `canMakePayment()` result keyed the way Stripe reports wallet availability. */
type WalletCapability = Record<string, boolean> | null;
/**
 * Filters the payment options down to what this device can actually pay with:
 * non-wallet options pass through untouched; each `stripe-wallet` option stays
 * only when the device probe reports its wallet available.
 *
 * ONE `canMakePayment()` probe covers all wallets, with fixed arguments
 * (`total: { label: 'Detect', amount: 1 }`) — Chrome rate-limits probes whose
 * arguments vary (live cart totals!) by silently answering `false` for
 * ~30 minutes. Results are cached per Stripe instance, so calling this on
 * every re-render is safe and never re-probes.
 */
declare function probeWalletSupport(stripe: StripeWalletClient, options: PaymentOption[]): Promise<PaymentOption[]>;
/**
 * Opens the native wallet sheet for a probed `stripe-wallet` option and places
 * the order with the resulting PaymentMethod id. Call it directly from the
 * click handler — `show()` needs the user gesture.
 *
 * Handles the pieces that are easy to get wrong by hand: `canMakePayment()`
 * is awaited on the SAME paymentRequest instance before `show()` (Stripe
 * throws an IntegrationError otherwise), the shopper's wallet email/name fill
 * empty order fields, and the sheet is completed with `success` / `fail`
 * based on the Place Order outcome. Rejects with a `CartGenieError` when the
 * shopper closes the sheet.
 *
 * Validate the required Place Order fields BEFORE calling this — the sheet
 * opens instantly and a 422 surfaces only after the shopper confirms.
 */
declare function payWithWallet(stripe: StripeWalletClient, option: PaymentOption, order: PlaceOrderInput, placeOrder: (input: PlaceOrderInput) => Promise<PlaceOrderResult>): Promise<PlaceOrderResult>;

declare const DEFAULT_BASE_URL = "https://dash.cartgenie.com/api";
interface CartGenieConfig {
    /** The store's public API key. */
    apiKey: string;
    /** Override the API host (self-hosted / testing). Defaults to production. */
    baseUrl?: string;
    /** Cart guid persistence. Defaults to localStorage namespaced per store, memory when unavailable. */
    storage?: CartStorage;
    /** Custom fetch implementation (SSR, testing). */
    fetch?: typeof fetch;
}
declare class CartGenie {
    readonly products: Products;
    readonly categories: Categories;
    readonly cart: CartResource;
    readonly checkout: Checkout;
    readonly orders: Orders;
    constructor(config: CartGenieConfig);
}

export { type AddItemInput, type CallOptions, type Cart, type CartDiscount, CartGenie, type CartGenieConfig, CartGenieError, CartGenieNetworkError, CartGenieProtocolError, type CartItem, type CartItemOption, type CartStorage, type Category, type CheckoutAddressInput, type CheckoutBlock, type CheckoutBootstrap, type CheckoutReturn, type CountryOption, DEFAULT_BASE_URL, type ListCategoriesOptions, type ListProductsOptions, type Order, type OrderAddress, type Paginated, type PaymentFieldRules, type PaymentMethod, type PaymentOption, type PaymentOptionKind, type PlaceOrderInput, type PlaceOrderOptions, type PlaceOrderResult, type Product, type ProductOption, type ProductOptionValue, type ProductVariant, type RegionOption, type ShippingCountryOption, type ShippingMethod, type StripeGatewayData, type StripePaymentRequestLike, type StripeWalletClient, type StripeWalletOptions, type WalletCapability, defaultStorage, parseCheckoutReturn, payWithWallet, probeWalletSupport, toPaymentOptions };
