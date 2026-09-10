"use client";
import { useState } from "react";
import Link from "next/link";
import { useDataset } from "../../components/use-dataset";
import { useObservatory } from "../../components/use-observatory";
import {
  spotHealthDatasetSchema,
  type SpotHealthDataset,
} from "../../data/schemas";
import { DatasetBanner, RefreshWarning } from "../../components/dataset-banner";
import { MetricCard } from "../../components/metric-card";
import { CollateralComposition } from "../../components/collateral-composition";
import { FeedEmpty, FeedStatus } from "../../components/feed-status";
import { SpotMarketHistory } from "../../components/spot-market-history";
import { dateLabel, token } from "../../lib/display";
export default function SpotPage() {
  const dataset = useDataset("spot-health.json", spotHealthDatasetSchema);
  if (dataset.status === "loading")
    return <p className="loading">Loading SPOT collateral…</p>;
  if (dataset.status === "error")
    return <p className="error">{dataset.error}</p>;
  return (
    <>
      <RefreshWarning failed={dataset.refreshError === true} />
      <SpotHealth data={dataset.data} />
    </>
  );
}
function SpotHealth({ data }: { data: SpotHealthDataset }) {
  const collateral = useObservatory("collateral"),
    exits = useObservatory("exit-inputs");
  const [redemption, setRedemption] = useState("1000000000");
  const point =
    collateral.status === "ready" ? collateral.data?.rows.at(-1) : undefined;
  const exit = exits.status === "ready" ? exits.data?.rows.at(-1) : undefined;
  const quote =
    exit?.spotRedemptions.find((row) => row.inputAmount === redemption) ??
    exit?.spotRedemptions[0];
  const total = BigInt(data.spot.collateralTvl);
  const bonds =
    point?.spot.flatMap((asset) =>
      asset.bond === null || asset.isUnderlying
        ? []
        : [{ asset, bond: asset.bond }],
    ) ?? [];
  return (
    <>
      <section className="hero">
        <div className="eyebrow">SPOT / Collateral</div>
        <h1>Know what sits beneath SPOT.</h1>
        <p className="lede">
          Inspect the reserve basket, follow its maturity schedule, and read the
          recorded state of each senior bond.
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
          label="SPOT collateral TVL"
          value={`${token(total, 9, 0)} AMPL`}
          detail="Underlying value of reserve assets"
        />
        <MetricCard
          label="SPOT total supply"
          value={token(data.spot.totalSupply, 9, 0)}
          detail="Non-rebasing SPOT tokens"
        />
        <MetricCard
          label="Collateral per SPOT"
          value={`${BigInt(data.spot.totalSupply) > 0n ? token((total * 10n ** 18n) / BigInt(data.spot.totalSupply), 18, 6) : "Unavailable"} AMPL`}
          detail="Gross attributable collateral"
        />
        <MetricCard
          label="Deviation ratio"
          value={token(
            data.rolloverVault.deviationRatio,
            Number(data.rolloverVault.deviationRatioDecimals),
            4,
          )}
          detail="Input to rollover funding policy"
        />
      </section>
      <section className="section grid two">
        <article className="card">
          <h2>SPOT system health</h2>
          <p className="muted small">
            Collateral composition at the indexed observation.
          </p>
          <CollateralComposition reserves={data.reserves} />
        </article>
        <article className="card">
          <h2>Maturity ladder</h2>
          <p className="muted small">
            Underlying AMPL value by reserve deadline.
          </p>
          {data.reserves
            .filter((row) => !row.isUnderlying)
            .sort(
              (a, b) =>
                Number(a.maturityTimestamp) - Number(b.maturityTimestamp),
            )
            .map((row) => (
              <div className="maturity-row" key={row.token.address}>
                <span>
                  {row.maturity
                    ? new Date(row.maturity).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        timeZone: "UTC",
                      })
                    : "Unknown"}
                </span>
                <div className="maturity-track">
                  <div
                    className="maturity-fill"
                    style={{
                      width: `${total ? Number((BigInt(row.underlyingValue) * 10000n) / total) / 100 : 0}%`,
                    }}
                  />
                </div>
                <span>{token(row.underlyingValue, 9, 0)} AMPL</span>
              </div>
            ))}
          <p className="provenance">
            Passing a deadline does not prove that a maturity transaction has
            occurred.
          </p>
        </article>
      </section>
      <section className="card section" id="bonds">
        <div className="section-title">
          <h2>Recorded bond state</h2>
          <span className="badge">Contract reads</span>
        </div>
        <FeedStatus feed={collateral} label="Bond data" />
        {point && collateral.status === "ready" && bonds.length > 0 ? (
          <>
            <div className="table-wrap section">
              <table>
                <thead>
                  <tr>
                    <th>Bond</th>
                    <th>Maturity UTC</th>
                    <th>Bond collateral, AMPL</th>
                    <th>Senior supply</th>
                    <th>Senior held by SPOT</th>
                    <th>Senior token collateral, AMPL</th>
                    <th>Identity</th>
                  </tr>
                </thead>
                <tbody>
                  {bonds.map(({ asset, bond }) => (
                    <tr key={bond.address}>
                      <td>
                        <a
                          href={`https://etherscan.io/address/${bond.address}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {bond.address.slice(0, 8)}… ↗
                        </a>
                      </td>
                      <td>
                        {dateLabel(
                          new Date(
                            Number(bond.maturityTimestamp) * 1000,
                          ).toISOString(),
                          true,
                        )}
                        {bond.isMature ? (
                          <small className="muted"> · matured</small>
                        ) : null}
                      </td>
                      <td>{token(bond.collateralUnderlying, 9, 4)}</td>
                      <td>
                        {token(
                          bond.seniorSupply,
                          Number(asset.token.decimals),
                          4,
                        )}
                      </td>
                      <td>
                        {token(bond.heldSenior, Number(asset.token.decimals), 4)}
                      </td>
                      <td>{token(bond.seniorCollateral, 9, 4)}</td>
                      <td>{bond.identity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="provenance">
              Recorded contract reads at block {point.blockNumber}. Bond
              collateral, senior supply and senior-token collateral are the
              values the contracts reported at that block; nothing here is
              projected or stress-tested.
            </p>
          </>
        ) : (
          <FeedEmpty title="Bond reads are not published">
            This table appears when the collateral feed includes recorded bond
            state for the senior tranches SPOT holds.
          </FeedEmpty>
        )}
      </section>
      <SpotMarketHistory />
      <section className="card section" id="claims">
        <div className="section-title">
          <h2>Understand your exit routes</h2>
          <Link href="/broker/">See recorded Broker quotes ↗</Link>
        </div>
        <p className="muted">
          A Broker sale exchanges SPOT for USDC. Protocol redemption returns a
          basket of reserve tokens, which may still need to mature or trade. LP
          withdrawal returns a proportional USDC and SPOT basket after its burn
          fee.
        </p>
        <FeedStatus feed={exits} label="Contract redemption calls" />
        {exit?.spotRedemptions.length ? (
          <>
            <label>
              Recorded SPOT redemption amount
              <select
                value={quote?.inputAmount ?? ""}
                onChange={(event) => setRedemption(event.target.value)}
              >
                {exit.spotRedemptions.map((row) => (
                  <option key={row.inputAmount} value={row.inputAmount}>
                    {token(row.inputAmount, 9, 6)} SPOT
                  </option>
                ))}
              </select>
            </label>
            {quote?.available ? (
              <div className="table-wrap section">
                <table>
                  <thead>
                    <tr>
                      <th>Asset returned</th>
                      <th>Token amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quote.tokensOut.map((row) => {
                      const reserve = exit.spotReserves.find(
                        (asset) =>
                          asset.token.address.toLowerCase() ===
                          row.token.toLowerCase(),
                      );
                      // Several tranche tokens share one symbol; the maturity
                      // and address tell them apart.
                      const qualifier = reserve
                        ? reserve.maturity
                          ? `matures ${dateLabel(reserve.maturity)}`
                          : reserve.isUnderlying
                            ? "underlying"
                            : null
                        : null;
                      return (
                        <tr key={row.token}>
                          <td>
                            {reserve?.token.symbol ?? row.token}
                            {qualifier ? (
                              <small className="muted"> · {qualifier}</small>
                            ) : null}
                            <br />
                            <small className="muted">
                              {row.token.slice(0, 8)}…{row.token.slice(-4)}
                            </small>
                          </td>
                          <td>
                            {reserve
                              ? token(
                                  row.amount,
                                  Number(reserve.token.decimals),
                                  9,
                                )
                              : `${row.amount} base units`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="status warning">
                Redemption unavailable:{" "}
                {quote?.reason ?? "no call recorded for this amount"}.
              </p>
            )}
            <p className="provenance">
              Recorded contract calls at {dateLabel(exit.timestamp, true)} UTC.
              Fees are not linearly interpolated between amounts. Wallet,
              allowance and transaction availability are not considered.
            </p>
          </>
        ) : (
          <FeedEmpty title="Redemption calls are not yet published">
            Basket amounts will appear when recorded contract quotes are
            collected. Gross reserve ownership is not substituted for a
            redemption quote.
          </FeedEmpty>
        )}
        <div className="button-row">
          <Link className="button-link" href="/broker/">
            See recorded Broker sale quotes
          </Link>
          <Link className="button-link secondary" href="/lp/#withdrawal">
            Explore LP withdrawal
          </Link>
        </div>
      </section>
      <details className="section">
        <summary>Reserve addresses & sources</summary>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Token</th>
                <th>Balance</th>
                <th>AMPL value</th>
                <th>Maturity UTC</th>
              </tr>
            </thead>
            <tbody>
              {data.reserves.map((row) => (
                <tr key={row.token.address}>
                  <td>{row.token.symbol}</td>
                  <td>
                    <a
                      href={`https://etherscan.io/address/${row.token.address}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {row.token.address.slice(0, 8)}… ↗
                    </a>
                  </td>
                  <td>{token(row.balance, Number(row.token.decimals), 9)}</td>
                  <td>{token(row.underlyingValue, 9, 9)}</td>
                  <td>
                    {row.maturity
                      ? dateLabel(row.maturity, true)
                      : "Raw underlying"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="provenance">
          Implementation {data.spot.implementationAddress}
          <br />
          Runtime hash {data.spot.implementationCodeHash}
        </p>
      </details>
    </>
  );
}
