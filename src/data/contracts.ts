export const MAINNET_CHAIN_ID = 1 as const;

export const CONTRACTS = {
  amplToken: {
    role: "ampl-token",
    address: "0xD46bA6D942050d489DBd938a2C909A5d5039A161",
    deploymentBlock: 7_953_823n,
  },
  amplPolicy: {
    role: "ampl-supply-policy",
    address: "0x1B228a749077b8e307C5856cE62Ef35d96Dca2ea",
    deploymentBlock: 7_953_832n,
  },
  spot: {
    role: "spot-token",
    address: "0xC1f33e0cf7e40a67375007104B929E49a581bafE",
    deploymentBlock: 15_597_008n,
  },
  rolloverVault: {
    role: "rollover-vault",
    address: "0x82A91a0D599A45d8E9Af781D67f695d7C72869Bd",
    deploymentBlock: 17_329_340n,
  },
  spotFeePolicy: {
    role: "spot-fee-policy",
    address: "0x8689Fa9991834Bcf0387b31b7986ac311bAb6ab5",
    deploymentBlock: 22_819_429n,
  },
  billBroker: {
    role: "bill-broker",
    address: "0xA088Aef966CAD7fE0B38e28c2E07590127Ab4ccB",
    deploymentBlock: 20_127_143n,
  },
  usdc: {
    role: "usdc-token",
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    deploymentBlock: null,
  },
} as const;

export type ContractName = keyof typeof CONTRACTS;

export const AMPL_POLICY_REBASE_EVENT = {
  type: "event",
  name: "LogRebase",
  inputs: [
    {
      indexed: true,
      name: "epoch",
      type: "uint256",
    },
    {
      indexed: false,
      name: "exchangeRate",
      type: "uint256",
    },
    {
      indexed: false,
      name: "cpi",
      type: "uint256",
    },
    {
      indexed: false,
      name: "requestedSupplyAdjustment",
      type: "int256",
    },
    {
      indexed: false,
      name: "timestampSec",
      type: "uint256",
    },
  ],
} as const;

export const AMPL_TOKEN_REBASE_EVENT = {
  type: "event",
  name: "LogRebase",
  inputs: [
    {
      indexed: true,
      name: "epoch",
      type: "uint256",
    },
    {
      indexed: false,
      name: "totalSupply",
      type: "uint256",
    },
  ],
} as const;

export const AMPL_POLICY_REBASE_V2_EVENT = {
  type: "event",
  name: "LogRebaseV2",
  inputs: [
    {
      indexed: true,
      name: "epoch",
      type: "uint256",
    },
    {
      indexed: false,
      name: "exchangeRate",
      type: "uint256",
    },
    {
      indexed: false,
      name: "targetRate",
      type: "uint256",
    },
    {
      indexed: false,
      name: "requestedSupplyAdjustment",
      type: "int256",
    },
  ],
} as const;

export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

export const ERC20_METADATA_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const SPOT_ABI = [
  ...ERC20_METADATA_ABI,
  {
    type: "function",
    name: "underlying",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getReserveCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getReserveAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getReserveTokenBalance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getReserveTokenValue",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTVL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ROLLOVER_VAULT_ABI = [
  ...ERC20_METADATA_ABI,
  {
    type: "function",
    name: "deviationRatio",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getTVL",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "underlying",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "assetCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "assetAt",
    stateMutability: "view",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "vaultAssetBalance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getVaultAssetValue",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const TRANCHE_ABI = [
  {
    type: "function",
    name: "bond",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export const BOND_ABI = [
  {
    type: "function",
    name: "maturityDate",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const RESERVE_STATE_COMPONENTS = [
  { name: "usdBalance", type: "uint256" },
  { name: "perpBalance", type: "uint256" },
  { name: "usdPrice", type: "uint256" },
  { name: "perpPrice", type: "uint256" },
] as const;

const RANGE_COMPONENTS = [
  { name: "lower", type: "uint256" },
  { name: "upper", type: "uint256" },
] as const;

export const BILL_BROKER_ABI = [
  {
    type: "function",
    name: "usd",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "perp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "ONE",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "reserveState",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [
      {
        name: "state",
        type: "tuple",
        components: RESERVE_STATE_COMPONENTS,
      },
    ],
  },
  {
    type: "function",
    name: "assetRatio",
    stateMutability: "view",
    inputs: [
      {
        name: "state",
        type: "tuple",
        components: RESERVE_STATE_COMPONENTS,
      },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "arSoftBound",
    stateMutability: "view",
    inputs: [],
    outputs: RANGE_COMPONENTS,
  },
  {
    type: "function",
    name: "arHardBound",
    stateMutability: "view",
    inputs: [],
    outputs: RANGE_COMPONENTS,
  },
  {
    type: "function",
    name: "fees",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "mintFeePerc", type: "uint256" },
      { name: "burnFeePerc", type: "uint256" },
      {
        name: "perpToUSDSwapFeeFactors",
        type: "tuple",
        components: RANGE_COMPONENTS,
      },
      {
        name: "usdToPerpSwapFeeFactors",
        type: "tuple",
        components: RANGE_COMPONENTS,
      },
      { name: "protocolSwapSharePerc", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "computeUSDToPerpSwapAmt",
    stateMutability: "view",
    inputs: [
      { name: "usdAmountIn", type: "uint256" },
      {
        name: "state",
        type: "tuple",
        components: RESERVE_STATE_COMPONENTS,
      },
    ],
    outputs: [
      { name: "perpAmountOut", type: "uint256" },
      { name: "protocolFeePerpAmount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "computePerpToUSDSwapAmt",
    stateMutability: "view",
    inputs: [
      { name: "perpAmountIn", type: "uint256" },
      {
        name: "state",
        type: "tuple",
        components: RESERVE_STATE_COMPONENTS,
      },
    ],
    outputs: [
      { name: "usdAmountOut", type: "uint256" },
      { name: "protocolFeeUsdAmount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "computeRedemptionAmts",
    stateMutability: "view",
    inputs: [{ name: "burnAmt", type: "uint256" }],
    outputs: [
      { name: "usdAmtOut", type: "uint256" },
      { name: "perpAmtOut", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const ARCHIVE_CALL_ABI = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;
