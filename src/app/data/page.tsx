"use client";
import { RefreshWarning } from "../../components/dataset-banner";
import { useNow } from "../../components/use-now";
import { useDataset } from "../../components/use-dataset";
import {
  observatoryManifestSchema,
  OBSERVATORY_FEEDS,
  type ObservatoryFeed,
} from "../../data/observatory-schemas";
import { dateLabel } from "../../lib/display";
import {
  RELEASE_TAG,
  RELEASE_TREE_URL,
  SOURCE_ARCHIVE_CHECKSUM_PATH,
  SOURCE_ARCHIVE_NAME,
  SOURCE_ARCHIVE_PATH,
} from "../../lib/repository";
import { FeedEmpty } from "../../components/feed-status";
const names: Record<ObservatoryFeed, { title: string; text: string }> = {
  "ampl-history": {
    title: "AMPL rebase history",
    text: "Policy events paired with resulting token-supply events.",
  },
  "spot-history": {
    title: "SPOT state history",
    text: "Collateral, supply, deviation and protocol FMV at supported blocks.",
  },
  "broker-history": {
    title: "Broker LP history",
    text: "Reserves, LP supply, protocol valuations and ordered events.",
  },
  "stampl-history": {
    title: "stAMPL state history",
    text: "Vault exchange rate, supply and funding-policy inputs.",
  },
  collateral: {
    title: "Collateral & bonds",
    text: "Reserve assets, virtual bond collateral, senior claims and maturity state.",
  },
  "exit-inputs": {
    title: "Redemption & withdrawal calls",
    text: "Recorded contract calls and supported LP withdrawal inputs.",
  },
  "spot-market": {
    title: "SPOT pool prices · USDC",
    text: "Uniswap V3 Swap events, scanned daily block ranges and explicit quiet days. Prices are USDC per SPOT, with pool identity and last-swap details.",
  },
};
const reasons: Record<string, string> = {
  "rpc-unavailable": "Ethereum RPC is unavailable or not configured.",
  "read-failed": "The latest source read failed.",
  "implementation-unsupported":
    "The deployed implementation is outside the supported interface set.",
  "history-incomplete": "Historical coverage is incomplete.",
  "market-source-unavailable": "The market source was unavailable.",
  "no-verified-observations": "No observations were published for this feed.",
  "archived-snapshot": "Packaged historical data; no new source observation.",
};
export default function DataPage() {
  const now = useNow();
  const manifest = useDataset(
    "observatory-manifest.json",
    observatoryManifestSchema,
  );
  return (
    <>
      <RefreshWarning
        failed={manifest.status === "ready" && manifest.refreshError === true}
      />
      <section className="hero">
        <div className="eyebrow">Sources / Coverage / Reproducibility</div>
        <h1>Sources you can inspect.</h1>
        <p className="lede">
          Every feed has its own observation time and coverage. A refresh
          failure preserves the last published file and remains visible here.
        </p>
      </section>
      {manifest.status === "loading" ? (
        <p className="loading">Reading the publication manifest…</p>
      ) : manifest.status === "error" ? (
        <FeedEmpty title="The extended manifest is unavailable">
          The packaged release files below remain available. Reload after a
          successful data refresh to inspect the versioned feeds.
        </FeedEmpty>
      ) : (
        <>
          <div className="status">
            <span className="dot" />
            <span>
              Manifest published {dateLabel(manifest.data.generatedAt, true)}{" "}
              UTC · schema v{manifest.data.schemaVersion}
            </span>
            <a href="/data/observatory-manifest.json" download>
              Download manifest
            </a>
          </div>
          <section className="grid three section">
            {OBSERVATORY_FEEDS.map((key) => {
              const state = manifest.data.feeds[key],
                old =
                  !state.observedAt ||
                  !now ||
                  now - Date.parse(state.observedAt) > 36 * 3_600_000;
              return (
                <article className="card data-feed" key={key}>
                  <div className="section-title">
                    <h3>{names[key].title}</h3>
                    <span
                      className={`badge ${state.status !== "ok" || old ? "warning-text" : "positive"}`}
                    >
                      {state.status === "ok"
                        ? old
                          ? "Historical"
                          : "Available"
                        : state.status === "error"
                          ? "Refresh failed"
                          : "Unsupported"}
                    </span>
                  </div>
                  <p className="small muted">{names[key].text}</p>
                  <div className="small">
                    <strong>
                      {state.rowCount.toLocaleString("en-US")}{" "}
                      {state.rowCount === 1 ? "observation" : "observations"}
                    </strong>
                    <p className="muted">
                      {key === "spot-market" ? "Scanned through" : "Observed"}:{" "}
                      {state.observedAt
                        ? `${dateLabel(state.observedAt, true)} UTC`
                        : "Unavailable"}
                      <br />
                      Last attempt: {dateLabel(state.attemptedAt, true)} UTC
                    </p>
                  </div>
                  {state.message ? (
                    <p className="small warning-text">
                      {reasons[state.message] ?? "Source unavailable."}
                      {state.path
                        ? " Last published observations retained."
                        : ""}
                    </p>
                  ) : null}
                  {state.coverage ? (
                    <p className="provenance">
                      Blocks {state.coverage.fromBlock}–{state.coverage.toBlock}
                    </p>
                  ) : null}
                  <div className="button-row">
                    {state.path ? (
                      <a
                        className="button-link secondary"
                        href={state.path}
                        download
                      >
                        Download versioned JSON
                      </a>
                    ) : (
                      <span className="muted small">
                        No file has been published.
                      </span>
                    )}
                    {key === "spot-market" ? (
                      <a className="text-link" href="/spot/#market">
                        Inspect pool activity & source ↗
                      </a>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </section>
        </>
      )}
      <section className="section grid two">
        <article className="card">
          <h2>Packaged release data</h2>
          <p className="muted small">
            These files preserve the original release snapshot independently of
            subsequent refreshed feeds. Their embedded block timestamps describe
            their age.
          </p>
          <div className="button-row">
            {[
              "meta",
              "ampl-rebases",
              "spot-health",
              "broker-state",
              "broker-quotes",
            ].map((name) => (
              <a
                className="button-link secondary"
                href={`/data/${name}.json`}
                download
                key={name}
              >
                {name}.json
              </a>
            ))}
          </div>
          <div className="button-row">
            {[
              "ampl-rebases",
              "spot-health",
              "broker-state",
              "broker-quotes",
            ].map((name) => (
              <a
                className="text-link"
                href={`/data/${name}.csv`}
                download
                key={name}
              >
                {name}.csv ↗
              </a>
            ))}
          </div>
        </article>
        <article className="card">
          <h2>How to read the files</h2>
          <p className="muted small">
            Contract feeds record the implementation identity at their
            observation blocks. Published files are named by their content
            hash. Broker quotes are recorded eth_call outputs of the deployed
            contract; nothing in the interface computes a quote.
          </p>
          <p className="muted small">
            Pool prices use the final recorded swap in each scanned UTC day. A
            day with no swap has no price; zero turnover is reported as zero.
            The pool quotes SPOT in USDC, while protocol FMV is a separate USD
            valuation.
          </p>
        </article>
      </section>
      <section className="card section" aria-label="Corresponding source">
        <h2>Corresponding source</h2>
        <p className="muted small">
          This interface is free software under GPL-3.0-or-later. The source
          that produced this build is the tagged release {RELEASE_TAG}; a
          packaged release also serves the same source archive and its SHA-256
          checksum from this site. Upstream protocol sources and their licence
          terms are listed in the third-party notices under PROTOCOL
          PROVENANCE.
        </p>
        <div className="button-row">
          <a
            className="button-link secondary"
            href={RELEASE_TREE_URL}
            rel="noreferrer"
          >
            Tagged source tree ↗
          </a>
          <a
            className="button-link secondary"
            href={SOURCE_ARCHIVE_PATH}
            download
          >
            {SOURCE_ARCHIVE_NAME}
          </a>
          <a className="text-link" href={SOURCE_ARCHIVE_CHECKSUM_PATH} download>
            SHA-256 checksum ↗
          </a>
          <a className="text-link" href="/THIRD-PARTY-NOTICES.txt">
            Third-party notices &amp; provenance ↗
          </a>
        </div>
      </section>
      <section className="card section">
        <h2>Refresh without a blank dashboard</h2>
        <p className="muted">
          Collectors update each source independently, validate its inputs, and
          write immutable files before replacing the manifest atomically. A
          failure retains the previous file and records a safe status. Browsers
          read the published static files without connecting to an RPC provider.
        </p>
        <p className="muted">
          A deployment republishes its feeds only when its operator runs the
          collector; nothing here refreshes on its own. The publication time
          above records when that last happened, and every observation older
          than 36 hours is labelled historical whether or not a collector is
          scheduled.
        </p>
        <div className="grid three section">
          <div>
            <h3>Observation time</h3>
            <p className="small muted">
              When the state was observed. Pool coverage uses the completed UTC
              day&rsquo;s end; the pool table shows the actual swap time.
              Historical data is labelled once it is more than 36 hours old.
            </p>
          </div>
          <div>
            <h3>Publication time</h3>
            <p className="small muted">
              When the manifest was assembled. Republishing an old observation
              does not make it fresh.
            </p>
          </div>
          <div>
            <h3>Coverage</h3>
            <p className="small muted">
              The indexed range and individual observations. Gaps, unsupported
              implementations and failed reads stay explicit.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
