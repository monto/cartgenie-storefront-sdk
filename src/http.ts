import { CartGenieError, CartGenieNetworkError, CartGenieProtocolError } from './errors';

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Per-call options accepted by the public resource methods. */
export interface CallOptions {
  signal?: AbortSignal;
}

export class Http {
  private readonly base: string;

  constructor(private readonly config: HttpConfig) {
    let parsed: URL;

    try {
      parsed = new URL(config.baseUrl);
    } catch (cause) {
      throw new CartGenieError(
        `Invalid baseUrl "${config.baseUrl}" — expected an absolute URL like https://dash.cartgenie.com/api`,
        0,
        {},
        { cause },
      );
    }

    if (parsed.search || parsed.hash) {
      throw new CartGenieError(`baseUrl must not contain a query string or fragment: "${config.baseUrl}"`, 0);
    }

    this.base = parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { body } = await this.requestRaw(method, path, options);

    return body as T;
  }

  async requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<{ status: number; body: unknown }> {
    const url = new URL(this.base + path);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const doFetch = this.config.fetch ?? globalThis.fetch;
    let response: Response;

    try {
      response = await doFetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
    } catch (cause) {
      throw new CartGenieNetworkError(`CartGenie request to ${url.pathname} failed before reaching the API`, cause);
    }

    let text: string;

    try {
      text = await response.text();
    } catch (cause) {
      throw new CartGenieNetworkError(
        `CartGenie response body from ${url.pathname} could not be read — the connection dropped mid-response`,
        cause,
      );
    }

    const json = text ? safeParse(text) : undefined;

    if (!response.ok) {
      const message =
        (json && typeof json === 'object' && 'message' in json && typeof json.message === 'string'
          ? json.message
          : undefined) ?? `CartGenie request failed with status ${response.status}`;
      const errors =
        json && typeof json === 'object' && 'errors' in json && json.errors && typeof json.errors === 'object'
          ? (json.errors as Record<string, string[]>)
          : {};

      throw new CartGenieError(message, response.status, errors, {
        retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
      });
    }

    if (json === undefined) {
      throw new CartGenieProtocolError(
        `CartGenie returned status ${response.status} for ${url.pathname} but the body was not valid JSON`,
        response.status,
      );
    }

    return { status: response.status, body: json };
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
