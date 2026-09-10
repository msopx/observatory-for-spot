"use client";
import { useState } from "react";
import Link from "next/link";
import { useObservatory } from "../../components/use-observatory";
import { FeedEmpty, FeedStatus } from "../../components/feed-status";
import { MetricCard } from "../../components/metric-card";
import { ValueHistory } from "../../components/value-history";
import { holdingPeriodPercent } from "../../data/observatory-schemas";
import { csv, dateLabel, downloadFile, token } from "../../lib/display";
export default function StamplPage() {
  const feed = useObservatory("stampl-history");
  const [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const rows = feed.status === "ready" ? (feed.data?.rows ?? []) : [];
  const latest = rows.at(-1);
  const rebalanceDisabled =
    latest?.rebalancePaused === true ||
    latest?.lastRebalanceTimestamp === "18446744073709551615";
  const eligibleAt =
    latest?.lastRebalanceTimestamp && latest.fundingPeriodSeconds
      ? BigInt(latest.lastRebalanceTimestamp) +
        BigInt(latest.fundingPeriodSeconds) +
        1n
      : null;
  const eligible =
    latest &&
    eligibleAt !== null &&
    !rebalanceDisabled &&
    !latest.paused &&
    BigInt(Math.floor(Date.parse(latest.timestamp) / 1000)) >= eligibleAt;
  const selected = rows.filter(
    (row) =>
      (!start || row.timestamp.slice(0, 10) >= start) &&
      (!end || row.timestamp.slice(0, 10) <= end),
  );
  const first = selected.at(0),
    last = selected.at(-1);
  const change =
    first && last && first.blockNumber !== last.blockNumber
      ? holdingPeriodPercent(first.amplPerStamplWad, last.amplPerStamplWad)
      : null;
  return (
    <>
      <section className="hero">
        <div className="eyebrow">stAMPL / Rollover vault</div>
        <h1>The other side of the system.</h1>
        <p className="lede">
          Follow stAMPL’s AMPL-denominated value and the funding mechanism that
          helps maintain SPOT’s collateral structure.
        </p>
      </section>
      <FeedStatus feed={feed} label="stAMPL" />
      <section className="grid four section">
        <MetricCard
          label="AMPL per stAMPL"
          value={latest ? token(latest.amplPerStamplWad, 18, 6) : "—"}
          detail="Vault collateral value per share"
        />
        <MetricCard
          label="Vault collateral"
          value={latest ? `${token(latest.collateralAmpl, 9, 0)} AMPL` : "—"}
          detail="Underlying valuation at observation"
        />
        <MetricCard
          label="stAMPL supply"
          value={
            latest ? token(latest.totalSupply, Number(latest.decimals), 2) : "—"
          }
          detail="Outstanding vault shares"
        />
        <MetricCard
          label="Deviation ratio"
          value={
            latest
              ? token(
                  latest.deviationRatio,
                  Number(latest.deviationRatioDecimals),
                  4,
                )
              : "—"
          }
          detail="State input to funding policy"
        />
      </section>
      <section className="card section">
        <div className="section-title">
          <h2>Exchange-rate history</h2>
          <span className="badge">AMPL per stAMPL</span>
        </div>
        <div className="form-grid">
          <label>
            From (UTC)
            <input
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
            />
          </label>
          <label>
            To (UTC)
            <input
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
            />
          </label>
        </div>
        {start && end && start > end ? (
          <p className="error">
            Choose an end date on or after the start date.
          </p>
        ) : selected.length > 1 ? (
          <ValueHistory
            points={selected.map((row) => ({
              time: Date.parse(row.timestamp),
              rate: Number(row.amplPerStamplWad) / 1e18,
            }))}
            series={[
              { key: "rate", name: "AMPL per stAMPL", color: "var(--accent)" },
            ]}
          />
        ) : (
          <div className="section">
            <FeedEmpty
              title={
                selected.length === 1
                  ? "One observation; no return interval"
                  : "No observations in this range"
              }
            >
              A historical return needs at least two supported block
              observations. A single exchange rate does not establish yield.
            </FeedEmpty>
          </div>
        )}
        <div className="grid two section">
          <MetricCard
            label="Holding-period change"
            value={
              change === null
                ? "Unavailable"
                : `${Number(change) > 0 ? "+" : ""}${Number(change).toFixed(3)}%`
            }
            detail="Change in AMPL per stAMPL; not USD return or APR"
          />
          <MetricCard
            label="Observations in range"
            value={selected.length.toString()}
            detail={
              first && last
                ? `${dateLabel(first.timestamp)} – ${dateLabel(last.timestamp)}`
                : "No supported interval"
            }
          />
        </div>
        <p className="muted small">
          This rate combines changes in the vault’s underlying valuation,
          including rebases, rollover economics and fees. It does not isolate
          funding earned, and it is not an executable redemption quote.
        </p>
        <div className="button-row">
          <button
            disabled={!selected.length}
            type="button"
            onClick={() =>
              downloadFile(
                "stampl-history.csv",
                csv(
                  selected.map((row) => ({
                    timestamp: row.timestamp,
                    blockNumber: row.blockNumber,
                    blockHash: row.blockHash,
                    amplPerStamplWad: row.amplPerStamplWad,
                    collateralAmpl: row.collateralAmpl,
                    totalSupply: row.totalSupply,
                  })),
                ),
                "text/csv",
              )
            }
          >
            Export observations CSV
          </button>
        </div>
      </section>
      <section className="grid two section">
        <article className="card">
          <div className="eyebrow">Funding, precisely labelled</div>
          <h2>Policy indication at observed TVLs</h2>
          {latest?.indicatedFundingAmpl !== null &&
          latest?.indicatedFundingAmpl !== undefined ? (
            <>
              <div className="metric-value">
                {token(
                  BigInt(latest.indicatedFundingAmpl) < 0n
                    ? -BigInt(latest.indicatedFundingAmpl)
                    : latest.indicatedFundingAmpl,
                  9,
                  6,
                )}{" "}
                AMPL
              </div>
              <p className="muted">
                {BigInt(latest.indicatedFundingAmpl) === 0n
                  ? "No transfer indicated"
                  : BigInt(latest.indicatedFundingAmpl) > 0n
                    ? "Indicated direction: stAMPL → SPOT (policy value positive)"
                    : "Indicated direction: SPOT → stAMPL (policy value negative)"}
                .
              </p>
              <p className="small muted">
                {latest.fundingPeriodSeconds
                  ? `Quoted for a period of ${token(latest.fundingPeriodSeconds, 0, 0)} seconds.`
                  : "The applicable funding period is not available."}{" "}
                This is a state-dependent indication, not a realized payment or
                annual yield.
              </p>
            </>
          ) : (
            <FeedEmpty title="Funding indication unavailable">
              A recorded funding-policy call and its applicable period are
              needed. The exchange-rate change is not presented as a funding
              APR.
            </FeedEmpty>
          )}
          <p className="small muted">
            The vault settles fees and collateral before a real rebalance and
            deducts protocol fees afterward. Those steps can change the transfer
            from this direct policy indication.
          </p>
          {latest ? (
            <p className="status warning">
              {rebalanceDisabled
                ? "Rebalancing disabled at this observation"
                : latest.paused
                  ? "Vault paused at this observation"
                  : eligible
                    ? "Time condition satisfied at this observation; execution can still depend on other state."
                    : "Rebalance time condition not satisfied or unavailable at this observation."}
            </p>
          ) : null}
          <p className="provenance">
            {latest
              ? `Observed ${dateLabel(latest.timestamp, true)} UTC`
              : "No observation"}
          </p>
        </article>
        <article className="card">
          <h2>How the roles connect</h2>
          <p className="muted">
            SPOT holds senior claims and underlying AMPL. The rollover vault
            refreshes that collateral structure through permitted asset
            exchanges. stAMPL represents ownership in the vault and takes a
            different risk profile from SPOT.
          </p>
          <hr className="divider" />
          <h3>Follow both sides</h3>
          <p className="muted small">
            The deviation ratio informs the funding mechanism. Its direction,
            amount and timing depend on the deployed policy and current state,
            so a historical governance setting is not assumed to describe
            today’s policy.
          </p>
          <div className="button-row">
            <Link className="button-link secondary" href="/spot/">
              Inspect SPOT collateral
            </Link>
            <Link className="button-link secondary" href="/learn/">
              Explore rollover cases
            </Link>
          </div>
        </article>
      </section>
      {latest ? (
        <details>
          <summary>Implementation & observation details</summary>
          <p className="provenance">
            Block {latest.blockNumber} · {latest.blockHash}
            <br />
            Vault implementation {latest.implementation.address}
            <br />
            Runtime hash {latest.implementation.codeHash}
            <br />
            Fee policy {latest.feePolicyImplementation.address}
            <br />
            Policy runtime hash {latest.feePolicyImplementation.codeHash}
          </p>
        </details>
      ) : null}
    </>
  );
}
