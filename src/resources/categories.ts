import { categoriesOf } from '../contract';
import type { CallOptions, Http } from '../http';
import type { Category, Paginated } from '../types';

export interface ListCategoriesOptions extends CallOptions {
  limit?: number;
  cursor?: string;
}

export class Categories {
  constructor(private readonly http: Http) {}

  /** Published categories, cursor-paginated (headless stores). */
  async list(options: ListCategoriesOptions = {}): Promise<Paginated<Category>> {
    const { status, body } = await this.http.requestRaw('GET', '/categories', {
      query: { limit: options.limit, cursor: options.cursor },
      signal: options.signal,
    });

    return categoriesOf(body, '/categories', status);
  }
}
