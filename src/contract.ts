import { CartGenieProtocolError } from './errors';
import type { Cart, Category, CheckoutBootstrap, Paginated, PlaceOrderResult, Product } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProductShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.slug === 'string' &&
    typeof value.name === 'string' &&
    Array.isArray(value.variants)
  );
}

function isCategoryShape(value: unknown): boolean {
  return isRecord(value) && typeof value.id === 'number' && typeof value.slug === 'string' && typeof value.name === 'string';
}

/** Unwraps the `{ data: ... }` envelope, throwing a protocol error when it's absent. */
export function dataOf(payload: unknown, endpoint: string, status: number): unknown {
  if (!isRecord(payload) || !('data' in payload)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} is missing the { data } envelope the contract promises`,
      status,
    );
  }

  return payload.data;
}

export function cartOf(payload: unknown, endpoint: string, status: number): Cart {
  const data = dataOf(payload, endpoint, status);

  if (!isRecord(data) || typeof data.guid !== 'string' || !Array.isArray(data.items)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include a cart with a string guid and an items array`,
      status,
    );
  }

  return data as unknown as Cart;
}

export function arrayOf<T>(payload: unknown, endpoint: string, status: number): T[] {
  const data = dataOf(payload, endpoint, status);

  if (!Array.isArray(data) || !data.every(isRecord)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include a data array of objects`,
      status,
    );
  }

  return data as T[];
}

export function objectOf<T>(payload: unknown, endpoint: string, status: number): T {
  const data = dataOf(payload, endpoint, status);

  if (!isRecord(data)) {
    throw new CartGenieProtocolError(`CartGenie response from ${endpoint} did not include a data object`, status);
  }

  return data as T;
}

export function paginatedOf<T>(payload: unknown, endpoint: string, status: number): Paginated<T> {
  if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.every(isRecord)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} is not a paginated collection with a data array of objects`,
      status,
    );
  }

  return payload as unknown as Paginated<T>;
}

export function productOf(payload: unknown, endpoint: string, status: number): Product {
  const data = dataOf(payload, endpoint, status);

  if (!isProductShape(data)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include a product with id, slug, name, and variants`,
      status,
    );
  }

  return data as unknown as Product;
}

export function productsOf(payload: unknown, endpoint: string, status: number): Paginated<Product> {
  const page = paginatedOf<Product>(payload, endpoint, status);

  if (!page.data.every(isProductShape)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} contained a product entry without id, slug, name, or variants`,
      status,
    );
  }

  return page;
}

export function categoriesOf(payload: unknown, endpoint: string, status: number): Paginated<Category> {
  const page = paginatedOf<Category>(payload, endpoint, status);

  if (!page.data.every(isCategoryShape)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} contained a category entry without id, slug, or name`,
      status,
    );
  }

  return page;
}

export function checkoutBootstrapOf(payload: unknown, endpoint: string, status: number): CheckoutBootstrap {
  cartOf(payload, endpoint, status);

  if (!isRecord(payload) || !Array.isArray(payload.billing_countries) || !Array.isArray(payload.shipping_countries)) {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include the billing_countries and shipping_countries arrays`,
      status,
    );
  }

  return payload as unknown as CheckoutBootstrap;
}

export function placeOrderResultOf(payload: unknown, endpoint: string, status: number): PlaceOrderResult {
  if (!isRecord(payload) || !isRecord(payload.payment) || typeof payload.payment.state !== 'string') {
    throw new CartGenieProtocolError(
      `CartGenie response from ${endpoint} did not include the payment.state the checkout contract promises`,
      status,
    );
  }

  return payload as unknown as PlaceOrderResult;
}
