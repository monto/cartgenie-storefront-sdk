export interface CheckoutReturn {
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
export function parseCheckoutReturn(search: string): CheckoutReturn | null {
  const params = new URLSearchParams(search);
  const status = params.get('cartgenie_return');

  if (status !== 'success' && status !== 'cancel') {
    return null;
  }

  return { status, cartGuid: params.get('cart') };
}
