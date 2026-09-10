import type { Address, Hex } from "viem";

export type ProxyKind = "eip1967-transparent";

export interface ImplementationEpoch {
  /** First block assigned to this implementation epoch. */
  readonly fromBlock: bigint;
  /** Null means that the epoch is open-ended. */
  readonly toBlockExclusive: bigint | null;
  /** Null identifies an unsupported implementation. */
  readonly implementationAddress: Address | null;
  /** keccak256 of deployed runtime bytecode; null is unsupported. */
  readonly runtimeCodeHash: Hex | null;
  readonly interfaceVersion: string;
  readonly note: string;
}

export interface ContractDeployment {
  readonly key: DeploymentKey;
  readonly label: string;
  readonly chainId: bigint;
  readonly address: Address;
  readonly proxyKind: ProxyKind;
  readonly implementationEpochs: readonly ImplementationEpoch[];
}

export type DeploymentKey =
  | "spot"
  | "rolloverVault"
  | "feePolicy"
  | "billBroker";

const CHAIN_ID_MAINNET = 1n;

/**
 * Mainnet addresses are protocol identifiers. Null implementation fields are
 * unsupported and verification rejects them.
 */
export const MAINNET_DEPLOYMENTS: Readonly<
  Record<DeploymentKey, ContractDeployment>
> = {
  spot: {
    key: "spot",
    label: "SPOT",
    chainId: CHAIN_ID_MAINNET,
    address: "0xC1f33e0cf7e40a67375007104B929E49a581bafE",
    proxyKind: "eip1967-transparent",
    implementationEpochs: [
      {
        fromBlock: 0n,
        toBlockExclusive: 22_825_563n,
        implementationAddress: null,
        runtimeCodeHash: null,
        interfaceVersion: "spot-pre-v5",
        note: "Pre-v5 implementations are unsupported.",
      },
      {
        fromBlock: 22_825_563n,
        toBlockExclusive: null,
        implementationAddress: "0x62cbE9F24413485F04fa62f9548c7855EC4a5425",
        runtimeCodeHash:
          "0x6cb8f96f3878298f9b3764f42456f46bb3e023ead2d27bde22cfa031de91ec46",
        interfaceVersion: "spot-v5",
        note:
          "Runtime identity cross-checked at release block 25853823 using independent RPC providers.",
      },
    ],
  },
  rolloverVault: {
    key: "rolloverVault",
    label: "stAMPL / RolloverVault",
    chainId: CHAIN_ID_MAINNET,
    address: "0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd",
    proxyKind: "eip1967-transparent",
    implementationEpochs: [
      {
        fromBlock: 0n,
        toBlockExclusive: 22_825_563n,
        implementationAddress: null,
        runtimeCodeHash: null,
        interfaceVersion: "rollover-vault-pre-v5",
        note: "Pre-v5 implementations are unsupported.",
      },
      {
        fromBlock: 22_825_563n,
        toBlockExclusive: null,
        implementationAddress: "0x09e8adFa8d829DaC1c305544A86B53eD0DDd536A",
        runtimeCodeHash:
          "0x1c7a73cb4b4339dff45795ba8bdc5f13bbb9f3efdf389c915a6a49a71a6a2669",
        interfaceVersion: "rollover-vault-v5",
        note:
          "Runtime identity cross-checked at release block 25853823 using independent RPC providers.",
      },
    ],
  },
  feePolicy: {
    key: "feePolicy",
    label: "SPOT FeePolicy",
    chainId: CHAIN_ID_MAINNET,
    address: "0x8689Fa9991834Bcf0387b31b7986ac311bAb6ab5",
    proxyKind: "eip1967-transparent",
    implementationEpochs: [
      {
        fromBlock: 0n,
        toBlockExclusive: 22_819_429n,
        implementationAddress: null,
        runtimeCodeHash: null,
        interfaceVersion: "fee-policy-pre-v5",
        note: "Pre-v5 implementation epochs are unsupported.",
      },
      {
        fromBlock: 22_819_429n,
        toBlockExclusive: null,
        implementationAddress: "0x03Cb728991DEb43A55D475885Ff07a694bF1cc6B",
        runtimeCodeHash:
          "0x40be873184040ad1918de36921f3e1b2921592303d5e2a933da12c3459c2149b",
        interfaceVersion: "fee-policy-v5",
        note:
          "Runtime identity cross-checked at release block 25853823 using independent RPC providers.",
      },
    ],
  },
  billBroker: {
    key: "billBroker",
    label: "Bill Broker",
    chainId: CHAIN_ID_MAINNET,
    address: "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB",
    proxyKind: "eip1967-transparent",
    implementationEpochs: [
      {
        fromBlock: 20_127_143n,
        toBlockExclusive: 21_130_761n,
        implementationAddress: "0x6ca2E2B0F2e1964BBCceDE5b2Dd37AE25966662F",
        runtimeCodeHash: null,
        interfaceVersion: "bill-broker-v4",
        note: "Initial percentage-fee runtime identity is unsupported.",
      },
      {
        fromBlock: 21_130_761n,
        toBlockExclusive: 22_889_951n,
        implementationAddress: "0x0CE64cD7583864f7005898Aa133C74DBccaca063",
        runtimeCodeHash: null,
        interfaceVersion: "bill-broker-v4.1",
        note: "The v4.1 percentage-fee runtime identity is unsupported.",
      },
      {
        fromBlock: 22_889_951n,
        toBlockExclusive: null,
        implementationAddress: "0x9Ce5056eEEd22e4569a39DAa670bacD277df3ef1",
        runtimeCodeHash:
          "0x2005b63859f224931e9336ab2fb012c7edc4304deaa0c9d5bb59378ae63dfb3e",
        interfaceVersion: "bill-broker-v5-factor",
        note:
          "Runtime identity cross-checked at release block 25853823 using independent RPC providers.",
      },
    ],
  },
};

export const mainnetDeployments = MAINNET_DEPLOYMENTS;

export class UnknownImplementationEpochError extends Error {
  constructor(deploymentKey: DeploymentKey, blockNumber: bigint) {
    super(
      `no implementation epoch is registered for ${deploymentKey} at block ${blockNumber}`,
    );
    this.name = "UnknownImplementationEpochError";
  }
}

export class UnsupportedImplementationError extends Error {
  constructor(deploymentKey: DeploymentKey, epoch: ImplementationEpoch) {
    super(
      `${deploymentKey} implementation ${epoch.interfaceVersion} is unsupported`,
    );
    this.name = "UnsupportedImplementationError";
  }
}

export class ImplementationMismatchError extends Error {
  constructor(deploymentKey: DeploymentKey, field: "address" | "runtime code hash") {
    super(`${deploymentKey} implementation ${field} does not match the registered epoch`);
    this.name = "ImplementationMismatchError";
  }
}

export function getImplementationEpochAtBlock(
  deployment: ContractDeployment,
  blockNumber: bigint,
): ImplementationEpoch {
  if (blockNumber < 0n) {
    throw new RangeError("blockNumber must not be negative");
  }

  const epoch = deployment.implementationEpochs.find(
    (candidate) =>
      blockNumber >= candidate.fromBlock &&
      (candidate.toBlockExclusive === null ||
        blockNumber < candidate.toBlockExclusive),
  );
  if (epoch === undefined) {
    throw new UnknownImplementationEpochError(deployment.key, blockNumber);
  }
  return epoch;
}

/**
 * Fail-closed proxy verification. An unresolved/null field always rejects;
 * callers may not use an address match as a substitute for a code-hash match.
 */
export function assertSupportedImplementation(
  deployment: ContractDeployment,
  blockNumber: bigint,
  observedImplementationAddress: Address,
  observedRuntimeCodeHash: Hex,
): ImplementationEpoch {
  const epoch = getImplementationEpochAtBlock(deployment, blockNumber);
  if (
    epoch.implementationAddress === null ||
    epoch.runtimeCodeHash === null
  ) {
    throw new UnsupportedImplementationError(deployment.key, epoch);
  }
  if (
    epoch.implementationAddress.toLowerCase() !==
    observedImplementationAddress.toLowerCase()
  ) {
    throw new ImplementationMismatchError(deployment.key, "address");
  }
  if (
    epoch.runtimeCodeHash.toLowerCase() !==
    observedRuntimeCodeHash.toLowerCase()
  ) {
    throw new ImplementationMismatchError(deployment.key, "runtime code hash");
  }
  return epoch;
}

