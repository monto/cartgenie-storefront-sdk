export interface ProductOptionValue {
  value: string;
  value_slug: string;
  [key: string]: unknown;
}

export interface ProductOption {
  name: string;
  slug: string;
  values: ProductOptionValue[];
  [key: string]: unknown;
}

export interface ProductVariant {
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

export interface Product {
  id: number;
  name: string;
  slug: string;
  images?: { image_url?: string | null; image_url_large?: string | null };
  options: ProductOption[];
  variants: ProductVariant[];
  kind?: string;
  [key: string]: unknown;
}

export interface Category {
  id: number;
  name: string;
  slug: string;
  description?: string | null;
  meta_description?: string | null;
  published_at?: string | null;
  main_image_url?: string | null;
  [key: string]: unknown;
}

export interface Paginated<T> {
  data: T[];
  links?: { first?: string | null; last?: string | null; prev?: string | null; next?: string | null };
  meta?: { per_page?: number; next_cursor?: string | null; prev_cursor?: string | null; [key: string]: unknown };
}

export interface CartItemOption {
  name: string;
  value: string;
}

export interface CartItem {
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

export interface CartDiscount {
  code: string;
  discount_type?: string;
  messages?: string[];
}

/** Map of Place-Order body field (dotted path) to its validation rules. Null for non-headless stores. */
export type PaymentFieldRules = Record<string, string[]> | null;

export interface PaymentMethod {
  type: string;
  payload: PaymentFieldRules;
  data: unknown;
}

/**
 * How a payment option is completed on the client. The customer picks a
 * METHOD (Card, Klarna, Apple Pay, PayPal, a bank transfer) — never a gateway;
 * `kind` tells you which flow to render for the picked method.
 */
export type PaymentOptionKind =
  | 'card-fields' // dummy test gateway: collect raw card.* fields per `payload`
  | 'stripe-card' // Stripe Elements card field → send the created PaymentMethod pm_… id
  | 'stripe-wallet' // Apple/Google Pay via stripe.paymentRequest(...).show() → pm_… id; offer ONLY after canMakePayment() confirms option.wallet
  | 'stripe-redirect' // Klarna/iDEAL/Bancontact/…: NO Stripe.js — send the literal method key; server returns payment.state 'redirect'
  | 'paypal' // PayPal redirect flow
  | 'offline'; // manual / offline payment with instructions

/** One customer-facing payment choice, flattened across every gateway. */
export interface PaymentOption {
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
  stripe?: { publishableKey: string; accountId: string; disableLink: boolean; linkInCardElement: boolean };
  /** Raw per-option data from the gateway (Stripe wallet `options`, offline `instructions_html`, …). */
  data?: unknown;
}

/**
 * `PaymentOption.data.options` for a `stripe-wallet` option (Apple/Google Pay).
 * Maps directly onto `stripe.paymentRequest(...)`.
 */
export interface StripeWalletOptions {
  country: string;
  currency: string;
  total: { label: string; amount: number };
  requestShipping?: boolean;
  requestPayerName?: boolean;
  requestPayerEmail?: boolean;
  requestPayerPhone?: boolean;
  [key: string]: unknown;
}

/** Shape of `PaymentMethod.data` for the stripe / test-stripe gateways. */
export interface StripeGatewayData {
  publishable_key: string;
  account_id: string;
  disable_link?: boolean;
  /** Enabled sub-methods to offer (card, klarna, apple_pay, google_pay, link, …). */
  methods: Record<string, { label: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface CheckoutBlock {
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
  shipping_methods?: Array<{ id: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface Cart {
  guid: string;
  items: CartItem[];
  formatted_subtotal?: string;
  checkout?: CheckoutBlock;
  [key: string]: unknown;
}

export interface AddItemInput {
  product_variant_id: number;
  quantity?: number;
  [key: string]: unknown;
}

/** Keys for PATCH /cart/{cart}/address (differs from the Place-Order billing_address shape). */
export interface CheckoutAddressInput {
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
export interface OrderAddress {
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

export interface PlaceOrderInput {
  customer_email: string;
  customer_name?: string;
  payment_method: string;
  billing_address?: OrderAddress;
  shipping_address?: OrderAddress;
  shipping_method?: number | string;
  card?: { number: string; expiry_month: number | string; expiry_year: number | string; cvv: string };
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

export interface PlaceOrderResult {
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

export interface RegionOption {
  id: string;
  label: string;
  country: string;
}

export interface CountryOption {
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

export interface ShippingCountryOption extends CountryOption {
  has_per_region_methods?: boolean;
  has_per_postal_code_methods?: boolean;
}

/** GET /cart/{cart}/checkout — the cart plus the store-configured address selects. */
export interface CheckoutBootstrap {
  data: Cart;
  billing_countries: CountryOption[];
  shipping_countries: ShippingCountryOption[];
  [key: string]: unknown;
}

export interface ShippingMethod {
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

export interface Order {
  id?: number;
  name?: string;
  [key: string]: unknown;
}
