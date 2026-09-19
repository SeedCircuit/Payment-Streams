import { useState, type CSSProperties, type FormEvent } from 'react';
import Decimal from 'decimal.js';
import { GitBranch, WalletCards } from 'lucide-react';
import type { DistributionAccount, DistributionRecord } from '../api/client.js';
import {
  useAuthorizeDistributionReceipt,
  useDistributions,
  useFundDistribution,
} from '../hooks/useDistributions.js';
import { useAuth } from '../store/auth.js';
import { displayName, fmtAmount, instrumentLabel } from '../lib/format.js';
import { ErrorState, Modal, PageHeader, Skeleton } from '../components/common/index.js';
import { StatusBadge } from '../components/primitives/StatusBadge.js';

const inputStyle: CSSProperties = {
  width: '100%',
  background: 'var(--bg-elev)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  padding: '9px 11px',
  fontSize: 13,
  color: 'var(--fg)',
  outline: 'none',
};

function statusLabel(status: DistributionRecord['status']): string {
  if (status === 'DistributionActive') return 'Active';
  if (status === 'DistributionPaused') return 'Paused';
  if (status === 'DistributionCompleted') return 'Completed';
  if (status === 'DistributionCancelled') return 'Cancelled';
  return 'Pending';
}

function cadence(seconds: number): string {
  if (seconds === 86_400) return 'Daily';
  if (seconds === 3_600) return 'Hourly';
  if (seconds === 60) return 'Every minute';
  return `Every ${seconds.toLocaleString()} seconds`;
}

function ruleLabel(record: DistributionRecord, index: number): string {
  const rule = record.legs[index]!.rule;
  return rule.type === 'percentage'
    ? `${(rule.basisPoints / 100).toFixed(2).replace(/\.00$/, '')}%`
    : `${fmtAmount(rule.amountPerPeriod)} / period`;
}

function sameAccount(left: DistributionAccount, right: DistributionAccount): boolean {
  return (
    left.owner === right.owner &&
    (left.provider ?? undefined) === (right.provider ?? undefined) &&
    left.id === right.id
  );
}

function accountKey(account: DistributionAccount): string {
  return `${account.owner}|${account.provider ?? ''}|${account.id}`;
}

function toLocalDateTimeInput(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function suggestedFundingDeadline(record: DistributionRecord, periods: number): string {
  const periodAmount = new Decimal(record.grossAmountPerPeriod);
  const previouslyFundedPeriods = new Decimal(record.totalFunded)
    .div(periodAmount)
    .ceil()
    .toNumber();
  const lastDueAt =
    new Date(record.startTime).getTime() +
    (previouslyFundedPeriods + periods) * record.periodSeconds * 1000;
  const fiveMinutes = 5 * 60 * 1000;
  return toLocalDateTimeInput(
    new Date(Math.max(Date.now() + fiveMinutes, lastDueAt + fiveMinutes)),
  );
}

export function DistributionsPage() {
  const { party } = useAuth();
  const distributions = useDistributions();
  const fund = useFundDistribution();
  const authorizeReceipt = useAuthorizeDistributionReceipt();
  const [selected, setSelected] = useState<DistributionRecord | null>(null);
  const [periods, setPeriods] = useState('30');
  const [deadline, setDeadline] = useState('');
  const [submissionMessage, setSubmissionMessage] = useState<string | null>(null);
  const [authorizationResult, setAuthorizationResult] = useState<{
    recordId: string;
    accountKey: string;
    message: string;
  } | null>(null);

  const openFunding = (record: DistributionRecord) => {
    setSelected(record);
    setPeriods('30');
    setDeadline(suggestedFundingDeadline(record, 30));
    setSubmissionMessage(null);
    fund.reset();
  };

  const submitFunding = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected || !party) return;
    try {
      const result = await fund.mutateAsync({
        record: selected,
        payerParty: party,
        periods: Number(periods),
        settlementDeadline: new Date(deadline),
      });
      setSubmissionMessage(
        result.confirmation === 'confirmed'
          ? 'Wallet funding committed. The operator will reconcile it, then each destination authorizes receipt before activation.'
          : 'The wallet accepted the command but did not return a ledger update id. Do not retry blindly; wait for operator reconciliation.',
      );
    } catch {}
  };

  const authorizeReceiver = async (
    record: DistributionRecord,
    receiverAccount: DistributionAccount,
  ) => {
    if (!party) return;
    setAuthorizationResult(null);
    try {
      const result = await authorizeReceipt.mutateAsync({
        record,
        receiverParty: party,
        receiverAccount,
      });
      setAuthorizationResult({
        recordId: record.contractId,
        accountKey: accountKey(receiverAccount),
        message:
          result.confirmation === 'confirmed'
            ? 'Wallet authorization submitted. The operator will verify the receiver allocation and activate after every destination is ready.'
            : 'The wallet accepted the authorization without an update id. Do not retry blindly; wait for operator reconciliation.',
      });
    } catch {}
  };

  const records = distributions.data ?? [];

  return (
    <div style={{ paddingTop: 28 }}>
      <PageHeader
        title="Distribution streams"
        subtitle="Split one recurring payment across multiple token-standard destinations"
      />

      <div
        className="card"
        style={{
          padding: 20,
          marginBottom: 22,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: 14,
          background:
            'linear-gradient(120deg, color-mix(in oklab, var(--accent) 10%, var(--card)), var(--card) 55%)',
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 12,
            display: 'grid',
            placeItems: 'center',
            color: 'var(--accent)',
            background: 'var(--accent-soft)',
          }}
        >
          <GitBranch size={19} />
        </div>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>
            Configure any percentage or fixed-amount split.
          </div>
          <p style={{ margin: '5px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--fg-3)' }}>
            The payer signs a standard SenderSide allocation and each destination signs a standard
            ReceiverSide allocation. The operator record tracks schedule and reconciliation only; it
            does not custody tokens and wallet participants do not need the Streams DAR.
          </p>
        </div>
      </div>

      {distributions.isPending && <Skeleton.Row count={3} height={150} />}
      {distributions.isError && (
        <ErrorState
          error={distributions.error}
          title="Could not load distribution streams"
          onRetry={() => distributions.refetch()}
        />
      )}
      {!distributions.isPending && !distributions.isError && records.length === 0 && (
        <div className="card" style={{ padding: 42, textAlign: 'center' }}>
          <GitBranch size={28} style={{ margin: '0 auto 10px', color: 'var(--fg-5)' }} />
          <div style={{ fontSize: 13.5, color: 'var(--fg)' }}>No assigned distributions yet</div>
          <p style={{ margin: '6px auto 0', maxWidth: 500, fontSize: 12.5, color: 'var(--fg-3)' }}>
            An integrating application creates the schedule. It appears here for the payer and every
            destination before wallet funding begins.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 14 }}>
        {records.map((record) => {
          const isPayer = record.payerAccount.owner === party;
          const available = new Decimal(record.totalFunded).minus(record.totalGrossSettled);
          const closed =
            record.status === 'DistributionCompleted' || record.status === 'DistributionCancelled';
          const canFund = isPayer && !closed && available.eq(0) && !record.currentAllocationCid;
          const receiverAccounts = record.legs.reduce<DistributionAccount[]>((accounts, leg) => {
            if (
              leg.receiver.owner === party &&
              !accounts.some((account) => sameAccount(account, leg.receiver))
            ) {
              accounts.push(leg.receiver);
            }
            return accounts;
          }, []);
          const accountsAwaitingAuthorization =
            record.status === 'AwaitingRecipients'
              ? receiverAccounts.filter(
                  (account) =>
                    !record.recipientAuthorizations.some((authorization) =>
                      sameAccount(authorization.receiver, account),
                    ),
                )
              : [];
          return (
            <article key={record.contractId} className="card" style={{ padding: 20 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>
                    {record.streamId}
                  </div>
                  <div style={{ marginTop: 5, fontSize: 11.5, color: 'var(--fg-4)' }}>
                    {isPayer
                      ? 'You fund this distribution'
                      : `Funded by ${displayName(record.payerAccount.owner)}`}
                    {' · '}
                    {cadence(record.periodSeconds)}
                  </div>
                </div>
                <StatusBadge status={statusLabel(record.status)} />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 10,
                  margin: '18px 0',
                }}
              >
                <Metric
                  label="Gross / period"
                  value={`${fmtAmount(record.grossAmountPerPeriod)} ${instrumentLabel(record.instrumentId.id)}`}
                />
                <Metric
                  label="Available"
                  value={`${available.toFixed(4).replace(/\.?0+$/, '')} ${instrumentLabel(record.instrumentId.id)}`}
                />
                <Metric label="Settlements" value={String(record.settlementCount)} />
              </div>

              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    color: 'var(--fg-4)',
                    marginBottom: 9,
                  }}
                >
                  Destinations
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {record.legs.map((leg, index) => (
                    <div
                      key={leg.legId}
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: 999,
                        padding: '6px 10px',
                        fontSize: 11.5,
                        color: leg.receiver.owner === party ? 'var(--accent)' : 'var(--fg-2)',
                        background:
                          leg.receiver.owner === party ? 'var(--accent-soft)' : 'var(--card-2)',
                      }}
                      title={leg.receiver.owner}
                    >
                      {displayName(leg.receiver.owner)} · {ruleLabel(record, index)}
                    </div>
                  ))}
                </div>
              </div>

              {canFund && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={() => openFunding(record)}>
                    <WalletCards size={14} /> Fund with wallet
                  </button>
                </div>
              )}
              {isPayer && !closed && !canFund && (
                <p
                  style={{
                    margin: '14px 0 0',
                    textAlign: 'right',
                    fontSize: 11.5,
                    color: 'var(--fg-4)',
                  }}
                >
                  The current wallet-approved runway must finish before another allocation is
                  funded.
                </p>
              )}
              {accountsAwaitingAuthorization.map((account) => (
                <div
                  key={accountKey(account)}
                  style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}
                >
                  <button
                    className="btn btn-primary"
                    disabled={authorizeReceipt.isPending}
                    onClick={() => void authorizeReceiver(record, account)}
                  >
                    <WalletCards size={14} />
                    {authorizeReceipt.isPending ? 'Waiting for wallet…' : 'Authorize receipt'}
                  </button>
                </div>
              ))}
              {authorizationResult?.recordId === record.contractId && (
                <p style={{ margin: '12px 0 0', color: 'var(--accent)', fontSize: 12 }}>
                  {authorizationResult.message}
                </p>
              )}
              {authorizeReceipt.isError && accountsAwaitingAuthorization.length > 0 && (
                <p style={{ margin: '12px 0 0', color: 'var(--danger)', fontSize: 12 }}>
                  {(authorizeReceipt.error as Error).message}
                </p>
              )}
            </article>
          );
        })}
      </div>

      <Modal
        open={selected !== null}
        onClose={() => !fund.isPending && setSelected(null)}
        title="Fund distribution"
        subtitle={selected ? `${selected.streamId} · wallet-signed V2 allocation` : undefined}
        closeOnBackdrop={!fund.isPending}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              className="btn btn-secondary"
              onClick={() => setSelected(null)}
              disabled={fund.isPending}
            >
              Close
            </button>
            {!submissionMessage && (
              <button
                className="btn btn-primary"
                type="submit"
                form="distribution-funding-form"
                disabled={fund.isPending}
              >
                {fund.isPending ? 'Waiting for wallet…' : 'Review in wallet'}
              </button>
            )}
          </div>
        }
      >
        <form id="distribution-funding-form" onSubmit={submitFunding}>
          <label style={labelStyle}>
            Periods to fund
            <input
              style={inputStyle}
              type="number"
              min={1}
              step={1}
              value={periods}
              onChange={(event) => {
                const nextPeriods = Number(event.target.value);
                setPeriods(event.target.value);
                if (selected && Number.isSafeInteger(nextPeriods) && nextPeriods > 0) {
                  setDeadline(suggestedFundingDeadline(selected, nextPeriods));
                }
              }}
              required
            />
          </label>
          <label style={labelStyle}>
            Settlement deadline
            <input
              style={inputStyle}
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
              required
            />
          </label>
          {selected && periods && Number(periods) > 0 && (
            <div
              style={{
                marginTop: 14,
                padding: 12,
                borderRadius: 10,
                background: 'var(--card-2)',
                fontSize: 12,
                color: 'var(--fg-3)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  marginBottom: 9,
                  color: 'var(--fg-2)',
                }}
              >
                <span>Total wallet commitment</span>
                <span className="mono">
                  {new Decimal(selected.grossAmountPerPeriod).times(Number(periods)).toFixed(4)}{' '}
                  {instrumentLabel(selected.instrumentId.id)}
                </span>
              </div>
              <div
                style={{
                  marginBottom: 9,
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-4)',
                }}
              >
                Released each period
              </div>
              {selected.legs.map((leg, index) => {
                const rule = leg.rule;
                const legAmount =
                  rule.type === 'percentage'
                    ? new Decimal(selected.grossAmountPerPeriod).times(rule.basisPoints).div(10_000)
                    : new Decimal(rule.amountPerPeriod);
                return (
                  <div
                    key={leg.legId}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      marginTop: index ? 7 : 0,
                    }}
                  >
                    <span>{displayName(leg.receiver.owner)}</span>
                    <span className="mono">
                      {legAmount.toFixed(4)} {instrumentLabel(selected.instrumentId.id)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {fund.isError && (
            <p style={{ margin: '12px 0 0', color: 'var(--danger)', fontSize: 12 }}>
              {(fund.error as Error).message}
            </p>
          )}
          {submissionMessage && (
            <p
              style={{ margin: '12px 0 0', color: 'var(--accent)', fontSize: 12, lineHeight: 1.5 }}
            >
              {submissionMessage}
            </p>
          )}
        </form>
      </Modal>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={{ padding: 11, borderRadius: 10, background: 'var(--card-2)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--fg-4)', marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, color: 'var(--fg)' }}>
        {value}
      </div>
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  marginBottom: 13,
  fontSize: 12,
  color: 'var(--fg-2)',
};
