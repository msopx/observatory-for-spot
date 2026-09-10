"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SpotMarketPoint } from "../data/observatory-schemas";
import { token, usd } from "../lib/display";
import { FeedEmpty, FeedStatus } from "./feed-status";
import { useObservatory } from "./use-observatory";

type PricePoint = { time: number; value: number | null };
const utc = (timestamp: string) =>
  new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC");
const chartPrice = (value: number) =>
  value !== 0 && Math.abs(value) < 0.0001
    ? value.toExponential(3)
    : value.toLocaleString("en-US", { maximumFractionDigits: 4 });
const poolPrice = (value: string) =>
  BigInt(value) > 0n && BigInt(value) < 1_000_000_000_000n
    ? (Number(value) / 1e18).toExponential(4)
    : token(value, 18, 6);

function PriceChart({
  points,
  domain,
  unit,
  color,
  name,
  id,
}: {
  points: PricePoint[];
  domain: [number, number];
  unit: string;
  color: string;
  name: string;
  id: string;
}) {
  return (
    <div
      className="chart market-price-chart"
      role="img"
      aria-label={`${name}, ${unit}, over the displayed observation range`}
      data-testid={id}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points}
          margin={{ left: 0, right: 18, top: 12, bottom: 8 }}
        >
          <CartesianGrid
            stroke="var(--border)"
            vertical={false}
            strokeDasharray="3 6"
          />
          <XAxis
            dataKey="time"
            type="number"
            domain={domain}
            allowDataOverflow
            minTickGap={55}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) =>
              new Date(Number(value)).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "short",
                timeZone: "UTC",
              })
            }
          />
          <YAxis
            width={82}
            domain={["auto", "auto"]}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value) => chartPrice(Number(value))}
          />
          <Tooltip
            labelFormatter={(value) =>
              utc(new Date(Number(value)).toISOString())
            }
            formatter={(value) => `${chartPrice(Number(value))} ${unit}`}
          />
          <Line
            name={name}
            type="linear"
            dataKey="value"
            stroke={color}
            strokeWidth={2.5}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DailyEvidence({ rows }: { rows: SpotMarketPoint[] }) {
  return (
    <details className="market-evidence section">
      <summary>Daily coverage & swaps</summary>
      <p className="small muted">
        Each row covers a scanned UTC day. The closing price is the pool’s
        marginal price after its final swap, not an average execution price.
        Quiet days do not carry forward an earlier price.
      </p>
      <div className="table-wrap market-daily-table">
        <table>
          <thead>
            <tr>
              <th>UTC day</th>
              <th>Pool close · USDC / SPOT</th>
              <th>Swaps</th>
              <th>USDC turnover</th>
              <th>Last swap</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((row) => (
              <tr
                key={row.timestamp}
                data-testid={`market-day-${row.periodStart.slice(0, 10)}`}
              >
                <td>
                  {row.periodStart.slice(0, 10)}
                  <small className="market-cell-note">
                    Ends {utc(row.timestamp)}
                  </small>
                </td>
                <td>
                  {row.priceQuote === null
                    ? "No price"
                    : poolPrice(row.priceQuote)}
                  <small
                    className={`market-cell-note ${row.swapCount === "0" || row.swapCount === "1" || row.lastSwap?.liquidity === "0" ? "warning-text" : "muted"}`}
                  >
                    {row.swapCount === "0"
                      ? "Quiet day · no swap"
                      : row.lastSwap?.liquidity === "0"
                        ? "Zero active liquidity at final swap"
                        : row.swapCount === "1"
                          ? "Single-swap close"
                          : "Final swap of the day"}
                  </small>
                </td>
                <td>{token(row.swapCount, 0, 0)}</td>
                <td>
                  {token(row.volumeQuote, 6, 6)}
                  <small className="market-cell-note">
                    {row.volumeQuote === "0"
                      ? "Zero USDC turnover"
                      : "Sum of absolute USDC swap amounts"}
                  </small>
                </td>
                <td>
                  <details>
                    <summary>
                      {row.lastSwap
                        ? "Inspect final swap"
                        : "Inspect scanned coverage"}
                    </summary>
                    <dl className="market-evidence-list">
                      <dt>Scanned blocks, inclusive</dt>
                      <dd>
                        {row.fromBlock}–{row.toBlock}
                      </dd>
                      <dt>Last scanned block hash</dt>
                      <dd>
                        <code>{row.toBlockHash}</code>
                      </dd>
                      {row.lastSwap ? (
                        <>
                          <dt>Actual last swap</dt>
                          <dd>
                            <time dateTime={row.lastSwap.timestamp}>
                              {utc(row.lastSwap.timestamp)}
                            </time>
                          </dd>
                          <dt>Transaction</dt>
                          <dd>
                            <a
                              href={`https://etherscan.io/tx/${row.lastSwap.transactionHash}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {row.lastSwap.transactionHash} ↗
                            </a>
                          </dd>
                          <dt>Block / transaction index / log index</dt>
                          <dd>
                            {row.lastSwap.blockNumber} /{" "}
                            {row.lastSwap.transactionIndex} /{" "}
                            {row.lastSwap.logIndex}
                          </dd>
                          <dt>Swap block hash</dt>
                          <dd>
                            <code>{row.lastSwap.blockHash}</code>
                          </dd>
                          <dt>Active liquidity after swap, raw L</dt>
                          <dd>{row.lastSwap.liquidity}</dd>
                          <dt>Square-root price / tick</dt>
                          <dd>
                            {row.lastSwap.sqrtPriceX96} / {row.lastSwap.tick}
                          </dd>
                          <dt>Token0 / token1 amounts, signed base units</dt>
                          <dd>
                            {row.lastSwap.amount0} / {row.lastSwap.amount1}
                          </dd>
                        </>
                      ) : (
                        <>
                          <dt>Recorded swaps</dt>
                          <dd>None in this fully scanned daily range.</dd>
                        </>
                      )}
                    </dl>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function SpotMarketHistory() {
  const market = useObservatory("spot-market");
  const history = useObservatory("spot-history");
  const data = market.status === "ready" ? market.data : null;
  const rows = data?.rows ?? [];
  const fmvRows = history.status === "ready" ? (history.data?.rows ?? []) : [];
  const lastDay = rows.at(-1);
  const latestPrice = [...rows]
    .reverse()
    .find((row) => row.priceQuote !== null);
  const latestSwap = [...rows]
    .reverse()
    .find((row) => row.lastSwap !== null)?.lastSwap;
  const latestFmv = [...fmvRows].reverse().find((row) => row.fmvUsd !== null);
  const totalSwaps = rows.reduce((sum, row) => sum + BigInt(row.swapCount), 0n);
  const totalVolume = rows.reduce(
    (sum, row) => sum + BigInt(row.volumeQuote),
    0n,
  );
  const quietDays = rows.filter((row) => row.swapCount === "0").length;
  const marketPoints = rows.map((row) => ({
    time: Date.parse(row.timestamp),
    value: row.priceQuote === null ? null : Number(row.priceQuote) / 1e18,
  }));
  const fmvPoints = fmvRows.map((row) => ({
    time: Date.parse(row.timestamp),
    value: row.fmvUsd === null ? null : Number(row.fmvUsd) / 1e18,
  }));
  const times = [...marketPoints, ...fmvPoints].map((point) => point.time);
  if (rows[0]) times.push(Date.parse(rows[0].periodStart));
  const firstTime = times.length ? Math.min(...times) : 0;
  const lastTime = times.length ? Math.max(...times) : 1;
  const domain: [number, number] = [
    firstTime,
    lastTime > firstTime ? lastTime : firstTime + 86_400_000,
  ];

  return (
    <section
      className="section market-history"
      id="market"
      aria-label="Pool prices and protocol valuation"
    >
      <div className="section-title">
        <div>
          <div className="eyebrow">Two sources, distinct units</div>
          <h2>Trading activity & protocol value</h2>
        </div>
        <span className="badge">Aligned dates · separate price scales</span>
      </div>
      <p className="muted">
        The pool exchanges SPOT for USDC. Protocol FMV values SPOT in USD. USDC
        is not assumed to equal one dollar, so these panels do not calculate a
        premium or discount.
      </p>
      <article
        className="card section market-price-panel"
        aria-label="Uniswap pool history"
      >
        <div className="section-title">
          <div>
            <div className="eyebrow">Observed on Ethereum · Uniswap V3</div>
            <h3>Pool price · USDC/SPOT</h3>
          </div>
          <span className="badge">USDC / SPOT</span>
        </div>
        <FeedStatus feed={market} label="Pool scan" />
        {market.status === "ready" &&
        market.state.path &&
        (market.state.status !== "ok" || market.refreshError) ? (
          <p className="market-activity-warning" role="alert">
            Coverage incomplete for the latest refresh. The last published
            daily history is retained; no new days are inferred.
          </p>
        ) : null}
        {data && lastDay ? (
          <>
            <div className="market-price-summary">
              <div>
                <div className="metric-label">Latest recorded pool close</div>
                <div className="metric-value">
                  {latestPrice?.priceQuote
                    ? `${poolPrice(latestPrice.priceQuote)} USDC / SPOT`
                    : "Unavailable"}
                </div>
                <p className="small muted">
                  {latestPrice?.lastSwap
                    ? `Price after swap at ${utc(latestPrice.lastSwap.timestamp)}`
                    : "No swap price in the scanned days."}
                </p>
              </div>
              <div>
                <div className="metric-label">Pool fee tier</div>
                <div className="market-summary-value">
                  {token(BigInt(data.pool.fee) * 100n, 6, 2)}%
                </div>
                <p className="small muted">
                  The marginal pool price excludes execution fees, price impact
                  and gas.
                </p>
              </div>
            </div>
            {latestPrice ? (
              <PriceChart
                points={marketPoints}
                domain={domain}
                unit="USDC / SPOT"
                color="var(--blue)"
                name="Pool close"
                id="pool-price-chart"
              />
            ) : (
              <FeedEmpty title="No pool prices in this scanned range">
                Scanned activity remains available in the table below. A quiet
                day supplies no price.
              </FeedEmpty>
            )}
            <div className="market-activity-grid">
              <div>
                <span className="metric-label">Scanned coverage</span>
                <strong>{rows.length} UTC days</strong>
                <small>
                  {rows[0]!.periodStart.slice(0, 10)} through{" "}
                  {lastDay.periodStart.slice(0, 10)}
                </small>
              </div>
              <div>
                <span className="metric-label">Recorded swaps</span>
                <strong>{token(totalSwaps, 0, 0)}</strong>
                <small>
                  {quietDays} quiet {quietDays === 1 ? "day" : "days"} · no
                  price carried forward
                </small>
              </div>
              <div>
                <span className="metric-label">USDC turnover</span>
                <strong>{token(totalVolume, 6, 6)} USDC</strong>
                <small>
                  {totalVolume === 0n
                    ? "Zero turnover across the scanned range"
                    : "Absolute quote-token flow across recorded swaps"}
                </small>
              </div>
            </div>
            <p className="small market-last-swap">
              <strong>Actual last swap:</strong>{" "}
              {latestSwap ? (
                <time dateTime={latestSwap.timestamp}>
                  {utc(latestSwap.timestamp)}
                </time>
              ) : (
                "None in the scanned range"
              )}
              . The plotted date is the UTC day’s end, not the transaction time.
            </p>
            {totalSwaps < BigInt(rows.length) ? (
              <p className="market-activity-warning" role="status">
                Low observed activity: fewer than one swap per scanned day. This
                pool’s last price may be stale or unrepresentative.
              </p>
            ) : (
              <p className="muted small">
                This is one pool’s observed price. Single-swap days and limited
                trading can make it unrepresentative of broader market
                conditions.
              </p>
            )}
            {latestSwap?.liquidity === "0" ? (
              <p className="market-activity-warning" role="status">
                The final recorded swap has zero active liquidity. Its marginal
                price does not establish available liquidity or an executable
                quote.
              </p>
            ) : null}
            <DailyEvidence rows={rows} />
            <details className="market-evidence section">
              <summary>Pool identity & source files</summary>
              <dl className="market-evidence-list">
                <dt>Source</dt>
                <dd>Ethereum mainnet · canonical Uniswap V3 Swap events</dd>
                <dt>Pool</dt>
                <dd>
                  <a
                    href={`https://etherscan.io/address/${data.pool.address}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {data.pool.address} ↗
                  </a>
                </dd>
                <dt>Factory</dt>
                <dd>{data.pool.factory}</dd>
                <dt>Base token</dt>
                <dd>
                  {data.pool.baseToken.symbol} · {data.pool.baseToken.address} ·{" "}
                  {data.pool.baseToken.decimals} decimals
                </dd>
                <dt>Quote token</dt>
                <dd>
                  {data.pool.quoteToken.symbol} · {data.pool.quoteToken.address}{" "}
                  · {data.pool.quoteToken.decimals} decimals
                </dd>
                <dt>Token0 / token1</dt>
                <dd>
                  {data.pool.token0} / {data.pool.token1}
                </dd>
                <dt>Tick spacing</dt>
                <dd>{data.pool.tickSpacing}</dd>
                <dt>Pool runtime hash</dt>
                <dd>
                  <code>{data.pool.codeHash}</code>
                </dd>
                <dt>Pool identity read at</dt>
                <dd>
                  Block {data.pool.verifiedAt.blockNumber} ·{" "}
                  {utc(data.pool.verifiedAt.timestamp)}
                  <br />
                  <code>{data.pool.verifiedAt.blockHash}</code>
                </dd>
                <dt>Scanned block range, inclusive</dt>
                <dd>
                  {rows[0]!.fromBlock}–{lastDay.toBlock}
                </dd>
              </dl>
              <p className="muted small">
                Liquidity in a Swap event is active liquidity in raw L units,
                not a token balance or a USD liquidity valuation. A marginal
                price recorded with zero active liquidity does not establish
                that a trade can execute there.
              </p>
            </details>
            {market.status === "ready" && market.state.path ? (
              <div className="button-row">
                <a
                  className="button-link secondary"
                  href={market.state.path}
                  download
                >
                  Download pool data JSON
                </a>
              </div>
            ) : null}
          </>
        ) : (
          <FeedEmpty
            title={
              market.status === "loading"
                ? "Loading on-chain pool data"
                : "On-chain pool history unavailable"
            }
          >
            A supported pool identity and complete daily log scans are needed.
            Protocol valuations are shown separately below.
          </FeedEmpty>
        )}
      </article>
      <article
        className="card section market-price-panel"
        aria-label="Protocol valuation history"
      >
        <div className="section-title">
          <div>
            <div className="eyebrow">Protocol oracle valuation</div>
            <h3>Protocol FMV · USD/SPOT</h3>
          </div>
          <span className="badge">USD / SPOT</span>
        </div>
        <FeedStatus feed={history} label="Protocol observations" />
        {latestFmv?.fmvUsd ? (
          <>
            <div className="metric-value">
              {usd(latestFmv.fmvUsd)} <small>per SPOT</small>
            </div>
            <p className="small muted">
              Observed {utc(latestFmv.timestamp)} · block{" "}
              {latestFmv.blockNumber}
            </p>
            <PriceChart
              points={fmvPoints}
              domain={domain}
              unit="USD / SPOT"
              color="var(--accent)"
              name="Protocol FMV"
              id="protocol-fmv-chart"
            />
            <p className="small muted">
              Protocol FMV is an oracle valuation at each recorded block, not an
              executable market price. Lines connect observed points; absent
              valuations remain gaps. The two panels share their date range and
              use separate price scales.
            </p>
            {history.status === "ready" && history.state.path ? (
              <div className="button-row">
                <a className="text-link" href={history.state.path} download>
                  Download protocol observations JSON
                </a>
              </div>
            ) : null}
          </>
        ) : (
          <FeedEmpty title="Protocol valuation history unavailable">
            Supported block observations with a protocol FMV are needed. Pool
            prices remain independent of this valuation feed.
          </FeedEmpty>
        )}
      </article>
    </section>
  );
}
