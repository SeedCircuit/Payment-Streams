/**
 * Incoming view + accept for a wallet party that is NOT hosted on the proxy's
 * participant (e.g. a Loop party). Such a party's incoming
 * AmuletTransferInstructions and delivered Amulets are only witnessed by ITS
 * OWN participant, so the proxy's `/api/v1/received` sees nothing for it — we
 * read them via the connected wallet's CIP-0103 `ledgerApi` instead. Accept
 * still uses the proxy to build the registry choice-context (whitelisted
 * egress), then the wallet signs and submits on its own participant.
 */
import { queryActiveContracts, submitAndWait } from './hostedWalletLedger.js';
import { accountParty } from './settleV1Wallet.js';
import type {
  CantonStreamsApi,
  SupportedAsset,
  V1ReceivedView,
  V1ReceivedPendingOffer,
  V1ReceivedAcceptResult,
} from '../api/client.js';

const AMULET_TRANSFER_INSTRUCTION_TID =
  '#splice-amulet:Splice.AmuletTransferInstruction:AmuletTransferInstruction';

/** Deep-search a wallet response for the first string value under any of `keys`,
 *  rejecting the known placeholders so we never treat a non-committed submit as
 *  real. */
function deepFind(res: unknown, keys: readonly string[], depth = 0): string | undefined {
  if (!res || typeof res !== 'object' || depth > 6) return undefined;
  const r = res as Record<string, unknown>;
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v && !v.startsWith('dashboard-') && v !== 'wallet-submitted') {
      return v;
    }
  }
  for (const nk of Object.keys(r)) {
    const f = deepFind(r[nk], keys, depth + 1);
    if (f) return f;
  }
  return undefined;
}

/** True when a wallet ACS read failed because the wallet's participant can't
 *  serve the query (DAR not vetted there, or the adapter can't do ACS reads) —
 *  as opposed to a genuine transport failure (network down, unauthorized). We
 *  degrade the former to an empty incoming list rather than a hard error, since
 *  the wallet's own balance view is the source of truth for delivered CC. */
function isWalletReadUnavailable(err: unknown): boolean {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : (() => {
            try {
              return JSON.stringify(err);
            } catch {
              return String(err);
            }
          })();
  return /Failed to get active contracts|getActiveContracts\(\) failed|PACKAGE_NAMES_NOT_FOUND|package.*not.*found|template.*not.*found|not.*deployed|no.*package|ledgerApi is not available/i.test(
    text,
  );
}

type WalletContract = Awaited<ReturnType<typeof queryActiveContracts>>[number];

type ReceivedInstrument = { readonly admin: string; readonly id: string };

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

function offerAssets(assets: readonly SupportedAsset[]): SupportedAsset[] {
  return assets.filter((a) => !!a.offerTemplateId);
}

async function readWalletOffers(
  templateIds: readonly string[],
  party: string,
): Promise<readonly WalletContract[] | undefined> {
  try {
    return await queryActiveContracts(templateIds, party);
  } catch (err) {
    if (isWalletReadUnavailable(err)) return undefined;
    throw err;
  }
}

function ccOffer(c: WalletContract, nowMs: number): V1ReceivedPendingOffer {
  const tr = (c.createArguments['transfer'] ?? {}) as Record<string, unknown>;
  const instr = tr['instrumentId'];
  const admin = asRecord(instr)?.['admin'];
  const executeBefore = (tr['executeBefore'] as string | undefined) ?? undefined;
  return {
    transferInstructionCid: c.contractId,
    amount: String(tr['amount'] ?? '0'),
    sender: String(tr['sender'] ?? ''),
    instrumentId:
      instr && typeof instr === 'object'
        ? String((instr as Record<string, unknown>)['id'] ?? 'Amulet')
        : String(instr ?? 'Amulet'),
    ...(typeof admin === 'string' && admin ? { instrumentAdmin: admin } : {}),
    requestedAt: (tr['requestedAt'] as string | undefined) ?? undefined,
    executeBefore,
    expired: !!executeBefore && Date.parse(executeBefore) < nowMs,
  };
}

function assetOffer(
  c: WalletContract,
  party: string,
  assets: readonly SupportedAsset[],
  nowMs: number,
): V1ReceivedPendingOffer | undefined {
  const tr = asRecord(c.createArguments['transfer']) ?? {};
  if (accountParty(tr['receiver']) !== party) return undefined;
  const instr = asRecord(tr['instrumentId']);
  const admin = instr?.['admin'];
  const id = instr?.['id'];
  if (typeof admin !== 'string' || typeof id !== 'string') return undefined;
  if (!assets.some((a) => a.instrumentAdmin === admin && a.instrumentId === id)) return undefined;
  const requestedAt = typeof tr['requestedAt'] === 'string' ? tr['requestedAt'] : undefined;
  const executeBefore = typeof tr['executeBefore'] === 'string' ? tr['executeBefore'] : undefined;
  return {
    transferInstructionCid: c.contractId,
    amount: String(tr['amount'] ?? '0'),
    sender: accountParty(tr['sender']),
    instrumentId: id,
    instrumentAdmin: admin,
    requestedAt,
    executeBefore,
    expired: !!executeBefore && Date.parse(executeBefore) < nowMs,
  };
}

/** Pending incoming offers for a wallet party, read from the wallet's own ACS. */
export async function listReceivedViaWallet(
  party: string,
  assets: readonly SupportedAsset[] = [],
): Promise<V1ReceivedView> {
  const nowMs = Date.now();
  const ccOffers = await readWalletOffers([AMULET_TRANSFER_INSTRUCTION_TID], party);
  const pending: V1ReceivedPendingOffer[] = (ccOffers ?? [])
    .filter((c) => ((c.createArguments['transfer'] ?? {}) as Record<string, unknown>)['receiver'] === party)
    .map((c) => ccOffer(c, nowMs));

  const configured = offerAssets(assets);
  const templateIds = [...new Set(configured.map((a) => a.offerTemplateId!))];
  const seen = new Set(pending.map((o) => o.transferInstructionCid));
  for (const templateId of templateIds) {
    const offers = await readWalletOffers([templateId], party);
    const forTemplate = configured.filter((a) => a.offerTemplateId === templateId);
    for (const c of offers ?? []) {
      if (seen.has(c.contractId)) continue;
      const offer = assetOffer(c, party, forTemplate, nowMs);
      if (!offer) continue;
      seen.add(c.contractId);
      pending.push(offer);
    }
  }
  // A wallet party's delivered-transfer history isn't exposed through the
  // CIP-0103 surface, so `received` is left to the wallet's own balance view;
  // the actionable incoming (pending offers) is what the Inbox surfaces here.
  return { party, pending, received: [] };
}

export function offerAcceptInstrument(
  offer: Pick<V1ReceivedPendingOffer, 'instrumentId' | 'instrumentAdmin'>,
  assets: readonly SupportedAsset[],
): ReceivedInstrument | undefined {
  const admin = offer.instrumentAdmin;
  if (!admin) return undefined;
  const asset = offerAssets(assets).find(
    (a) => a.instrumentAdmin === admin && a.instrumentId === offer.instrumentId,
  );
  return asset ? { admin, id: offer.instrumentId } : undefined;
}

/** Accept a pending incoming offer with the connected wallet: the proxy builds
 *  the TransferInstruction_Accept command + disclosures, the wallet signs and
 *  submits it. */
export async function acceptReceivedViaWallet(
  client: Pick<CantonStreamsApi, 'prepareAcceptReceivedV1'>,
  party: string,
  transferInstructionCid: string,
  instrument?: ReceivedInstrument,
): Promise<V1ReceivedAcceptResult> {
  const prepared = instrument
    ? await client.prepareAcceptReceivedV1(transferInstructionCid, instrument)
    : await client.prepareAcceptReceivedV1(transferInstructionCid);
  if (prepared.actAs !== party) {
    throw new Error(
      `Prepared accept must be signed by ${prepared.actAs}, but the connected wallet is ${party}.`,
    );
  }
  const res = await submitAndWait([prepared.command as Record<string, unknown>], party, {
    disclosedContracts: prepared.disclosedContracts as Record<string, unknown>[] | undefined,
  });
  const failure = deepFind(res, ['error_message', 'errorMessage']);
  if (failure) {
    throw new Error(`The wallet did not commit the acceptance: ${failure}. Nothing moved.`);
  }
  const updateId = deepFind(res, ['updateId', 'update_id', 'transactionId', 'transaction_id']);
  if (!updateId) {
    throw new Error(
      'The wallet returned no on-ledger transaction id for the acceptance. If the wallet popup ' +
        'did not approve the transfer, nothing moved.',
    );
  }
  return { updateId, amount: '0', sender: '' };
}
