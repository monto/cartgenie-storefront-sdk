import type { PaymentMethod, PaymentOption, PaymentOptionKind } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const WALLET_KEYS: Record<string, 'applePay' | 'googlePay' | 'link'> = {
  apple_pay: 'applePay',
  google_pay: 'googlePay',
  link: 'link',
};

function stripeKind(methodKey: string): PaymentOptionKind {
  if (methodKey === 'card') {
    return 'stripe-card';
  }

  if (methodKey in WALLET_KEYS) {
    return 'stripe-wallet';
  }

  return 'stripe-redirect';
}

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
export function toPaymentOptions(
  methods: PaymentMethod[],
  context: { features?: unknown[] } = {},
): PaymentOption[] {
  const options: PaymentOption[] = [];
  const linkInCardElement = (context.features ?? []).includes('stripe_link_option');

  for (const gateway of methods) {
    const type = gateway.type;
    const data = isRecord(gateway.data) ? gateway.data : {};
    const subMethods = isRecord(data.methods) ? data.methods : {};

    if (type === 'dummy') {
      options.push({ id: 'dummy', label: 'Card (test)', gateway: type, kind: 'card-fields', data: gateway.payload });
      continue;
    }

    const isStripe = type === 'stripe' || type === 'test-stripe';
    const isPaypal = type === 'paypal' || type === 'test-paypal';
    const stripe = isStripe
      ? {
          publishableKey: String(data.publishable_key ?? ''),
          accountId: String(data.account_id ?? ''),
          disableLink: data.disable_link === true,
          linkInCardElement,
        }
      : undefined;

    for (const [key, raw] of Object.entries(subMethods)) {
      const entry = isRecord(raw) ? raw : {};
      const label = typeof entry.label === 'string' ? entry.label : key;

      if (isStripe) {
        options.push({
          id: `stripe:${key}`,
          label,
          gateway: type,
          method: key,
          kind: stripeKind(key),
          wallet: WALLET_KEYS[key],
          stripe,
          data: entry,
        });
      } else if (isPaypal) {
        options.push({ id: `paypal:${key}`, label, gateway: type, method: key, kind: 'paypal', data: entry });
      } else if (type === 'offline') {
        options.push({ id: `offline:${key}`, label, gateway: type, method: key, kind: 'offline', data: entry });
      }
    }
  }

  return options;
}
