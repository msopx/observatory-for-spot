import type { SpotReserve } from "../data/schemas";
import { dateLabel, token } from "../lib/display";
const shades = [
  "var(--accent)",
  "var(--blue)",
  "var(--warning)",
  "#9cacca",
  "#a6b69b",
  "#b3a3b8",
];
export function CollateralComposition({
  reserves,
}: {
  reserves: SpotReserve[];
}) {
  const total = reserves.reduce(
    (sum, row) => sum + BigInt(row.underlyingValue),
    0n,
  );
  return (
    <>
      <div
        className="composition-bar"
        role="img"
        aria-label="SPOT reserves by AMPL underlying value"
      >
        {reserves.map((row, i) => (
          <span
            key={row.token.address}
            style={{
              width: `${total ? Number((BigInt(row.underlyingValue) * 10000n) / total) / 100 : 0}%`,
              background: shades[i % shades.length],
            }}
          />
        ))}
      </div>
      {reserves.map((row, i) => (
        <div className="composition-row" key={row.token.address}>
          <div>
            <i
              className="legend-dot"
              style={{ background: shades[i % shades.length] }}
            />
            {row.isUnderlying
              ? "Raw AMPL"
              : `Senior · ${row.maturity ? dateLabel(row.maturity) : "maturity unavailable"}`}
            <br />
            <small>{token(row.underlyingValue, 9)} AMPL value</small>
          </div>
          <strong>
            {total
              ? (
                  Number((BigInt(row.underlyingValue) * 10000n) / total) / 100
                ).toFixed(1)
              : "—"}
            %
          </strong>
        </div>
      ))}
    </>
  );
}
