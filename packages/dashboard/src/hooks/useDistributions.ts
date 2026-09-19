import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DistributionRecord, DistributionStatus } from '../api/client.js';
import {
  authorizeDistributionReceiptWithWallet,
  fundDistributionWithWallet,
} from '../lib/distributionWallet.js';
import { useCantonClient } from './useCantonClient.js';

export function useDistributions(filter?: { streamId?: string; status?: DistributionStatus }) {
  const client = useCantonClient();
  return useQuery({
    queryKey: ['distributions', filter],
    queryFn: () => client!.listDistributions(filter),
    enabled: !!client,
    refetchInterval: 15_000,
  });
}

export function useFundDistribution() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      record: DistributionRecord;
      payerParty: string;
      periods: number;
      settlementDeadline: Date;
      holdingTemplateId?: string;
    }) => fundDistributionWithWallet(client!, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['distributions'] });
    },
  });
}

export function useAuthorizeDistributionReceipt() {
  const client = useCantonClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      record: DistributionRecord;
      receiverParty: string;
      receiverAccount: DistributionRecord['legs'][number]['receiver'];
    }) => authorizeDistributionReceiptWithWallet(client!, params),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['distributions'] });
    },
  });
}
