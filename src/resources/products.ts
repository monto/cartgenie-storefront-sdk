import { productOf, productsOf } from '../contract';
import type { CallOptions, Http } from '../http';
import type { Paginated, Product } from '../types';

export interface ListProductsOptions extends CallOptions {
  limit?: number;
  cursor?: string;
}

export class Products {
  constructor(private readonly http: Http) {}

  /** Cursor-paginated catalog listing (headless stores). Follow meta.next_cursor for more pages. */
  async list(options: ListProductsOptions = {}): Promise<Paginated<Product>> {
    const { status, body } = await this.http.requestRaw('GET', '/products', {
      query: { limit: options.limit, cursor: options.cursor },
      signal: options.signal,
    });

    return productsOf(body, '/products', status);
  }

  /** Fetch specific products by slug (exempt from the catalog rate limit). */
  async bySlugs(slugs: string[], options: CallOptions = {}): Promise<Paginated<Product>> {
    const { status, body } = await this.http.requestRaw('GET', '/products', {
      query: { slugs: slugs.join(',') },
      signal: options.signal,
    });

    return productsOf(body, '/products', status);
  }

  async get(slug: string, options: CallOptions = {}): Promise<Product> {
    const endpoint = `/product/${encodeURIComponent(slug)}`;
    const { status, body } = await this.http.requestRaw('GET', endpoint, { signal: options.signal });

    return productOf(body, endpoint, status);
  }
}
