import { cartOf } from '../contract';
import { CartGenieError } from '../errors';
import type { CallOptions, Http } from '../http';
import type { CartStorage } from '../storage';
import type { AddItemInput, Cart } from '../types';

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
export class CartResource {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly http: Http,
    private readonly storage: CartStorage,
  ) {}

  get guid(): string | null {
    return this.storage.get();
  }

  /** Forget the persisted cart. Called automatically after a successful checkout. */
  reset(): void {
    this.storage.clear();
  }

  /** Adds an item, creating the cart on first use (or a fresh one if the stored guid is stale). */
  addItem(input: AddItemInput): Promise<Cart> {
    return this.enqueue(() => this.postItems(input));
  }

  /** Adds several items in one request (`{ items: [...] }` form). */
  addItems(items: AddItemInput[]): Promise<Cart> {
    return this.enqueue(() => this.postItems({ items }));
  }

  async get(options: CallOptions = {}): Promise<Cart> {
    const endpoint = `/cart/${this.encodedGuid()}`;

    return this.forgetStoredCartOn404(async () => {
      const { status, body } = await this.http.requestRaw('GET', endpoint, {
        query: { checkout: 1 },
        signal: options.signal,
      });

      return cartOf(body, endpoint, status);
    });
  }

  updateItem(itemId: number, quantity: number): Promise<Cart> {
    return this.enqueue(() =>
      this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/item/${itemId}`;
        const { status, body } = await this.http.requestRaw('PUT', endpoint, {
          query: { checkout: 1 },
          body: { quantity },
        });

        return cartOf(body, endpoint, status);
      }),
    );
  }

  removeItem(itemId: number): Promise<Cart> {
    return this.enqueue(() =>
      this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/item/${itemId}`;
        const { status, body } = await this.http.requestRaw('DELETE', endpoint, { query: { checkout: 1 } });

        return cartOf(body, endpoint, status);
      }),
    );
  }

  /** Set the customer email before applying a coupon — some discounts resolve against the customer. */
  applyCoupon(coupon: string): Promise<Cart> {
    return this.enqueue(() =>
      this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/coupon`;
        const { status, body } = await this.http.requestRaw('POST', endpoint, {
          query: { checkout: 1 },
          body: { coupon },
        });

        return cartOf(body, endpoint, status);
      }),
    );
  }

  removeCoupon(): Promise<Cart> {
    return this.enqueue(() =>
      this.forgetStoredCartOn404(async () => {
        const endpoint = `/cart/${this.encodedGuid()}/coupon`;
        const { status, body } = await this.http.requestRaw('DELETE', endpoint, { query: { checkout: 1 } });

        return cartOf(body, endpoint, status);
      }),
    );
  }

  requireGuid(): string {
    const guid = this.storage.get();

    if (!guid) {
      throw new CartGenieError('No cart yet — add an item first.', 0);
    }

    return guid;
  }

  encodedGuid(): string {
    return encodeURIComponent(this.requireGuid());
  }

  private async postItems(body: unknown): Promise<Cart> {
    const guid = this.storage.get();

    if (!guid) {
      return this.createCart(body);
    }

    try {
      const endpoint = `/cart/${encodeURIComponent(guid)}/item`;
      const { status, body: responseBody } = await this.http.requestRaw('POST', endpoint, {
        query: { checkout: 1 },
        body,
      });
      const cart = cartOf(responseBody, endpoint, status);
      this.storage.set(cart.guid);

      return cart;
    } catch (error) {
      // Stored guid is gone (e.g. the cart was finalized by a checkout) — start fresh.
      if (error instanceof CartGenieError && error.status === 404) {
        this.storage.clear();

        return this.createCart(body);
      }

      throw error;
    }
  }

  private async createCart(body: unknown): Promise<Cart> {
    const { status, body: responseBody } = await this.http.requestRaw('POST', '/cart/item', {
      query: { checkout: 1 },
      body,
    });
    const cart = cartOf(responseBody, '/cart/item', status);
    this.storage.set(cart.guid);

    return cart;
  }

  private async forgetStoredCartOn404<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CartGenieError && error.status === 404) {
        this.storage.clear();
      }

      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation, operation);
    this.chain = result.catch(() => undefined);

    return result;
  }
}
