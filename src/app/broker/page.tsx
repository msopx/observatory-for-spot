"use client";
import Link from "next/link";
import { DatasetBanner, RefreshWarning } from "../../components/dataset-banner";
import { MetricCard } from "../../components/metric-card";
import { RecordedBrokerQuotes } from "../../components/recorded-broker-quotes";
import { tokenAmount } from "../../components/broker-results";
import { useDataset } from "../../components/use-dataset";
import { brokerStateDatasetSchema } from "../../data/schemas";
import { downloadFile } from "../../lib/display";
import { formatWad } from "../../lib/format";

export default function BrokerPage() {
  const broker = useDataset("broker-state.json", brokerStateDatasetSchema);
  if (broker.status === "loading") return <p>Loading Broker liquidity…</p>;
  if (broker.status === "error") return <p className="error">{broker.error}</p>;
  const data = broker.data;
  return (
    <>
      <RefreshWarning failed={broker.refreshError === true} />
      <section className="hero">
        <div className="eyebrow">Bill Broker · liquidity</div>
        <h1>What the Broker quoted.</h1>
        <p className="lede">
          Recorded contract quotes for SPOT buys and sells across trade sizes,
          read from the deployed Bill Broker at the release block. Nothing here
          is modelled.
        </p>
      </section>
      <DatasetBanner
        status={data.metadata.status === "release" ? "release" : "fixture"}
        blockNumber={data.metadata.blockNumber}
        blockHash={data.metadata.blockHash}
        {...(data.metadata.blockTimestamp
          ? { timestamp: data.metadata.blockTimestamp }
          : {})}
      />
      <div className="section grid three">
        <MetricCard
          label="USDC in Broker"
          value={`${tokenAmount(BigInt(data.reserveState.usdBalance), Number(data.usdToken.decimals), 2)} USDC`}
        />
        <MetricCard
          label="SPOT in Broker"
          value={`${tokenAmount(BigInt(data.reserveState.spotBalance), Number(data.spotToken.decimals), 2)} SPOT`}
        />
        <MetricCard
          label="Inventory value ratio"
          value={formatWad(data.assetRatio, 3)}
          detail="USDC value divided by SPOT protocol value"
        />
      </div>
      <RecordedBrokerQuotes
        indexedSnapshot={{
          blockNumber: data.metadata.blockNumber,
          timestamp: data.metadata.blockTimestamp,
        }}
      />
      <section className="section grid two">
        <article className="card">
          <div className="eyebrow">Holding LP notes?</div>
          <h2>Exiting LP returns two assets.</h2>
          <p>
            Broker LP redemption returns a proportional amount of USDC and SPOT
            after the burn fee. The recorded LP exits also record the
            contract&rsquo;s quote for selling that SPOT into the smaller,
            post-withdrawal reserves.
          </p>
          <Link href="/lp/#withdrawal">See recorded LP exits ↗</Link>
        </article>
        <article className="card">
          <div className="eyebrow">Mechanics</div>
          <h2>Why collateral rotates.</h2>
          <p>
            Two short casebooks explain how SPOT&rsquo;s collateral vintages
            mature and roll, and how backing, redemption and a Broker exit
            answer different questions.
          </p>
          <Link href="/learn/">Read the casebooks ↗</Link>
        </article>
      </section>
      <details className="section card broker-evidence">
        <summary>Snapshot details & standard contract quotes</summary>
        <p className="muted">
          Observed {data.metadata.blockTimestamp ?? "date unavailable"}.
          Protocol FMV is the pricing input to Broker; it is distinct from an
          external market price.
        </p>
        <div className="grid two section">
          <MetricCard
            label="USDC oracle price"
            value={`$${formatWad(data.reserveState.usdPrice, 4)}`}
          />
          <MetricCard
            label="SPOT protocol FMV"
            value={`$${formatWad(data.reserveState.spotPrice, 4)}`}
          />
          {([data.quotes.usdToSpot, data.quotes.spotToUsd] as const).map(
            (quote, index) => (
              <MetricCard
                key={index}
                label={
                  index === 0
                    ? "1 USDC → SPOT · contract call"
                    : "1 SPOT → USDC · contract call"
                }
                value={
                  quote.available && quote.outputAmount !== null
                    ? `${tokenAmount(BigInt(quote.outputAmount), Number(index === 0 ? data.spotToken.decimals : data.usdToken.decimals))} ${index === 0 ? "SPOT" : "USDC"}`
                    : "Unavailable"
                }
                detail={
                  quote.unavailableReason ??
                  "Standard quote recorded in the dataset"
                }
              />
            ),
          )}
        </div>
        <dl className="broker-stat-list">
          <div>
            <dt>Broker contract</dt>
            <dd>
              <a href={`https://etherscan.io/address/${data.brokerAddress}`}>
                {data.brokerAddress}
              </a>
            </dd>
          </div>
          <div>
            <dt>Implementation</dt>
            <dd>{data.implementationAddress}</dd>
          </div>
          <div>
            <dt>Implementation code hash</dt>
            <dd>{data.implementationCodeHash}</dd>
          </div>
          <div>
            <dt>Snapshot hash</dt>
            <dd>{data.metadata.blockHash}</dd>
          </div>
          <div>
            <dt>Mint / burn fee</dt>
            <dd>
              {formatWad(
                (BigInt(data.parameters.fees.mintFeePercent) * 100n).toString(),
              )}
              % /{" "}
              {formatWad(
                (BigInt(data.parameters.fees.burnFeePercent) * 100n).toString(),
              )}
              %
            </dd>
          </div>
        </dl>
        <button
          className="secondary"
          type="button"
          onClick={() =>
            downloadFile(
              "broker-state-viewed.json",
              JSON.stringify(data, null, 2) + "\n",
            )
          }
        >
          Export viewed dataset
        </button>
      </details>
    </>
  );
}
