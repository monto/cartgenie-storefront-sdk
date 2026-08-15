import { productOf, productsOf } from '../contract';
import type { CallOptions, Http } from '../http';
import type { Paginated, Product } from '../types';

export interface ListProductsOptions extends CallOptions {
  limit?: number;
  cursor?: string;
}

const MEASUREMENT_FIELDS = ['height', 'length', 'width', 'weight'] as const;

/** The API serves physical measurements as integer hundredths (2050 = 20.5). */
function withDisplayMeasurements(product: Product): Product {
  for (const variant of product.variants ?? []) {
    for (const field of MEASUREMENT_FIELDS) {
      const raw = variant[field];
      if (typeof raw === 'number') {
        variant[field] = Math.round(raw) / 100;
      }
    }
  }

  return product;
}

function withDisplayMeasurementsPage(page: Paginated<Product>): Paginated<Product> {
  page.data.forEach(withDisplayMeasurements);

  return page;
}

export class Products {
  constructor(private readonly http: Http) {}

  /** Cursor-paginated catalog listing (headless stores). Follow meta.next_cursor for more pages. */
  async list(options: ListProductsOptions = {}): Promise<Paginated<Product>> {
    const { status, body } = await this.http.requestRaw('GET', '/products', {
      query: { limit: options.limit, cursor: options.cursor },
      signal: options.signal,
    });

    return withDisplayMeasurementsPage(productsOf(body, '/products', status));
  }

  /** Fetch specific products by slug (exempt from the catalog rate limit). */
  async bySlugs(slugs: string[], options: CallOptions = {}): Promise<Paginated<Product>> {
    const { status, body } = await this.http.requestRaw('GET', '/products', {
      query: { slugs: slugs.join(',') },
      signal: options.signal,
    });

    return withDisplayMeasurementsPage(productsOf(body, '/products', status));
  }

  async get(slug: string, options: CallOptions = {}): Promise<Product> {
    const endpoint = `/product/${encodeURIComponent(slug)}`;
    const { status, body } = await this.http.requestRaw('GET', endpoint, { signal: options.signal });

    return withDisplayMeasurements(productOf(body, endpoint, status));
  }
}
