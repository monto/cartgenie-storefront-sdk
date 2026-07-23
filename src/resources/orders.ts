import { objectOf } from '../contract';
import type { CallOptions, Http } from '../http';
import type { Order } from '../types';

export class Orders {
  constructor(private readonly http: Http) {}

  /** Fetch an order by its id (e.g. from a confirmation deep-link or webhook payload). */
  async get(orderId: number | string, options: CallOptions = {}): Promise<Order> {
    const endpoint = `/order/${encodeURIComponent(String(orderId))}`;
    const { status, body } = await this.http.requestRaw('GET', endpoint, { signal: options.signal });

    return objectOf<Order>(body, endpoint, status);
  }
}
