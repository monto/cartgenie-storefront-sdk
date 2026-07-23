import { CartGenieError } from './errors';
import type { PaymentOption, PlaceOrderInput, PlaceOrderResult, StripeWalletOptions } from './types';

/**
 * The slice of a Stripe.js instance the wallet helpers need. Pass the object
 * returned by `loadStripe(...)` — the SDK stays zero-dependency by not
 * importing `@stripe/stripe-js` itself.
 */
export interface StripeWalletClient {
  paymentRequest(options: Record<string, unknown>): StripePaymentRequestLike;
}

export interface StripePaymentRequestLike {
  canMakePayment(): Promise<Record<string, boolean> | null>;
  show(): void;
  on(event: string, handler: (ev: never) => void): unknown;
}

interface WalletPaymentMethodEvent {
  paymentMethod: { id: string };
  payerEmail?: string | null;
  payerName?: string | null;
  complete(status: 'success' | 'fail'): void;
}

/** `canMakePayment()` result keyed the way Stripe reports wallet availability. */
export type WalletCapability = Record<string, boolean> | null;

function walletRequestArgs(option: PaymentOption): { country: string; currency: string } {
  const options = (option.data as { options?: StripeWalletOptions } | undefined)?.options;

  return {
    // paymentRequest() throws on a lowercase country, and the throw is easy
    // to swallow — wallets then silently vanish. Force the correct case here.
    country: String(options?.country ?? 'US').toUpperCase(),
    currency: String(options?.currency ?? 'usd').toLowerCase(),
  };
}

function disabledWallets(option: PaymentOption): Record<string, unknown> {
  // Link masks wallets inside a Payment Request (canMakePayment answers
  // { link: true, googlePay: false } when Link is available), so it is
  // excluded both when the store serves Link inline in the Card Element and
  // when Link is switched off entirely. The inline card widget is unaffected.
  return option.stripe?.disableLink || option.stripe?.linkInCardElement ? { disableWallets: ['link'] } : {};
}

const probeCache = new WeakMap<StripeWalletClient, Map<string, Promise<WalletCapability>>>();

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
export async function probeWalletSupport(
  stripe: StripeWalletClient,
  options: PaymentOption[],
): Promise<PaymentOption[]> {
  const walletOptions = options.filter((option) => option.kind === 'stripe-wallet');

  if (walletOptions.length === 0) {
    return options;
  }

  const args = walletRequestArgs(walletOptions[0]!);
  const disable = disabledWallets(walletOptions[0]!);
  const cacheKey = `${args.country}|${args.currency}|${'disableWallets' in disable ? 'no-link' : 'all'}`;

  let byArgs = probeCache.get(stripe);
  if (!byArgs) {
    byArgs = new Map();
    probeCache.set(stripe, byArgs);
  }

  let probe = byArgs.get(cacheKey);
  if (!probe) {
    probe = (async () => {
      const request = stripe.paymentRequest({
        country: args.country,
        currency: args.currency,
        total: { label: 'Detect', amount: 1 },
        ...disable,
      });

      return request.canMakePayment();
    })().catch((error): WalletCapability => {
      probeCache.get(stripe)?.delete(cacheKey);
      console.warn('[cartgenie] wallet probe failed — hiding wallet options', error);
      return null;
    });
    byArgs.set(cacheKey, probe);
  }

  const capability = await probe;

  return options.filter(
    (option) =>
      option.kind !== 'stripe-wallet' ||
      (capability !== null && option.wallet !== undefined && capability[option.wallet] === true),
  );
}

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
export async function payWithWallet(
  stripe: StripeWalletClient,
  option: PaymentOption,
  order: PlaceOrderInput,
  placeOrder: (input: PlaceOrderInput) => Promise<PlaceOrderResult>,
): Promise<PlaceOrderResult> {
  if (option.kind !== 'stripe-wallet' || !option.wallet) {
    throw new CartGenieError(
      `payWithWallet() needs a stripe-wallet option; got kind "${option.kind}" (${option.id}). Card and redirect options go through placeOrder() directly.`,
      0,
    );
  }

  const walletOptions = (option.data as { options?: StripeWalletOptions } | undefined)?.options ?? {};
  const args = walletRequestArgs(option);

  const request = stripe.paymentRequest({
    ...walletOptions,
    ...args,
    ...disabledWallets(option),
  });

  const settled = new Promise<PlaceOrderResult>((resolve, reject) => {
    request.on('paymentmethod', (async (ev: WalletPaymentMethodEvent) => {
      try {
        const result = await placeOrder({
          ...order,
          customer_email: order.customer_email || ev.payerEmail || '',
          customer_name: order.customer_name || ev.payerName || undefined,
          payment_method: option.gateway,
          stripe_payment_method: ev.paymentMethod.id,
        });

        ev.complete(result.payment?.state === 'error' ? 'fail' : 'success');
        resolve(result);
      } catch (error) {
        ev.complete('fail');
        reject(error);
      }
    }) as unknown as (ev: never) => void);

    request.on('cancel', (() => {
      reject(new CartGenieError('The shopper closed the wallet sheet without paying.', 0));
    }) as unknown as (ev: never) => void);
  });

  // Stripe requires a canMakePayment() call on THIS instance before show().
  const capability = await request.canMakePayment();

  if (!capability || capability[option.wallet] !== true) {
    throw new CartGenieError(
      `The ${option.wallet} wallet is not available on this device — filter options through probeWalletSupport() before rendering.`,
      0,
    );
  }

  request.show();

  return settled;
}
