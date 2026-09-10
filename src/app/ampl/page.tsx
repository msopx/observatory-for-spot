"use client";
import { useState } from "react";
import { useDataset } from "../../components/use-dataset";
import {
  amplRebasesDatasetSchema,
  type AmplRebasesDataset,
} from "../../data/schemas";
import { DatasetBanner, RefreshWarning } from "../../components/dataset-banner";
import { MetricCard } from "../../components/metric-card";
import { RebaseChart } from "../../components/rebase-chart";
import { RebaseCalendar } from "../../components/rebase-calendar";
import {
  filterRebases,
  hasValidRate,
  latestValidRate,
  recentRange,
  rebaseDirection,
  rebaseSummary,
} from "../../analytics/rebases";
import { csv, dateLabel, downloadFile, token, usd } from "../../lib/display";
export default function AmplPage() {
  const dataset = useDataset("ampl-rebases.json", amplRebasesDatasetSchema);
  if (dataset.status === "loading")
    return <p className="loading">Loading AMPL data…</p>;
  if (dataset.status === "error")
    return <p className="error">{dataset.error}</p>;
  return (
    <>
      <RefreshWarning failed={dataset.refreshError === true} />
      <AmplHistory data={dataset.data} />
    </>
  );
}
function AmplHistory({ data }: { data: AmplRebasesDataset }) {
  const [range, setRange] = useState(recentRange(data.rows, 90));
  const [page, setPage] = useState(0);
  const filtered = filterRebases(data.rows, range.from, range.to);
  const stats = rebaseSummary(filtered);
  const latest = data.rows.at(-1);
  const latestRate = latestValidRate(data.rows);
  const tableRows = filtered
    .slice()
    .reverse()
    .slice(page * 100, (page + 1) * 100);
  const invalid = range.from && range.to && range.from > range.to;
  function choose(days: number | null) {
    setRange(days ? recentRange(data.rows, days) : { from: "", to: "" });
    setPage(0);
  }
  return (
    <>
      <section className="hero">
        <div className="eyebrow">AMPL / Monetary policy</div>
        <h1>Every rebase, in view.</h1>
        <p className="lede">
          Explore expansion and contraction, compare the policy rate with its
          target, and inspect the resulting change in supply.
        </p>
      </section>
      <DatasetBanner
        status={data.metadata.status === "release" ? "release" : "fixture"}
        blockNumber={data.metadata.blockNumber}
        blockHash={data.metadata.blockHash}
        timestamp={data.metadata.blockTimestamp ?? undefined}
      />
      <section className="grid four section">
        <MetricCard
          label="Latest valid exchange rate"
          value={latestRate ? usd(latestRate.exchangeRate) : "—"}
          detail={
            !latest
              ? "No indexed epoch"
              : !latestRate
                ? "No epoch carried a valid market rate"
                : latestRate === latest
                  ? `Target ${usd(latest.cpiAdjustedTargetRate)}`
                  : `Epoch ${latestRate.epoch} · epoch ${latest.epoch} reported no valid market rate`
          }
        />
        <MetricCard
          label="Expansion epochs"
          value={stats.expansion.toLocaleString("en-US")}
          detail={`Longest sequence: ${stats.longestExpansion} consecutive epochs`}
        />
        <MetricCard
          label="Contraction epochs"
          value={stats.contraction.toLocaleString("en-US")}
          detail={`Longest sequence: ${stats.longestContraction} consecutive epochs`}
        />
        <MetricCard
          label="Latest sequence in range"
          value={stats.currentStreak ? `${stats.currentStreak} epochs` : "—"}
          detail={`${stats.currentDirection} · gaps break sequences`}
        />
      </section>
      <section className="card section">
        <div className="section-title">
          <h2>AMPL rebase history</h2>
          <span className="badge">
            {filtered.length.toLocaleString("en-US")} indexed epochs
          </span>
        </div>
        <div className="range-controls">
          <div className="segmented">
            {[30, 90, 365].map((days) => (
              <button type="button" key={days} onClick={() => choose(days)}>
                {days === 365 ? "1 year" : `${days} days`}
              </button>
            ))}
            <button type="button" onClick={() => choose(null)}>
              All history
            </button>
          </div>
          <label>
            From (UTC)
            <input
              type="date"
              value={range.from}
              onChange={(event) => {
                setRange({ ...range, from: event.target.value });
                setPage(0);
              }}
            />
          </label>
          <label>
            To (UTC)
            <input
              type="date"
              value={range.to}
              onChange={(event) => {
                setRange({ ...range, to: event.target.value });
                setPage(0);
              }}
            />
          </label>
        </div>
        {invalid ? (
          <p className="error">
            The end date must be on or after the start date.
          </p>
        ) : filtered.length ? (
          <RebaseChart rows={filtered} />
        ) : (
          <p className="empty-state">No indexed epochs fall in this range.</p>
        )}
        <p className="provenance">
          Rate observations come from policy events. Missing epochs remain
          missing; lines connect recorded rate observations and do not fill gaps
          in rebase data. An epoch whose market oracle reported no valid rate is
          left as a gap in the rate line rather than drawn as a price.
        </p>
      </section>
      <section className="section grid two">
        <article className="card">
          <h2>Rebase calendar</h2>
          <RebaseCalendar rows={data.rows} />
        </article>
        <article className="card">
          <div className="eyebrow">Read the signals</div>
          <h2>Supply changes, explained</h2>
          <p className="muted">
            The policy compares the reported AMPL exchange rate with a
            CPI-adjusted target. A rebase changes token balances proportionally;
            it does not directly set the traded price.
          </p>
          <hr className="divider" />
          <h3>Actual versus requested</h3>
          <p className="muted small">
            The requested adjustment comes from the policy event. Actual change
            compares the emitted token supply with the previous supply, so
            integer rounding remains visible.
          </p>
          <hr className="divider" />
          <h3>Streaks need consecutive epochs</h3>
          <p className="muted small">
            An epoch gap ends a streak. Calendar days without an indexed epoch
            stay blank. If a day contains several epochs, its tile shows the
            last and the selection lists each.
          </p>
          <div className="button-row">
            <button
              type="button"
              disabled={!filtered.length}
              onClick={() =>
                downloadFile(
                  "ampl-rebases-filtered.csv",
                  csv(filtered),
                  "text/csv",
                )
              }
            >
              Export filtered CSV
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() =>
                downloadFile(
                  "ampl-rebases-viewed.json",
                  JSON.stringify(data, null, 2) + "\n",
                )
              }
            >
              Export viewed dataset
            </button>
          </div>
        </article>
      </section>
      <section className="section">
        <h2>Indexed epochs</h2>
        <div className="table-toolbar">
          <span>
            Showing {filtered.length ? page * 100 + 1 : 0}–
            {Math.min((page + 1) * 100, filtered.length)} of{" "}
            {filtered.length.toLocaleString("en-US")} · newest first
          </span>
          <div className="table-actions">
            <button
              className="secondary"
              type="button"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Newer
            </button>
            <button
              className="secondary"
              type="button"
              disabled={(page + 1) * 100 >= filtered.length}
              onClick={() => setPage(page + 1)}
            >
              Older
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Epoch</th>
                <th>Date (UTC)</th>
                <th>Exchange rate</th>
                <th>Target</th>
                <th>Requested adjustment</th>
                <th>Total supply</th>
                <th>Actual change</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr key={`${row.transactionHash}-${row.epoch}`}>
                  <td>
                    <a
                      href={`https://etherscan.io/tx/${row.transactionHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.epoch} ↗
                    </a>
                  </td>
                  <td>{dateLabel(row.timestamp, true)}</td>
                  <td>
                    {hasValidRate(row) ? (
                      usd(row.exchangeRate)
                    ) : (
                      <span
                        className="muted"
                        title="The policy event carried a zero rate: the market oracle reported no valid rate and no supply adjustment was requested."
                      >
                        No valid rate
                      </span>
                    )}
                  </td>
                  <td>{usd(row.cpiAdjustedTargetRate)}</td>
                  <td>{token(row.requestedSupplyAdjustment, 9, 4)} AMPL</td>
                  <td>{token(row.totalSupply, 9, 2)}</td>
                  <td
                    className={
                      rebaseDirection(row) === "contraction"
                        ? "negative"
                        : rebaseDirection(row) === "expansion"
                          ? "positive"
                          : "muted"
                    }
                  >
                    {row.supplyChangePercent === null
                      ? "Unavailable"
                      : `${Number(row.supplyChangePercent) > 0 ? "+" : ""}${Number(row.supplyChangePercent).toFixed(4)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
