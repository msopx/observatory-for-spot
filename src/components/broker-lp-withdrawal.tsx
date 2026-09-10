"use client";
import { useMemo, useState } from "react";
import {
  brokerQuotesDatasetSchema,
  type LpRedemptionQuote,
} from "../data/schemas";
import { downloadFile } from "../lib/display";
import { lpExitTotalUsd, sortedLpRedemptions } from "../lib/recorded-quotes";
import { formatUnitsExact } from "../protocol";
import {
  serializeRecordedQuotesCompanion,
  serializeRecordedQuotesCsv,
} from "../reports/report";
import { RecordedQuoteCard, tokenAmount } from "./broker-results";
import { useDataset } from "./use-dataset";

function lpLabel(
  redemption: LpRedemptionQuote,
  lpDecimals: number,
  lpSupply: bigint,
): string {
  const amount = BigInt(redemption.lpAmount);
  const share =
    lpSupply === 0n ? null : (amount * 1_000_000n) / lpSupply; // parts per million
  const shareLabel =
    share === null
      ? ""
      : share >= 10_000n
        ? ` · ${(Number(share) / 10_000).toFixed(share % 10_000n === 0n ? 0 : 2)}% of LP supply`
        : ` · ${(Number(share) / 10_000).toFixed(2)}% of LP supply`;
  return `${tokenAmount(amount, lpDecimals)} LP${shareLabel}${
    redemption.available ? "" : " · unavailable"
  }`;
}

/**
 * Recorded LP exits: `computeRedemptionAmts` for each recorded LP amount and,
 * where SPOT was redeemed, the contract's own quote for selling all of it
 * against the reserves that remain after the withdrawal. No amount is
 * modelled; only recorded amounts can be selected.
 */
export function BrokerLpWithdrawal() {
  const quotes = useDataset("broker-quotes.json", brokerQuotesDatasetSchema);
  const [selectedLp, setSelectedLp] = useState<string | null>(null);
  const [sell, setSell] = useState(false);
  const [message, setMessage] = useState("");
  const view = useMemo(() => {
    if (quotes.status !== "ready") return null;
    const dataset = quotes.data;
    const rows = sortedLpRedemptions(dataset);
    const lpDecimals = Number(dataset.lpDecimals);
    const lpSupply = BigInt(dataset.lpSupply);
    // Default to the recorded point nearest 1% of supply, as the ledger does.
    const onePercent = lpSupply / 100n;
    const nearest = rows.reduce<LpRedemptionQuote | null>((best, row) => {
      if (best === null) return row;
      const distance = (value: LpRedemptionQuote) => {
        const amount = BigInt(value.lpAmount);
        return amount > onePercent ? amount - onePercent : onePercent - amount;
      };
      return distance(row) < distance(best) ? row : best;
    }, null);
    const selected =
      rows.find((row) => row.lpAmount === selectedLp) ?? nearest ?? rows[0];
    return { dataset, rows, lpDecimals, lpSupply, selected };
  }, [quotes, selectedLp]);

  return (
    <section id="withdrawal" className="section card">
      <div className="eyebrow">Recorded LP exits</div>
      <h2>Start with the basket. Then the recorded sale.</h2>
      <p>
        Redeeming Broker LP notes returns both USDC and SPOT. For each recorded
        LP amount the contract was asked what it returns, and then what it
        would pay for all of that SPOT against the reserves left after the
        withdrawal.
      </p>
      {quotes.status === "loading" || view === null ? (
        quotes.status === "error" ? (
          <p className="error">The recorded LP exit dataset could not be loaded.</p>
        ) : (
          <p className="muted">Loading recorded LP exits…</p>
        )
      ) : view.selected === undefined ? (
        <p className="broker-status-note">No LP redemption was recorded.</p>
      ) : (
        <>
          <div className="form-grid">
            <label>
              Recorded LP amount
              <select
                aria-label="Recorded LP amount"
                value={view.selected.lpAmount}
                onChange={(event) => setSelectedLp(event.target.value)}
              >
                {view.rows.map((row) => (
                  <option key={row.lpAmount} value={row.lpAmount}>
                    {lpLabel(row, view.lpDecimals, view.lpSupply)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              After withdrawal
              <select
                value={sell ? "sell" : "hold"}
                onChange={(event) => setSell(event.target.value === "sell")}
              >
                <option value="hold">Keep USDC and SPOT</option>
                <option value="sell">Sell all redeemed SPOT into Broker</option>
              </select>
            </label>
          </div>
          <p className="muted small">
            Only recorded amounts can be chosen; amounts between them were not
            called and are not estimated. This is not a wallet balance.
          </p>
          {!view.selected.available ||
          view.selected.usdOut === null ||
          view.selected.spotOut === null ? (
            <p className="broker-status-note">
              The contract call reverted for this LP amount at the release
              block; no amounts were recorded.
            </p>
          ) : (
            <>
              <div className="grid two section">
                <div>
                  <div className="eyebrow">USDC returned (recorded)</div>
                  <div className="broker-quote-value">
                    {tokenAmount(
                      BigInt(view.selected.usdOut),
                      Number(view.dataset.usdToken.decimals),
                    )}{" "}
                    <small>USDC</small>
                  </div>
                </div>
                <div>
                  <div className="eyebrow">SPOT returned (recorded)</div>
                  <div className="broker-quote-value">
                    {tokenAmount(
                      BigInt(view.selected.spotOut),
                      Number(view.dataset.spotToken.decimals),
                    )}{" "}
                    <small>SPOT</small>
                  </div>
                </div>
              </div>
              {sell ? (
                <div className="section">
                  {view.selected.sale ? (
                    <RecordedQuoteCard
                      title="Second leg · recorded sale of redeemed SPOT"
                      dataset={{
                        ...view.dataset,
                        reserveState: {
                          ...view.dataset.reserveState,
                          usdBalance:
                            view.selected.postWithdrawalReserves?.usdBalance ??
                            view.dataset.reserveState.usdBalance,
                          spotBalance:
                            view.selected.postWithdrawalReserves?.spotBalance ??
                            view.dataset.reserveState.spotBalance,
                        },
                      }}
                      direction="spot-to-usd"
                      quote={view.selected.sale}
                    />
                  ) : (
                    <p>No SPOT was redeemed, so there is nothing to sell.</p>
                  )}
                  {(() => {
                    const total = lpExitTotalUsd(view.selected);
                    return total !== null ? (
                      <p className="broker-quote-value">
                        {tokenAmount(
                          total,
                          Number(view.dataset.usdToken.decimals),
                        )}{" "}
                        <small>
                          total USDC after both legs (recorded USDC plus recorded
                          sale output)
                        </small>
                      </p>
                    ) : (
                      <p className="broker-status-note">
                        The contract returned no sale quote for this SPOT amount
                        against the post-withdrawal reserves, so a complete USDC
                        exit was not recorded.
                      </p>
                    );
                  })()}
                </div>
              ) : null}
              <p className="muted">
                Recorded once at the release block{" "}
                {view.dataset.metadata.blockNumber} (
                {view.dataset.metadata.blockTimestamp?.slice(0, 10) ??
                  "timestamp unavailable"}
                ), which can be earlier than the observations above. Burn fee at
                that block:{" "}
                {formatUnitsExact(BigInt(view.dataset.burnFeePercent), 16)}%.
                The sale leg passes the reserves minus the redeemed amounts to
                the contract; no intervening transaction, price change or gas is
                represented, and historical contract outputs are not executable
                quotes.
              </p>
            </>
          )}
          <div className="button-row">
            <button
              type="button"
              onClick={() => {
                downloadFile(
                  "broker-lp-exits.csv",
                  serializeRecordedQuotesCsv(view.dataset, {
                    directions: [],
                    includeLpRedemptions: true,
                  }),
                  "text/csv",
                );
                setMessage("Recorded LP exits exported.");
              }}
            >
              Export LP exits CSV
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                downloadFile(
                  "broker-lp-exits.meta.json",
                  serializeRecordedQuotesCompanion(view.dataset),
                  "application/json",
                );
                setMessage("Recorded LP exit context exported.");
              }}
            >
              Export LP exit context
            </button>
          </div>
          {message ? <p role="status">{message}</p> : null}
        </>
      )}
    </section>
  );
}
