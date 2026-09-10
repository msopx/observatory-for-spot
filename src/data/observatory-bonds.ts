import { keccak256 } from "viem";

import type { ObservatoryPublicClient } from "./refresh";

/**
 * Runtime bytecode was independently matched to the explorer's deployed
 * bytecode and to Ethereum at block 25853823. Targets are listed in the
 * official Buttonwood Ethereum deployments:
 * https://docs.prl.one/buttonwood/developers/deployed-contracts/ethereum-mainnet
 */
export const SUPPORTED_BUTTONWOOD_RUNTIMES = {
  bond: {
    address: "0x8c624d6a336ede5da3bda01574cf091a938ea906",
    codeHash:
      "0x5421ecbe8ea0a6d97526b3690cb91161fcb84011343ef036238768c39539de2c",
  },
  tranche: {
    address: "0xa07df4a1721bf151104234a8b73b93e5e371f7e8",
    codeHash:
      "0xcf8328abd8e61f107f4bd0f70089cb5e9add8305070008a262173bfc13f79b52",
  },
} as const;

export function minimalProxyTarget(runtime: string): `0x${string}` | null {
  const match =
    /^0x363d3d373d3d3d363d73([a-fA-F0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(
      runtime,
    );
  return match === null ? null : `0x${match[1]!.toLowerCase()}`;
}

export async function verifySupportedBondRuntime(options: {
  client: ObservatoryPublicClient;
  address: `0x${string}`;
  runtime: `0x${string}`;
  blockNumber: bigint;
  trancheTokens: readonly `0x${string}`[];
}): Promise<boolean> {
  if (
    minimalProxyTarget(options.runtime) !==
    SUPPORTED_BUTTONWOOD_RUNTIMES.bond.address
  )
    return false;
  const [bondCode, trancheCode] = await Promise.all([
    options.client.getCode({
      address: SUPPORTED_BUTTONWOOD_RUNTIMES.bond.address,
      blockNumber: options.blockNumber,
    }),
    options.client.getCode({
      address: SUPPORTED_BUTTONWOOD_RUNTIMES.tranche.address,
      blockNumber: options.blockNumber,
    }),
  ]);
  if (
    bondCode === undefined ||
    trancheCode === undefined ||
    keccak256(bondCode) !== SUPPORTED_BUTTONWOOD_RUNTIMES.bond.codeHash ||
    keccak256(trancheCode) !== SUPPORTED_BUTTONWOOD_RUNTIMES.tranche.codeHash
  )
    return false;
  for (const token of new Set(options.trancheTokens)) {
    const runtime = await options.client.getCode({
      address: token,
      blockNumber: options.blockNumber,
    });
    if (
      runtime === undefined ||
      minimalProxyTarget(runtime) !==
        SUPPORTED_BUTTONWOOD_RUNTIMES.tranche.address
    )
      return false;
  }
  return options.trancheTokens.length > 0;
}
