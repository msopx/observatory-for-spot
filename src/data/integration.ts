// SPDX-License-Identifier: GPL-3.0-or-later
// Protocol provenance and any upstream licence conditions that apply to this
// module: THIRD-PARTY-NOTICES.txt, section PROTOCOL PROVENANCE.
// The legacy CPI-adjusted target-rate derivation below (LEGACY_BASE_CPI and
// legacyCpiAdjustedTargetRate) was written in 2026 for Observatory for SPOT
// with reference to contracts/UFragmentsPolicy.sol in
// fragmentsorg/ampleforth-contracts at commit
// 936b2d7faaa1c154e4b7b7fcd8c3d99496dbcac8 (GPL-3.0-or-later); it is not a
// copy of that file. Should any portion be held to derive from it, this file
// is a modification of it made in 2026 by the Observatory for SPOT
// contributors. Later policy versions emit the target rate in their rebase
// event; the collector records that emitted value and does not compute it.
import {
  UnsupportedProtocolIntegrationError,
  type AmplTargetRateResolver,
  type ProtocolImplementationVerifier,
} from "./refresh";
import { WAD, assertUint256, mulDivDown } from "../protocol/fixed-point";
import {
  MAINNET_DEPLOYMENTS,
  assertSupportedImplementation,
} from "../protocol/deployments";

/**
 * Base CPI value the legacy mainnet supply policy was initialised with. Legacy
 * rebase events report the CPI oracle value but not the target rate derived
 * from it, so the collector derives the historical target for those epochs.
 */
export const LEGACY_BASE_CPI = 109_195_000_000_000_007_392n;

/** floor(cpiOracleValue * 10^18 / LEGACY_BASE_CPI), as the legacy policy did. */
export function legacyCpiAdjustedTargetRate(cpiOracleValue: bigint): bigint {
  return mulDivDown(
    assertUint256(cpiOracleValue, "cpiOracleValue"),
    WAD,
    LEGACY_BASE_CPI,
  );
}

export const mainnetTargetRateResolver: AmplTargetRateResolver = {
  async resolveCpiAdjustedTargetRate({ cpiOracleValue }) {
    return legacyCpiAdjustedTargetRate(cpiOracleValue);
  },
};

export const mainnetImplementationVerifier: ProtocolImplementationVerifier = {
  verifyImplementation(input) {
    try {
      const epoch = assertSupportedImplementation(
        MAINNET_DEPLOYMENTS[input.contract],
        input.blockNumber,
        input.implementationAddress,
        input.runtimeCodeHash,
      );
      const expectedInterface = {
        billBroker: "bill-broker-v5-factor",
        feePolicy: "fee-policy-v5",
        rolloverVault: "rollover-vault-v5",
        spot: "spot-v5",
      }[input.contract];
      if (epoch.interfaceVersion !== expectedInterface) {
        throw new Error("unsupported interface version");
      }
    } catch {
      throw new UnsupportedProtocolIntegrationError(
        `${input.contract} implementation identity is unsupported at the release block.`,
      );
    }
  },
};
