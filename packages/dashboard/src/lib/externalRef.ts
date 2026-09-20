import { useSyncExternalStore } from 'react';

const KEY = 'ccstreams.externalRef';
const EVENT = 'ccstreams:externalref';

function emitChange(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

function useSessionStorage(action: (storage: Storage) => void): void {
  try {
    action(window.sessionStorage);
  } catch {
    return;
  }
}

export function captureExternalRefFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('externalRef') ?? url.searchParams.get('ref');
  if (raw && raw !== '') {
    useSessionStorage((storage) => storage.setItem(KEY, raw));
  }
  if (url.searchParams.has('ref') || url.searchParams.has('externalRef')) {
    url.searchParams.delete('ref');
    url.searchParams.delete('externalRef');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  emitChange();
}

export function getStoredExternalRef(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const v = window.sessionStorage.getItem(KEY);
    return v && v !== '' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function clearStoredExternalRef(): void {
  if (typeof window === 'undefined') return;
  useSessionStorage((storage) => storage.removeItem(KEY));
  emitChange();
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

export function useStickyExternalRef(): { readonly ref: string | undefined; readonly clear: () => void } {
  const ref = useSyncExternalStore(subscribe, getStoredExternalRef, () => undefined);
  return { ref, clear: clearStoredExternalRef };
}
