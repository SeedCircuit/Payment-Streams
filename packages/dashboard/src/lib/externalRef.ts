/**
 * Read the caller-supplied external reference from the current URL's query
 * string — `externalRef`, or the shorter `ref` (e.g. `/v1/create?ref=LOCK-123`).
 *
 * Returned verbatim; empty/absent ⇒ undefined. Forwarded into the create
 * request so the proxy persists it and stamps it onto every payout's on-chain
 * metadata as `cantonstreams.dev/external-ref`, letting a servicing app
 * reconcile each on-ledger payment to its own record by exact match.
 */
export function externalRefFromUrl(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const p = new URLSearchParams(window.location.search);
  const raw = p.get('externalRef') ?? p.get('ref');
  return raw && raw !== '' ? raw : undefined;
}
