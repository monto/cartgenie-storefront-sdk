import { Http } from './http';
import { CartResource } from './resources/cart';
import { Categories } from './resources/categories';
import { Checkout } from './resources/checkout';
import { Orders } from './resources/orders';
import { Products } from './resources/products';
import { defaultStorage, type CartStorage } from './storage';

export const DEFAULT_BASE_URL = 'https://dash.cartgenie.com/api';

export interface CartGenieConfig {
  /** The store's public API key. */
  apiKey: string;
  /** Override the API host (self-hosted / testing). Defaults to production. */
  baseUrl?: string;
  /** Cart guid persistence. Defaults to localStorage namespaced per store, memory when unavailable. */
  storage?: CartStorage;
  /** Custom fetch implementation (SSR, testing). */
  fetch?: typeof fetch;
}

export class CartGenie {
  readonly products: Products;
  readonly categories: Categories;
  readonly cart: CartResource;
  readonly checkout: Checkout;
  readonly orders: Orders;

  constructor(config: CartGenieConfig) {
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const http = new Http({
      baseUrl,
      apiKey: config.apiKey,
      fetch: config.fetch,
    });
    // Namespace covers host AND key: the same key against staging and
    // production on one origin must not share a cart.
    const storage = config.storage ?? defaultStorage(fingerprint(`${baseUrl}|${config.apiKey}`));

    this.products = new Products(http);
    this.categories = new Categories(http);
    this.cart = new CartResource(http, storage);
    this.checkout = new Checkout(http, this.cart);
    this.orders = new Orders(http);
  }
}

/** Short stable hash so the storage key is namespaced per host+store without embedding the API key. */
function fingerprint(value: string): string {
  let hash = 5381;

  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

export { CartGenieError, CartGenieNetworkError, CartGenieProtocolError } from './errors';
export { parseCheckoutReturn } from './checkout-return';
export type { CheckoutReturn } from './checkout-return';
export { toPaymentOptions } from './payment-options';
export { payWithWallet, probeWalletSupport } from './wallets';
export type { StripePaymentRequestLike, StripeWalletClient, WalletCapability } from './wallets';
export type { CallOptions } from './http';
export { defaultStorage } from './storage';
export type { CartStorage } from './storage';
export type { ListCategoriesOptions } from './resources/categories';
export type { ListProductsOptions } from './resources/products';
export type { PlaceOrderOptions } from './resources/checkout';
export type * from './types';
