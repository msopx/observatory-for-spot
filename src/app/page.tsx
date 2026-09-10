"use client";
import Link from "next/link";
import { useState } from "react";
import { useDataset } from "../components/use-dataset";
import {
  amplRebasesDatasetSchema,
  brokerStateDatasetSchema,
  spotHealthDatasetSchema,
} from "../data/schemas";
import { DatasetBanner, RefreshWarning } from "../components/dataset-banner";
import { MetricCard } from "../components/metric-card";
import { RebaseChart } from "../components/rebase-chart";
import { RebaseCalendar } from "../components/rebase-calendar";
import { CollateralComposition } from "../components/collateral-composition";
import {
  filterRebases,
  latestValidRate,
  recentRange,
  rebaseSummary,
} from "../analytics/rebases";
import { dateLabel, token, usd } from "../lib/display";
export default function HomePage() {
  const ampl = useDataset("ampl-rebases.json", amplRebasesDatasetSchema);
  const spot = useDataset("spot-health.json", spotHealthDatasetSchema);
  const broker = useDataset("broker-state.json", brokerStateDatasetSchema);
  const [days, setDays] = useState(90);
  const latest = ampl.status === "ready" ? ampl.data.rows.at(-1) : undefined;
  const latestRate =
    ampl.status === "ready" ? latestValidRate(ampl.data.rows) : undefined;
  const range =
    ampl.status === "ready"
      ? recentRange(ampl.data.rows, days)
      : { from: "", to: "" };
  const rows =
    ampl.status === "ready"
      ? filterRebases(ampl.data.rows, range.from, range.to)
      : [];
  const stats = rebaseSummary(rows);
  return (
    <>
      <section className="hero hero-wide">
        <div>
          <div className="eyebrow">The AMPL / SPOT ecosystem</div>
          <h1>A clearer view of the system.</h1>
          <p className="lede">
            Follow the rebase. Understand the collateral. Explore your position.
            <br />
            Independent analytics from recorded Ethereum observations.
          </p>
        </div>
        <span className="badge">
          <span className="dot" />
          Ethereum mainnet
        </span>
      </section>
      {spot.status === "ready" ? (
        <DatasetBanner
          status={
            spot.data.metadata.status === "release" ? "release" : "fixture"
          }
          blockNumber={spot.data.metadata.blockNumber}
          blockHash={spot.data.metadata.blockHash}
          timestamp={spot.data.metadata.blockTimestamp ?? undefined}
        />
      ) : spot.status === "error" ? (
        <p className="error">SPOT snapshot could not be loaded.</p>
      ) : (
        <p className="loading">Loading the latest published snapshot…</p>
      )}
      <RefreshWarning
        failed={[ampl, spot, broker].some(
          (feed) => feed.status === "ready" && feed.refreshError === true,
        )}
      />
      <section className="grid four section">
        <MetricCard
          label="AMPL exchange rate"
          value={latestRate ? usd(latestRate.exchangeRate) : "—"}
          detail={
            !latest
              ? "Waiting for indexed rate"
              : !latestRate
                ? "No epoch carried a valid market rate"
                : latestRate === latest
                  ? `Target ${usd(latest.cpiAdjustedTargetRate)} · ${dateLabel(latest.timestamp)}`
                  : `Last valid rate ${dateLabel(latestRate.timestamp)} · epoch ${latest.epoch} reported no valid rate`
          }
        />
        <MetricCard
          label="Latest actual rebase"
          value={
            latest?.supplyChangePercent !== null &&
            latest?.supplyChangePercent !== undefined
              ? `${Number(latest.supplyChangePercent) > 0 ? "+" : ""}${Number(latest.supplyChangePercent).toFixed(3)}%`
              : "—"
          }
          detail={
            latest
              ? `Epoch ${latest.epoch} · changes AMPL balances`
              : "No indexed epoch"
          }
        />
        <MetricCard
          label="SPOT protocol FMV"
          value={
            broker.status === "ready"
              ? usd(broker.data.reserveState.spotPrice)
              : "—"
          }
          detail={
            broker.status === "ready"
              ? `Oracle valuation · ${dateLabel(broker.data.metadata.blockTimestamp ?? broker.data.metadata.generatedAt, true)} UTC`
              : "No quote snapshot"
          }
        />
        <MetricCard
          label="SPOT collateral"
          value={
            spot.status === "ready"
              ? `${token(spot.data.spot.collateralTvl, 9, 0)} AMPL`
              : "—"
          }
          detail="Underlying value of protocol reserves"
        />
      </section>
      <section className="section grid dashboard">
        <article className="card">
          <div className="section-title">
            <div>
              <h2>AMPL, in context</h2>
              <p className="muted small">Policy rate and CPI-adjusted target</p>
            </div>
            <div className="segmented">
              {[30, 90, 365].map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={days === value}
                  onClick={() => setDays(value)}
                >
                  {value === 365 ? "1Y" : `${value}D`}
                </button>
              ))}
            </div>
          </div>
          <RebaseChart rows={rows} />
          <div className="table-toolbar">
            <span>
              {ampl.status === "ready"
                ? `${stats.expansion} expansion · ${stats.contraction} contraction · ${stats.neutral} neutral epochs`
                : ampl.status === "error"
                  ? "AMPL history unavailable"
                  : "Loading indexed epochs…"}
            </span>
            <Link className="text-link" href="/ampl/">
              Explore history ↗
            </Link>
          </div>
        </article>
        <article className="card">
          <div className="section-title">
            <h2>What backs SPOT?</h2>
            <Link href="/spot/">Inspect ↗</Link>
          </div>
          <p className="muted small">
            Reserve composition by underlying AMPL value.
          </p>
          {spot.status === "ready" ? (
            <CollateralComposition reserves={spot.data.reserves} />
          ) : (
            <p className="muted">Loading collateral…</p>
          )}
        </article>
      </section>
      <section className="section grid two">
        <article className="card">
          <div className="section-title">
            <h2>Rebase calendar</h2>
            <Link href="/ampl/">Full history ↗</Link>
          </div>
          {ampl.status === "ready" ? (
            <RebaseCalendar rows={ampl.data.rows} />
          ) : (
            <p className="muted">
              {ampl.status === "error"
                ? "Calendar unavailable: AMPL history could not be loaded."
                : "Loading calendar…"}
            </p>
          )}
        </article>
        <div className="grid">
          <article className="card">
            <div className="section-title">
              <h2>Inside the Broker</h2>
              <Link href="/broker/">See recorded quotes ↗</Link>
            </div>
            <p className="muted small">
              Standard one-token contract quotes recorded at the indexed block.
              The Broker page holds the recorded trade-size grid from the
              release block.
            </p>
            {broker.status === "ready" ? (
              <>
                <div className="quote-pair">
                  <span>
                    Sell 1 SPOT<small>Includes Broker swap fee or rebate</small>
                  </span>
                  <strong>
                    {broker.data.quotes.spotToUsd.outputAmount === null
                      ? "Unavailable"
                      : `${token(broker.data.quotes.spotToUsd.outputAmount, 6, 4)} USDC`}
                  </strong>
                </div>
                <div className="quote-pair">
                  <span>
                    Spend 1 USDC<small>SPOT received</small>
                  </span>
                  <strong>
                    {broker.data.quotes.usdToSpot.outputAmount === null
                      ? "Unavailable"
                      : token(
                          broker.data.quotes.usdToSpot.outputAmount,
                          9,
                          4,
                        )}{" "}
                    SPOT
                  </strong>
                </div>
                <p className="provenance">
                  {dateLabel(
                    broker.data.metadata.blockTimestamp ??
                      broker.data.metadata.generatedAt,
                    true,
                  )}{" "}
                  UTC · no gas included
                </p>
              </>
            ) : (
              <p className="muted">Quote snapshot unavailable.</p>
            )}
          </article>
          <Link className="card card-link" href="/lp/">
            <div className="eyebrow">For liquidity providers</div>
            <h2>How did your LP notes perform?</h2>
            <p className="muted">
              Compare fixed LP notes with their starting token basket, using
              protocol FMV at each observation.
            </p>
          </Link>
          <Link className="card card-link" href="/learn/">
            <div className="eyebrow">Mechanisms, made tangible</div>
            <h2>Read the casebooks</h2>
            <p className="muted">
              Two short explainers: why SPOT&rsquo;s collateral keeps rotating,
              and how backing, redemption and a Broker exit answer different
              questions.
            </p>
          </Link>
        </div>
      </section>
    </>
  );
}
