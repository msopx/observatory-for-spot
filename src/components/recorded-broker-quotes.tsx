"use client";
import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  brokerQuotesDatasetSchema,
  type BrokerQuotesDataset,
} from "../data/schemas";
import { downloadFile } from "../lib/display";
import {
  deriveQuote,
  directionAssets,
  formatWadPercent,
  gridFor,
  type QuoteDirection,
} from "../lib/recorded-quotes";
import { formatUnitsExact } from "../protocol";
import {
  serializeRecordedQuotesCompanion,
  serializeRecordedQuotesCsv,
} from "../reports/report";
import { RecordedQuoteCard, tokenAmount } from "./broker-results";
import { useDataset } from "./use-dataset";

function sizeLabel(
  dataset: BrokerQuotesDataset,
  direction: QuoteDirection,
  inputAmount: string,
  available: boolean,
): string {
  const assets = directionAssets(dataset, direction);
  return `${tokenAmount(BigInt(inputAmount), assets.inputDecimals)} ${assets.inputSymbol}${
    available ? "" : " · unavailable"
  }`;
}

/**
 * Recorded Bill Broker quotes at the release block. Every figure shown is an
 * eth_call result of the deployed contract or arithmetic on such results that
 * is labelled as derived; the interface computes no quote of its own.
 *
 * `indexedSnapshot` is the block of the refreshed broker-state feed shown
 * above this section. The grid is recorded once, at the release block, so the
 * two blocks can differ; the difference is stated rather than left implicit.
 */
export function RecordedBrokerQuotes({
  indexedSnapshot,
}: {
  indexedSnapshot?: { blockNumber: string; timestamp: string | null };
}) {
  const quotes = useDataset("broker-quotes.json", brokerQuotesDatasetSchema);
  const [direction, setDirection] = useState<QuoteDirection>("spot-to-usd");
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const view = useMemo(() => {
    if (quotes.status !== "ready") return null;
    const dataset = quotes.data;
    const grid = gridFor(dataset, direction);
    const assets = directionAssets(dataset, direction);
    const selected =
      grid.find((quote) => quote.inputAmount === selectedInput) ?? grid[0];
    const points = grid.map((quote) => {
      const derived = deriveQuote(dataset, direction, quote);
      return {
        input: Number(
          formatUnitsExact(BigInt(quote.inputAmount), assets.inputDecimals),
        ),
        output:
          quote.available && quote.outputAmount !== null
            ? Number(
                formatUnitsExact(
                  BigInt(quote.outputAmount),
                  assets.outputDecimals,
                ),
              )
            : null,
        impliedFeePercent:
          derived.impliedFeeWad === null
            ? null
            : Number(formatUnitsExact(derived.impliedFeeWad * 100n, 18)),
        available: quote.available,
      };
    });
    return { dataset, grid, assets, selected, points };
  }, [direction, quotes, selectedInput]);

  if (quotes.status === "loading")
    return (
      <section className="section card">
        <p className="loading">Loading recorded Broker quotes…</p>
      </section>
    );
  if (quotes.status === "error" || view === null || view.selected === undefined)
    return (
      <section className="section card" aria-label="Recorded Broker quotes">
        <div className="eyebrow">Recorded contract quotes</div>
        <p className="broker-status-note">
          The recorded quote dataset could not be loaded. The standard
          one-token quotes in the snapshot details below remain available.
        </p>
      </section>
    );
  const { dataset, grid, assets, selected, points } = view;
  const recordedDate =
    dataset.metadata.blockTimestamp?.slice(0, 10) ?? "timestamp unavailable";
  const recordedBlock = dataset.metadata.blockNumber;
  const differentSnapshot =
    indexedSnapshot !== undefined &&
    indexedSnapshot.blockNumber !== recordedBlock
      ? indexedSnapshot
      : null;
  return (
    <section
      className="section broker-workbench"
      aria-label="Recorded Broker quotes"
    >
      <div className="section-title">
        <div>
          <div className="eyebrow">Recorded contract quotes</div>
          <h2>
            What the Broker quoted on {recordedDate}, block {recordedBlock}.
          </h2>
        </div>
        <span className="badge">
          Release block {recordedBlock} · eth_call
        </span>
      </div>
      {differentSnapshot ? (
        <p className="broker-status-note">
          This grid was recorded once, at the release block {recordedBlock} (
          {recordedDate}). The indexed snapshot above is block{" "}
          {differentSnapshot.blockNumber}
          {differentSnapshot.timestamp
            ? ` (${differentSnapshot.timestamp.slice(0, 10)})`
            : ""}
          ; its reserves and one-token quotes are separate, later reads and are
          not interchangeable with the figures below.
        </p>
      ) : null}
      <article className="card broker-controls">
        <div className="form-grid">
          <label>
            Trade direction
            <select
              value={direction}
              onChange={(event) => {
                setDirection(event.target.value as QuoteDirection);
                setSelectedInput(null);
              }}
            >
              <option value="spot-to-usd">SPOT for USDC</option>
              <option value="usd-to-spot">USDC for SPOT</option>
            </select>
          </label>
          <label>
            Recorded trade size
            <select
              value={selected.inputAmount}
              onChange={(event) => setSelectedInput(event.target.value)}
            >
              {grid.map((quote) => (
                <option key={quote.inputAmount} value={quote.inputAmount}>
                  {sizeLabel(dataset, direction, quote.inputAmount, quote.available)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          Each size is a separate contract call at block {recordedBlock} (
          {recordedDate}) against the reserves and prices recorded at that
          block. Sizes between recorded points were not called and are not
          estimated. Historical contract outputs are not executable quotes:
          gas, ordering and pause state are not represented.
        </p>
      </article>
      <div className="grid two section broker-output-grid">
        <RecordedQuoteCard
          title="Recorded quote"
          dataset={dataset}
          direction={direction}
          quote={selected}
        />
        <article className="card">
          <h3>Recorded output by trade size</h3>
          <p className="muted">
            One point per recorded call; gaps are sizes the contract could not
            fill. Nothing is drawn between points.
          </p>
          <div className="broker-chart" style={{ height: 300, minWidth: 0 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={points}
                margin={{ top: 28, right: 15, left: 0, bottom: 10 }}
              >
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" />
                <XAxis
                  dataKey="input"
                  type="number"
                  scale="log"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(n) =>
                    Number(n).toLocaleString("en-US", { notation: "compact" })
                  }
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(n) =>
                    Number(n).toLocaleString("en-US", { notation: "compact" })
                  }
                />
                <Tooltip
                  labelFormatter={(n) => `${n} ${assets.inputSymbol} in`}
                />
                <Legend />
                <Line
                  name={`Recorded ${assets.outputSymbol} out`}
                  dataKey="output"
                  stroke="var(--accent)"
                  strokeWidth={0}
                  connectNulls={false}
                  // Explicit fill: Recharts dots default to white, which
                  // disappears on the light theme when the line has no stroke.
                  dot={{ r: 4, fill: "var(--accent)", strokeWidth: 0 }}
                  activeDot={{ r: 6, fill: "var(--accent)", strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </article>
      </div>
      <article className="card section">
        <h3>Implied fee against equal value (derived)</h3>
        <p className="muted">
          For each recorded call: (equal-value output − recorded output) ÷
          equal-value output, at the recorded prices. Positive is a fee,
          negative a rebate. This is arithmetic on recorded numbers, not a fee
          model.
        </p>
        <div className="broker-chart" style={{ height: 260, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={points}
              margin={{ top: 28, right: 15, left: 0, bottom: 10 }}
            >
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" />
              <XAxis
                dataKey="input"
                type="number"
                scale="log"
                domain={["dataMin", "dataMax"]}
                tick={{ fontSize: 11 }}
                tickFormatter={(n) =>
                  Number(n).toLocaleString("en-US", { notation: "compact" })
                }
              />
              <YAxis unit="%" tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(n) => `${n} ${assets.inputSymbol} in`}
              />
              <ReferenceLine y={0} stroke="var(--muted)" />
              <Line
                name="Implied fee %"
                dataKey="impliedFeePercent"
                stroke="var(--warning)"
                strokeWidth={0}
                connectNulls={false}
                dot={{ r: 4, fill: "var(--warning)", strokeWidth: 0 }}
                activeDot={{ r: 6, fill: "var(--warning)", strokeWidth: 0 }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <details className="broker-evidence">
          <summary>Inspect every recorded call</summary>
          <div className="broker-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{assets.inputSymbol} in</th>
                  <th>Recorded {assets.outputSymbol} out</th>
                  <th>Protocol fee</th>
                  <th>Implied fee (derived)</th>
                </tr>
              </thead>
              <tbody>
                {grid.map((quote) => {
                  const derived = deriveQuote(dataset, direction, quote);
                  return (
                    <tr key={quote.inputAmount}>
                      <td>
                        {tokenAmount(
                          BigInt(quote.inputAmount),
                          assets.inputDecimals,
                        )}
                      </td>
                      <td>
                        {quote.available && quote.outputAmount !== null
                          ? tokenAmount(
                              BigInt(quote.outputAmount),
                              assets.outputDecimals,
                            )
                          : (quote.unavailableReason ?? "unavailable")}
                      </td>
                      <td>
                        {quote.protocolFeeAmount === null
                          ? "—"
                          : tokenAmount(
                              BigInt(quote.protocolFeeAmount),
                              assets.outputDecimals,
                            )}
                      </td>
                      <td>
                        {derived.impliedFeeWad === null
                          ? "—"
                          : formatWadPercent(derived.impliedFeeWad)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </article>
      <div className="button-row">
        <button
          type="button"
          onClick={() =>
            downloadFile(
              "broker-recorded-quotes.csv",
              serializeRecordedQuotesCsv(dataset),
              "text/csv",
            )
          }
        >
          Export recorded quotes CSV
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() =>
            downloadFile(
              "broker-recorded-quotes.meta.json",
              serializeRecordedQuotesCompanion(dataset),
              "application/json",
            )
          }
        >
          Export quotes context
        </button>
      </div>
      <p className="muted small">
        The CSV holds every recorded swap quote and LP redemption with its
        block, implementation identity and units; derived columns are named
        as such. The context file adds the recorded reserves and prices, the
        grid definition and the dataset&rsquo;s provenance notes.
      </p>
    </section>
  );
}
