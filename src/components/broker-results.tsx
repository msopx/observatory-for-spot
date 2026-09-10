import type { BrokerQuote, BrokerQuotesDataset } from "../data/schemas";
import { formatToken, formatWad } from "../lib/format";
import {
  averageOutputPerInputWad,
  deriveQuote,
  directionAssets,
  formatWadPercent,
  type QuoteDirection,
} from "../lib/recorded-quotes";
import { formatUnitsExact } from "../protocol";

export function tokenAmount(value: bigint, decimals: number, digits = 6) {
  const [whole, fraction] = formatToken(
    value.toString(),
    decimals,
    digits,
  ).split(".");
  return `${whole?.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction.replace(/0+$/, "")}`.replace(/\.$/, "") : ""}`;
}

const UNAVAILABLE_REASONS: Record<
  NonNullable<BrokerQuote["unavailableReason"]>,
  string
> = {
  "zero-output":
    "The contract returned an output of zero for this size. The recorded call does not say why; sizes the reserves cannot fill and amounts that round to zero both produce this outcome.",
  "contract-reverted": "The contract call reverted for this size.",
  "fixture-not-evaluated": "Fixture data; the contract was not called.",
};

/**
 * One recorded eth_call quote. The output, protocol fee and reserves are
 * contract values; the equal-value output and implied fee are arithmetic on
 * those values at the recorded prices and are labelled as derived.
 */
export function RecordedQuoteCard({
  title,
  dataset,
  direction,
  quote,
}: {
  title: string;
  dataset: BrokerQuotesDataset;
  direction: QuoteDirection;
  quote: BrokerQuote;
}) {
  const assets = directionAssets(dataset, direction);
  const input = BigInt(quote.inputAmount);
  if (!quote.available || quote.outputAmount === null) {
    return (
      <article className="card broker-quote-card">
        <div className="eyebrow">{title}</div>
        <h3>Quote unavailable</h3>
        <p className="broker-status-note">
          {quote.unavailableReason
            ? UNAVAILABLE_REASONS[quote.unavailableReason]
            : "The contract returned no quote."}{" "}
          Input: {tokenAmount(input, assets.inputDecimals)} {assets.inputSymbol}.
        </p>
      </article>
    );
  }
  const output = BigInt(quote.outputAmount);
  const protocolFee = BigInt(quote.protocolFeeAmount ?? "0");
  const derived = deriveQuote(dataset, direction, quote);
  const average = averageOutputPerInputWad(quote, assets);
  return (
    <article className="card broker-quote-card">
      <div className="eyebrow">{title}</div>
      <div
        className="broker-quote-value"
        title={`${formatUnitsExact(output, assets.outputDecimals)} ${assets.outputSymbol}`}
      >
        {tokenAmount(output, assets.outputDecimals)}{" "}
        <small>{assets.outputSymbol}</small>
      </div>
      <p className="muted">
        Recorded contract output for {tokenAmount(input, assets.inputDecimals)}{" "}
        {assets.inputSymbol} in.
      </p>
      <dl className="broker-stat-list">
        <div>
          <dt>Protocol fee (contract value)</dt>
          <dd>
            {tokenAmount(protocolFee, assets.outputDecimals)}{" "}
            {assets.outputSymbol}
          </dd>
        </div>
        <div>
          <dt>Average output per {assets.inputSymbol}</dt>
          <dd>
            {average === null ? "—" : formatWad(average.toString(), 6)}{" "}
            {assets.outputSymbol}
          </dd>
        </div>
        <div>
          <dt>Equal-value output at recorded prices (derived)</dt>
          <dd>
            {tokenAmount(derived.equalValueOutput, assets.outputDecimals)}{" "}
            {assets.outputSymbol}
          </dd>
        </div>
        <div>
          <dt>Implied fee vs equal value (derived)</dt>
          <dd
            className={
              derived.impliedFeeWad !== null && derived.impliedFeeWad < 0n
                ? "broker-fee-negative"
                : "broker-fee-positive"
            }
          >
            {derived.impliedFeeWad === null
              ? "—"
              : `${formatWadPercent(derived.impliedFeeWad)} ${
                  derived.impliedFeeWad < 0n ? "rebate" : "fee"
                }`}
          </dd>
        </div>
      </dl>
      <details className="broker-evidence">
        <summary>Integer values &amp; recorded reserves</summary>
        <dl className="broker-stat-list">
          <div>
            <dt>Input in base units</dt>
            <dd>{quote.inputAmount}</dd>
          </div>
          <div>
            <dt>Output in base units</dt>
            <dd>{quote.outputAmount}</dd>
          </div>
          <div>
            <dt>Protocol fee in base units</dt>
            <dd>{quote.protocolFeeAmount}</dd>
          </div>
          <div>
            <dt>Reserves passed to the call</dt>
            <dd>
              {tokenAmount(
                BigInt(dataset.reserveState.usdBalance),
                Number(dataset.usdToken.decimals),
              )}{" "}
              USDC ·{" "}
              {tokenAmount(
                BigInt(dataset.reserveState.spotBalance),
                Number(dataset.spotToken.decimals),
              )}{" "}
              SPOT
            </dd>
          </div>
          <div>
            <dt>Prices passed to the call</dt>
            <dd>
              ${formatWad(dataset.reserveState.usdPrice, 4)} USDC · $
              {formatWad(dataset.reserveState.spotPrice, 4)} SPOT
            </dd>
          </div>
          <div>
            <dt>Derivation</dt>
            <dd>
              equalValue = input × inputPrice × 10^outDecimals ÷ (outputPrice
              × 10^inDecimals); impliedFee = (equalValue − output) ÷
              equalValue
            </dd>
          </div>
        </dl>
      </details>
    </article>
  );
}
