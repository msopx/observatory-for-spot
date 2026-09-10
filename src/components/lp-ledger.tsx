"use client";

import { useMemo, useState } from "react";
import { reconcileLpLedger } from "../analytics/lp";
import {
  createScenarioReport,
  serializeScenarioReport,
} from "../analytics/scenarios";
import type {
  BrokerHistoryPoint,
  BrokerLedger,
} from "../data/observatory-schemas";
import { downloadFile, token } from "../lib/display";
import { lpScenarioProvenance, selectedBrokerLedger } from "./lp-model";

export function LpLedgerResults({
  result,
  lpDecimals,
}: {
  result: ReturnType<typeof reconcileLpLedger>;
  lpDecimals: number | null;
}) {
  return (
    <>
      <div
        className={`status ${result.status === "reconciled" ? "" : "warning"}`}
      >
        <span className="dot" />
        {result.status === "reconciled"
          ? "Reserve balances and LP supply reconcile"
          : "Balances do not fully reconcile"}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pool-level accounting</th>
              <th>USDC</th>
              <th>SPOT</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Positive swap fees</td>
              <td>{token(result.fees.usdc.positiveFees, 6, 6)}</td>
              <td>{token(result.fees.spot.positiveFees, 9, 9)}</td>
            </tr>
            <tr>
              <td>Rebates paid out</td>
              <td>{token(result.fees.usdc.rebates, 6, 6)}</td>
              <td>{token(result.fees.spot.rebates, 9, 9)}</td>
            </tr>
            <tr>
              <td>Protocol share</td>
              <td>{token(result.fees.usdc.protocolFees, 6, 6)}</td>
              <td>{token(result.fees.spot.protocolFees, 9, 9)}</td>
            </tr>
            <tr>
              <td>Net retained swap fees</td>
              <td>{token(result.fees.usdc.retainedNetFees, 6, 6)}</td>
              <td>{token(result.fees.spot.retainedNetFees, 9, 9)}</td>
            </tr>
            <tr>
              <td>Unexplained balance change</td>
              <td>{token(result.residual.usdc, 6, 6)}</td>
              <td>{token(result.residual.spot, 9, 9)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        className={
          result.feeAttribution === "complete"
            ? "muted small"
            : "warning-text small"
        }
      >
        {result.feeAttribution === "complete"
          ? "Fee attribution covers the indexed swaps in this interval."
          : "Partial fee attribution: the totals include only swaps with transaction-level fee data. Missing fee data is not assumed to be zero."}
      </p>
      <p className="muted small">
        LP supply residual:{" "}
        {lpDecimals === null
          ? `${result.residual.lpSupply.toString()} base units`
          : `${token(result.residual.lpSupply, lpDecimals, 9)} notes`}
        . Totals describe the whole pool, not your note position. Transaction
        transfers already include fees; they are counted once in the reserve
        reconciliation.
      </p>
    </>
  );
}

export function LpLedgerPanel({
  ledger,
  start,
  end,
  sourceHash,
  eventCount,
}: {
  ledger: BrokerLedger | null | undefined;
  start: BrokerHistoryPoint;
  end: BrokerHistoryPoint;
  sourceHash: string | null;
  eventCount: number;
}) {
  const [message, setMessage] = useState("");
  const reconciliation = useMemo(() => {
    if (!ledger) return null;
    try {
      return { value: selectedBrokerLedger(ledger, start, end), error: null };
    } catch (error) {
      return {
        value: null,
        error:
          error instanceof Error
            ? error.message
            : "Ledger could not be reconciled.",
      };
    }
  }, [ledger, start, end]);
  return (
    <section className="card section">
      <div className="section-title">
        <h2>Fees, rebates and balances</h2>
        <span className="badge">{eventCount} indexed Broker events</span>
      </div>
      {reconciliation?.value ? (
        <>
          <LpLedgerResults
            result={reconciliation.value.result}
            lpDecimals={Number(start.lpDecimals)}
          />
          <div className="button-row">
            <button
              className="secondary"
              disabled={!sourceHash}
              onClick={async () => {
                if (!sourceHash || !reconciliation.value) return;
                try {
                  const report = await createScenarioReport({
                    modelVersion: "broker-balance-ledger-v1",
                    provenance: lpScenarioProvenance(start, end, sourceHash),
                    assumptions: [
                      "Pool-level transfers cover the open-start, closed-end block interval.",
                      "Reserve changes already include protocol transfers; fee attribution is not added twice.",
                      "A null fee is unknown, never zero. Pool-level fees are not individual LP returns.",
                    ],
                    inputs: reconciliation.value.inputs,
                    expectedOutputs: reconciliation.value.result,
                  });
                  downloadFile(
                    "observatory-lp-ledger.json",
                    serializeScenarioReport(report),
                  );
                  setMessage(
                    "Reconciliation inputs and results exported.",
                  );
                } catch {
                  setMessage(
                    "The reconciliation report could not be exported.",
                  );
                }
              }}
            >
              Export reconciliation report
            </button>
          </div>
          {message && (
            <p className="muted small" role="status">
              {message}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            Endpoint performance is calculable. A complete balance ledger is
            needed to separate fee income, rebates and protocol fees from other
            changes in reserve ownership.
          </p>
          <p className="warning-text small">
            {reconciliation?.error ??
              "Token-transfer coverage has not been published for this period."}
          </p>
        </>
      )}
      <p className="muted small">
        The inventory & fee effect in the benchmark includes all changes in
        reserve ownership. It is not a fee-yield estimate. No annualized rate is
        inferred from these totals.
      </p>
    </section>
  );
}
