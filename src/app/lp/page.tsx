"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  benchmarkLpNotes,
  fractionToWad,
  reconcileLpLedger,
  type Fraction,
  type LpBenchmark,
} from "../../analytics/lp";
import {
  createScenarioReport,
  importScenarioReport,
  lpBenchmarkInputSchema,
  lpLedgerInputSchema,
  replayAnalyticsScenario,
  serializeScenarioReport,
  type ScenarioReport,
} from "../../analytics/scenarios";
import { BrokerLpWithdrawal } from "../../components/broker-lp-withdrawal";
import { FeedEmpty, FeedStatus } from "../../components/feed-status";
import {
  brokerLpEndpoint,
  lpBenchmarkSeries,
  lpScenarioProvenance,
} from "../../components/lp-model";
import { LpLedgerPanel, LpLedgerResults } from "../../components/lp-ledger";
import {
  illustrativeLpNotes,
  lpChartDollars,
  lpDollars,
} from "../../components/lp-display";
import { MetricCard } from "../../components/metric-card";
import { useObservatory } from "../../components/use-observatory";
import type { BrokerHistoryPoint } from "../../data/observatory-schemas";
import { dateLabel, downloadFile, token } from "../../lib/display";
import {
  formatUnitsExact,
  parseDecimalUnits,
} from "../../protocol/fixed-point";

const ASSUMPTIONS = [
  "A fixed quantity of existing Broker LP notes is held across both observations; no external rewards or wallet cost basis are included.",
  "Reserve ownership is normalized by the observed LP total supply. Claims are kept as fractions before display.",
  "USDC and SPOT are valued using the protocol oracle and SPOT FMV at each observation. These are not market valuations or executable exit proceeds.",
  "The comparison basket is the USDC/SPOT mix attributable to the notes at the start, held unchanged and marked using the same ending prices.",
  "Entry and exit fees, gas, taxes and external incentive programs are excluded. The inventory-and-fee effect is not claimed as fee income.",
] as const;

const dollars = lpDollars;
const percentage = (value: Fraction | null) =>
  value === null ? "—" : `${token(fractionToWad(value) * 100n, 18, 3)}%`;
const errorMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "The selected observations could not be evaluated.";

function Results({ result }: { result: LpBenchmark }) {
  return (
    <>
      <div className="grid three section">
        <MetricCard
          label="Starting reserve value"
          value={dollars(result.startValue)}
          detail="Your starting share of USDC + SPOT"
        />
        <MetricCard
          label="Ending LP reserve value"
          value={dollars(result.endValue)}
          detail="Same number of notes, ending reserves and supply"
        />
        <MetricCard
          label="Ending value if held"
          value={dollars(result.holdingEndValue)}
          detail="Your starting asset basket, held unchanged"
        />
      </div>
      <div className="grid four section">
        <MetricCard
          label="LP holding-period return"
          value={percentage(result.holdingPeriodReturn)}
          detail="Total change in protocol-FMV marked value"
        />
        <MetricCard
          label="Holding basket return"
          value={percentage(result.holdingBasketReturn)}
          detail="Change from the prices of the starting assets"
        />
        <MetricCard
          label="LP minus holding"
          value={percentage(result.excessReturn)}
          detail="Percentage points of starting value"
        />
        <MetricCard
          label="Inventory & fee effect"
          value={dollars(result.inventoryAndFeeEffect)}
          detail="LP ending value minus the holding basket"
        />
      </div>
    </>
  );
}

function observedLabel(point: BrokerHistoryPoint) {
  return `${dateLabel(point.timestamp, true)} UTC · #${point.blockNumber}`;
}

export default function LpPage() {
  const feed = useObservatory("broker-history");
  const [startBlock, setStartBlock] = useState("");
  const [endBlock, setEndBlock] = useState("");
  const [enteredAmount, setAmount] = useState<string | null>(null);
  const [reportMessage, setReportMessage] = useState("");
  const [reportError, setReportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<{
    report: ScenarioReport;
    result: LpBenchmark;
  } | null>(null);
  const [importedLedger, setImportedLedger] = useState<{
    report: ScenarioReport;
    result: ReturnType<typeof reconcileLpLedger>;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const rows = useMemo(
    () =>
      feed.status !== "ready" || !feed.data
        ? []
        : [...feed.data.rows].sort((a, b) =>
            BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1,
          ),
    [feed],
  );
  const start =
    rows.find((point) => point.blockNumber === startBlock) ?? rows[0];
  const end =
    rows.find((point) => point.blockNumber === endBlock) ?? rows.at(-1);
  const amount =
    enteredAmount ??
    illustrativeLpNotes(
      rows.map((point) => point.lpSupply),
      start?.lpDecimals ?? "18",
    ) ??
    "";
  const selection = useMemo(() => {
    if (!start || !end || rows.length < 2) return null;
    try {
      if (BigInt(start.lpDecimals) > 36n)
        throw new Error("LP token precision is unsupported");
      const lpAmount = parseDecimalUnits(amount, BigInt(start.lpDecimals));
      const inputs = {
        start: brokerLpEndpoint(start),
        end: brokerLpEndpoint(end),
        lpAmount,
      };
      return {
        result: benchmarkLpNotes(inputs),
        inputs,
        series: lpBenchmarkSeries(rows, start, end, lpAmount),
        error: null,
      };
    } catch (error) {
      return {
        result: null,
        inputs: null,
        series: [],
        error: errorMessage(error),
      };
    }
  }, [start, end, rows, amount]);
  const chart =
    selection?.series.map((point) => ({
      timestamp: Date.parse(point.timestamp),
      block: point.blockNumber,
      lp: Number(point.lpValue.numerator) / Number(point.lpValue.denominator),
      hold:
        Number(point.holdingValue.numerator) /
        Number(point.holdingValue.denominator),
    })) ?? [];

  async function exportReport() {
    if (
      !selection?.inputs ||
      !selection.result ||
      !start ||
      !end ||
      feed.status !== "ready" ||
      !feed.state.contentHash
    )
      return;
    setBusy(true);
    setReportError("");
    setReportMessage("");
    try {
      const report = await createScenarioReport({
        modelVersion: "fixed-lp-notes-v1",
        inputs: selection.inputs,
        expectedOutputs: selection.result,
        assumptions: ASSUMPTIONS,
        provenance: lpScenarioProvenance(start, end, feed.state.contentHash),
      });
      downloadFile(
        "observatory-lp-scenario.json",
        serializeScenarioReport(report),
      );
      setReportMessage(
        "Scenario exported with inputs, outputs, assumptions and source identities.",
      );
    } catch (error) {
      setReportError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function importReport(file: File) {
    setBusy(true);
    setReportError("");
    setReportMessage("");
    setImported(null);
    setImportedLedger(null);
    try {
      if (file.size > 2_000_000)
        throw new Error("Choose a scenario JSON smaller than 2 MB.");
      const report = await importScenarioReport(await file.text());
      if (
        !["fixed-lp-notes-v1", "broker-balance-ledger-v1"].includes(
          report.payload.modelVersion,
        )
      )
        throw new Error(
          "This page accepts LP benchmark and reconciliation scenarios. Open the matching tool for other scenario types.",
        );
      const replay = await replayAnalyticsScenario(report);
      if (!replay.matchesExpected)
        throw new Error(
          "The recomputed results differ from the report. This scenario has not been loaded.",
        );
      if (report.payload.modelVersion === "broker-balance-ledger-v1") {
        const inputs = lpLedgerInputSchema.parse(report.payload.inputs);
        setImportedLedger({ report, result: reconcileLpLedger(inputs) });
      } else {
        const inputs = lpBenchmarkInputSchema.parse(report.payload.inputs);
        setImported({ report, result: benchmarkLpNotes(inputs) });
      }
      setReportMessage(
        "Scenario loaded and all outputs reproduced from its inputs. Imported chain observations are self-declared.",
      );
    } catch (error) {
      setReportError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const eventsInPeriod =
    feed.status === "ready" && feed.data && start && end
      ? feed.data.events.filter(
          (event) =>
            BigInt(event.blockNumber) > BigInt(start.blockNumber) &&
            BigInt(event.blockNumber) <= BigInt(end.blockNumber),
        )
      : [];

  return (
    <>
      <section className="hero hero-wide">
        <div>
          <div className="eyebrow">Liquidity / historical results</div>
          <h1>Did liquidity pay off?</h1>
          <p className="lede">
            Follow a fixed number of Broker LP notes. Compare their reserve
            value with simply holding the assets they represented at the
            start.
          </p>
        </div>
        <span className="badge">Protocol FMV · existing notes</span>
      </section>
      <FeedStatus feed={feed} label="Broker history" />
      <section className="card section">
        <div className="section-title">
          <h2>Choose your observations</h2>
          <Link href="#withdrawal">Explore withdrawal outcomes ↗</Link>
        </div>
        {rows.length >= 2 && start && end ? (
          <div className="grid three">
            <label>
              Starting observation
              <select
                aria-label="Starting observation"
                value={start.blockNumber}
                onChange={(event) => setStartBlock(event.target.value)}
              >
                {rows.map((point) => (
                  <option key={point.blockNumber} value={point.blockNumber}>
                    {observedLabel(point)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Ending observation
              <select
                aria-label="Ending observation"
                value={end.blockNumber}
                onChange={(event) => setEndBlock(event.target.value)}
              >
                {rows.map((point) => (
                  <option key={point.blockNumber} value={point.blockNumber}>
                    {observedLabel(point)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Existing LP notes
              <input
                aria-label="Existing LP notes"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                autoComplete="off"
              />
            </label>
          </div>
        ) : (
          <FeedEmpty
            title={
              feed.status === "loading"
                ? "Loading historical observations"
                : "Two published observations are needed"
            }
          >
            <p>
              LP results require reserve balances, LP supply and valid valuation
              prices at both endpoints. Published observations will appear here
              when that data is available.
            </p>
          </FeedEmpty>
        )}
        {rows.length >= 2 && (
          <p className="muted small">
            The default is an illustrative position: 1% of the smallest observed
            LP supply, with a minimum of one base unit. Enter your own amount to
            explore your notes.
          </p>
        )}
        <p className="muted small">
          Period returns use observed prices and your actual starting asset mix.
          Values exclude withdrawal fees, gas and external rewards.{" "}
          <Link className="text-link" href="/data/">
            View coverage ↗
          </Link>
        </p>
        {selection?.error && (
          <p className="error" role="alert">
            {selection.error}
          </p>
        )}
      </section>
      {selection?.result && start && end && (
        <>
          <Results result={selection.result} />
          <section className="card section">
            <div className="section-title">
              <h2>LP notes and the holding basket</h2>
              <span className="badge">{chart.length} observed points</span>
            </div>
            <div
              className="chart tall"
              role="img"
              aria-label="Protocol FMV in US dollars for LP notes and the unchanged starting asset basket"
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chart}
                  margin={{ top: 15, right: 15, left: 5, bottom: 5 }}
                >
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={(value: number) =>
                      new Date(value).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        timeZone: "UTC",
                      })
                    }
                    minTickGap={45}
                  />
                  <YAxis
                    tickFormatter={lpChartDollars}
                    width={85}
                    domain={["auto", "auto"]}
                  />
                  <Tooltip
                    labelFormatter={(value) =>
                      dateLabel(new Date(Number(value)).toISOString(), true)
                    }
                    formatter={(value) => lpChartDollars(Number(value))}
                  />
                  <Legend />
                  <Line
                    name="LP notes · protocol FMV"
                    dataKey="lp"
                    type="linear"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                    isAnimationActive={false}
                  />
                  <Line
                    name="Starting basket · protocol FMV"
                    dataKey="hold"
                    type="linear"
                    stroke="var(--blue)"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={{ r: 2 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="muted small">
              Lines connect observations; they do not fill gaps with measured
              daily returns. These marks can differ from traded market prices
              and available USDC on exit.
            </p>
          </section>
          <section className="grid two section">
            <article className="card">
              <h2>What your notes represented</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Claim</th>
                      <th>Start</th>
                      <th>End</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>USDC</td>
                      <td>
                        {token(
                          selection.result.startClaim.usdc.numerator /
                            selection.result.startClaim.usdc.denominator,
                          6,
                          6,
                        )}
                      </td>
                      <td>
                        {token(
                          selection.result.endClaim.usdc.numerator /
                            selection.result.endClaim.usdc.denominator,
                          6,
                          6,
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td>SPOT</td>
                      <td>
                        {token(
                          selection.result.startClaim.spot.numerator /
                            selection.result.startClaim.spot.denominator,
                          9,
                          9,
                        )}
                      </td>
                      <td>
                        {token(
                          selection.result.endClaim.spot.numerator /
                            selection.result.endClaim.spot.denominator,
                          9,
                          9,
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td>LP total supply</td>
                      <td>
                        {token(start.lpSupply, Number(start.lpDecimals), 4)}
                      </td>
                      <td>{token(end.lpSupply, Number(end.lpDecimals), 4)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                Reserve ownership is normalized by total LP supply, so other
                users’ deposits are not counted as your returns. Sub-unit claims
                remain fractions in the export.
              </p>
            </article>
            <article className="card">
              <h2>Where the value changed</h2>
              <div className="quote-pair">
                <span>
                  Starting asset price effect
                  <small>Holding basket end value minus start value</small>
                </span>
                <strong>{dollars(selection.result.assetPriceEffect)}</strong>
              </div>
              <div className="quote-pair">
                <span>
                  Inventory & fee effect
                  <small>LP end value minus holding basket end value</small>
                </span>
                <strong>
                  {dollars(selection.result.inventoryAndFeeEffect)}
                </strong>
              </div>
              <div className="quote-pair">
                <span>
                  Total value change
                  <small>Sum of the two effects above</small>
                </span>
                <strong>{dollars(selection.result.valueChange)}</strong>
              </div>
            </article>
          </section>
          <LpLedgerPanel
            ledger={feed.status === "ready" ? feed.data?.ledger : null}
            start={start}
            end={end}
            sourceHash={feed.status === "ready" ? feed.state.contentHash : null}
            eventCount={eventsInPeriod.length}
          />
        </>
      )}
      <section className="card section">
        <h2>Reproduce this result</h2>
        <p className="muted small">
          Export a scenario or import an earlier report. Imports are
          recalculated locally from their recorded inputs.
        </p>
        <div className="button-row">
          <button
            disabled={busy || !selection?.result}
            onClick={() => void exportReport()}
          >
            Export scenario
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            Import LP scenario
          </button>
          <input
            ref={fileInput}
            hidden
            type="file"
            accept="application/json,.json"
            aria-label="Import LP scenario"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importReport(file);
              event.target.value = "";
            }}
          />
        </div>
        {reportMessage && (
          <p className="positive small" role="status">
            {reportMessage}
          </p>
        )}
        {reportError && (
          <p className="error" role="alert">
            {reportError}
          </p>
        )}
      </section>
      {imported && (
        <section className="section">
          <div className="section-title">
            <h2>Imported scenario · reproduced locally</h2>
            <button className="secondary" onClick={() => setImported(null)}>
              Close imported result
            </button>
          </div>
          <p className="warning-text small">
            The file’s results reproduce from its inputs. Its chain observations
            are self-declared and were not compared with the published feed.
          </p>
          <Results result={imported.result} />
          <details>
            <summary>Imported inputs, assumptions and provenance</summary>
            <pre className="provenance">
              {serializeScenarioReport(imported.report)}
            </pre>
          </details>
        </section>
      )}
      {importedLedger && (
        <section className="card section">
          <div className="section-title">
            <h2>Imported ledger · reproduced locally</h2>
            <button
              className="secondary"
              onClick={() => setImportedLedger(null)}
            >
              Close imported ledger
            </button>
          </div>
          <p className="warning-text small">
            Imported source observations are self-declared and were not re-read
            from the chain.
          </p>
          <LpLedgerResults result={importedLedger.result} lpDecimals={null} />
          <details>
            <summary>Full imported ledger</summary>
            <pre className="provenance">
              {serializeScenarioReport(importedLedger.report)}
            </pre>
          </details>
        </section>
      )}
      <BrokerLpWithdrawal />
      <details>
        <summary>How this comparison works</summary>
        <ul className="muted small">
          {ASSUMPTIONS.map((assumption) => (
            <li key={assumption}>{assumption}</li>
          ))}
        </ul>
        <p className="muted small">
          Returns are shown for the selected period, without annualization. This
          benchmark does not reconstruct a wallet’s acquisition cost, transfers
          or tax basis. If a fixed note amount exceeds observed supply, the
          scenario is rejected.
        </p>
        {selection?.inputs && start && (
          <p className="provenance">
            Notes:{" "}
            {formatUnitsExact(
              selection.inputs.lpAmount,
              BigInt(start.lpDecimals),
            )}
            . Model: fixed-lp-notes-v1. Interval: block{" "}
            {selection.inputs.start.blockNumber.toString()} through{" "}
            {selection.inputs.end.blockNumber.toString()}.
          </p>
        )}
      </details>
    </>
  );
}
