/**
 * Sticky external reference.
 *
 * A servicing app lands the operator on some ccstreams URL carrying its own
 * record id — `?ref=loan-bd-12-6d7b46` (or `?externalRef=`). We stash that once
 * in sessionStorage and apply it to the NEXT stream/vault created, on whatever
 * page they navigate to. So the ref follows the operator and the servicing
 * side's choice of landing path is irrelevant.
 *
 * It is deliberately one-shot and scoped, because our on-chain match is exact
 * and trusted — whatever ref is on a stream at create becomes the lock every
 * payout is attributed to. A ref that lingered would be a footgun: an unrelated
 * stream created later would silently book its payments to the stale record. So:
 *   - captured once per landing (and stripped from the URL so a reload can't
 *     re-trigger it),
 *   - cleared the moment a stream is created with it,
 *   - shown on the create form with an ✕ so it is visible and removable.
 *
 * The stamped value (`cantonstreams.dev/external-ref`) is only ever set from
 * here → the create request body; the proxy persists it and stamps it verbatim.
 */
import { useSyncExternalStore } from 'react';

const KEY = 'ccstreams.externalRef';
const EVENT = 'ccstreams:externalref';

function emitChange(): void {
  // Same-tab reactivity: `storage` events only fire in OTHER tabs, so we emit
  // our own event for the hook in this tab to observe set/clear.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

/**
 * Run ONCE at app entry, before React renders. If the landing URL carries
 * `?ref=`/`?externalRef=`, move it into sessionStorage (a fresh landing ref
 * supersedes any prior unconsumed one) and strip just those two params from the
 * address bar — other query params (asset, recipient, …) are preserved for the
 * form prefills. Stripping stops a reload from re-attaching a consumed ref.
 */
export function captureExternalRefFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const raw = url.searchParams.get('externalRef') ?? url.searchParams.get('ref');
  if (raw && raw !== '') {
    try {
      window.sessionStorage.setItem(KEY, raw);
    } catch {
      /* sessionStorage unavailable (private mode / disabled) — silently skip */
    }
  }
  if (url.searchParams.has('ref') || url.searchParams.has('externalRef')) {
    url.searchParams.delete('ref');
    url.searchParams.delete('externalRef');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  emitChange();
}

/** The currently-stashed sticky ref, or undefined. */
export function getStoredExternalRef(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const v = window.sessionStorage.getItem(KEY);
    return v && v !== '' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Forget the stashed ref — called after a create consumes it (one-shot), or
 *  when the operator removes it from the form. */
export function clearStoredExternalRef(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
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

/**
 * Reactive view of the sticky ref for the create forms. Re-renders when the ref
 * is captured, cleared here, or changed in another tab. `clear` drops it.
 */
export function useStickyExternalRef(): { readonly ref: string | undefined; readonly clear: () => void } {
  const ref = useSyncExternalStore(subscribe, getStoredExternalRef, () => undefined);
  return { ref, clear: clearStoredExternalRef };
}
