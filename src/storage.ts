/** Where the cart guid is persisted between page loads. */
export interface CartStorage {
  get(): string | null;
  set(guid: string): void;
  clear(): void;
}

const KEY_PREFIX = 'cartgenie.cart.guid';

function memoryStorage(): CartStorage {
  let memory: string | null = null;

  return {
    get: () => memory,
    set: (guid) => {
      memory = guid;
    },
    clear: () => {
      memory = null;
    },
  };
}

/**
 * localStorage-backed guid persistence, namespaced per store so multiple
 * storefronts on one origin (or several SDK instances) don't overwrite each
 * other's cart.
 *
 * Every operation is guarded: localStorage can throw not just on the first
 * access but on any later call (Safari private mode, quota, sandboxed
 * iframes). The in-memory mirror always holds the current value, so after the
 * first failure the storage degrades to memory without losing the guid.
 */
export function defaultStorage(namespace = ''): CartStorage {
  const key = namespace ? `${KEY_PREFIX}.${namespace}` : KEY_PREFIX;
  const memory = memoryStorage();
  let usable = true;

  const attempt = <T>(operation: () => T, fallback: T): T => {
    if (!usable) {
      return fallback;
    }

    try {
      return operation();
    } catch {
      usable = false;

      return fallback;
    }
  };

  return {
    get: () => {
      const stored = attempt(() => localStorage.getItem(key), null);

      if (!usable) {
        return memory.get();
      }

      // Mirror successful reads so a later localStorage failure can't lose the guid.
      if (stored !== null) {
        memory.set(stored);
      }

      return stored;
    },
    set: (guid) => {
      memory.set(guid);
      attempt(() => localStorage.setItem(key, guid), undefined);
    },
    clear: () => {
      memory.clear();
      attempt(() => localStorage.removeItem(key), undefined);
    },
  };
}
