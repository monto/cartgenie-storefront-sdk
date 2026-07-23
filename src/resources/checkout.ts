import { arrayOf, cartOf, checkoutBootstrapOf, placeOrderResultOf } from '../contract';
import { CartGenieError } from '../errors';
import { toPaymentOptions } from '../payment-options';
import type { CallOptions, Http } from '../http';
import type { CartResource } from './cart';
import type {
  Cart,
  CheckoutAddressInput,
  CheckoutBootstrap,
  PaymentMethod,
  PaymentOption,
  PlaceOrderInput,
  PlaceOrderResult,
  ShippingMethod,
} from '../types';

export interface PlaceOrderOptions {
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
export class Checkout {
  private placing = false;

  constructor(
    private readonly http: Http,
    private readonly cart: CartResource,
  ) {}

  /**
   * Checkout bootstrap: the cart plus the store-configured billing_countries /
   * shipping_countries. Country and region selects MUST be rendered from these
   * lists — the API rejects values outside them; a region's id (e.g. "us-ca")
   * is the jurisdiction for setJurisdictions() and shippingMethods().
   */
  async get(options: CallOptions = {}): Promise<CheckoutBootstrap> {
    const endpoint = `/cart/${this.cart.encodedGuid()}/checkout`;
    const { status, body } = await this.http.requestRaw('GET', endpoint, { signal: options.signal });

    return checkoutBootstrapOf(body, endpoint, status);
  }

  async setEmail(email: string, name?: string): Promise<Cart> {
    const endpoint = `/cart/${this.cart.encodedGuid()}/email`;
    const { status, body } = await this.http.requestRaw('PATCH', endpoint, {
      query: { checkout: 1 },
      body: { email, name },
    });

    return cartOf(body, endpoint, status);
  }

  async setAddress(address: CheckoutAddressInput): Promise<Cart> {
    const endpoint = `/cart/${this.cart.encodedGuid()}/address`;
    const { status, body } = await this.http.requestRaw('PATCH', endpoint, {
      query: { checkout: 1 },
      body: address,
    });

    return cartOf(body, endpoint, status);
  }

  async setJurisdictions(billing: string, shipping: string = billing): Promise<Cart> {
    const endpoint = `/cart/${this.cart.encodedGuid()}/jurisdiction`;
    const { status, body } = await this.http.requestRaw('PUT', endpoint, {
      query: { checkout: 1 },
      body: { billing, shipping },
    });

    return cartOf(body, endpoint, status);
  }

  async shippingMethods(
    jurisdiction: string,
    postalCode?: string,
    options: CallOptions = {},
  ): Promise<ShippingMethod[]> {
    const segment = postalCode ? `/${encodeURIComponent(postalCode)}` : '';
    const endpoint = `/cart/${this.cart.encodedGuid()}/shipping-methods/${encodeURIComponent(jurisdiction)}${segment}`;
    const { status, body } = await this.http.requestRaw('GET', endpoint, {
      query: { checkout: 1 },
      signal: options.signal,
    });

    return arrayOf<ShippingMethod>(body, endpoint, status);
  }

  async setShippingMethod(methodId: number | string): Promise<Cart> {
    const endpoint = `/cart/${this.cart.encodedGuid()}/shipping-method/${encodeURIComponent(String(methodId))}`;
    const { status, body } = await this.http.requestRaw('PATCH', endpoint, { query: { checkout: 1 } });

    return cartOf(body, endpoint, status);
  }

  /**
   * Available gateways. Each entry's `payload` maps Place-Order body fields
   * (dotted paths) to their validation rules — render the payment form from it.
   */
  async paymentMethods(options: CallOptions = {}): Promise<PaymentMethod[]> {
    const endpoint = `/cart/${this.cart.encodedGuid()}/payment-methods`;
    const { status, body } = await this.http.requestRaw('GET', endpoint, { signal: options.signal });

    return arrayOf<PaymentMethod>(body, endpoint, status);
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
  async paymentOptions(options: CallOptions = {}): Promise<PaymentOption[]> {
    const [methods, features] = await Promise.all([
      this.paymentMethods(options),
      this.cart
        .get(options)
        .then((cart) => (Array.isArray(cart.features) ? (cart.features as unknown[]) : []))
        .catch(() => [] as unknown[]),
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
  validateOrder(input: PlaceOrderInput, rules: Record<string, string[]> | null | undefined): string[] {
    const missing: string[] = [];

    for (const [path, fieldRules] of Object.entries(rules ?? {})) {
      if (!fieldRules.includes('required')) {
        continue;
      }

      const value = path
        .split('.')
        .reduce<unknown>(
          (node, key) =>
            typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined,
          input,
        );

      if (value === undefined || value === null || value === '') {
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
  async placeOrder(input: PlaceOrderInput, options: PlaceOrderOptions = {}): Promise<PlaceOrderResult> {
    if ((input.payment_method === 'stripe' || input.payment_method === 'test-stripe') && !input.stripe_payment_method) {
      throw new CartGenieError(
        'Stripe payments require stripe_payment_method in the Place Order body: a PaymentMethod "pm_…" id from Stripe.js for card and wallet options, or the literal method key (e.g. "klarna") for redirect options. There is no pay-after-order path. See the SDK docs, "Payment options".',
        0,
      );
    }

    if (this.placing) {
      throw new CartGenieError(
        'A checkout request is already in flight for this cart — wait for it to settle before retrying.',
        0,
      );
    }

    this.placing = true;

    try {
      const endpoint = `/cart/${this.cart.encodedGuid()}/checkout`;
      const { status, body } = await this.http.requestRaw('POST', endpoint, {
        body: input,
        headers: options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined,
      });
      const result = placeOrderResultOf(body, endpoint, status);

      if (result.payment?.state === 'success') {
        this.cart.reset();
      }

      return result;
    } finally {
      this.placing = false;
    }
  }
}
