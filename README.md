# Observatory for SPOT

Observatory for SPOT is an unofficial static protocol dashboard for the AMPL /
SPOT ecosystem, with committed plaintext datasets, recorded Bill Broker
contract quotes, holder and liquidity analytics, browser tests, and Docker
packaging. Version `1.0.0` release datasets are pinned to Ethereum mainnet
block `25853823`, and each versioned feed records its own observation blocks.

## Contents

Routes: `/` (ecosystem overview, rebase calendar and collateral composition),
`/ampl` (rebase history with date filters), `/spot` (reserve composition,
maturity ladder, recorded bond state, pool-price and protocol-FMV history,
redemption calls), `/broker` (recorded contract quotes across trade
sizes in both directions, standard contract quotes), `/lp` (fixed LP-note
benchmark, transaction ledger and recorded LP exits with the contract's
post-withdrawal sale quote), `/stampl` (rollover vault history), `/learn`
(mechanism casebooks) and `/data` (provenance hub with downloads).

Datasets: release-block AMPL, SPOT and Broker files with CSV exports, the
recorded Broker quote grids (`broker-quotes.json` and `.csv`), and
content-addressed versioned feeds under `public/data/observatory` referenced
by `observatory-manifest.json`. Recorded quotes and analytics export as JSON or
CSV with their observation identity on every row.

Bill Broker quotes are never computed by this project: every swap quote, its
protocol fee and every redemption amount is an `eth_call` output of the
deployed contract at the release block, and figures labelled "derived" are
stated arithmetic on those recorded values. The liquidity-provider fee
reconciliation is bookkeeping on emitted Broker events and ERC-20 transfer
logs and uses no knowledge of the fee curve. Holder and liquidity analytics retain integer or rational
precision; display values are truncated or rounded as labelled. LP returns
compare the actual starting token basket using protocol valuations, without
assuming a 50/50 position. Unsupported source intervals remain explicitly
unavailable. See `docs/analytics-methodology.md` and `docs/data-notes.md`.

## Status and support

This repository is a fixed snapshot at its release commit. It is provided
as-is, without warranty of any kind, and nothing obliges anyone to
investigate, correct, modify, host, maintain, update or support it; any later
change is voluntary. Its known limitations are listed in
`docs/known-limitations.md`.

## Architecture boundary

The release is one strict TypeScript package using the Next.js App Router with
static export. Refresh tooling generates JSON and CSV files in
`public/data`; the browser reads those files and renders them. There is no
database, server API or client-side protocol model. The site is static; the
collector is optional local tooling.

`release/release.json` records the release version, block, and the environment
used for the acceptance run.

## Build

`package-lock.json` pins dependencies. The Docker build installs them through
Socket Firewall and uses Node.js 22. The version `1.0.0` acceptance run used
Ubuntu 24.04 x86-64, Docker Engine 29.1.3, and Docker Compose 2.40.3.

The Docker build checks that the committed third-party notices match the
installed dependency inventory, the detected bundled components and the
protocol-provenance record; a stale notice fails the build and is regenerated
with `npm run licenses:generate`. The inventory excludes host-selected platform
binaries, so it is identical on every platform. During acceptance, licence
banners preserved in the emitted browser chunks are reconciled against that
inventory.
Published feed files are content-addressed and the browser compares each file
with its manifest entry when loading; HTTPS is recommended for transport.

`./observatory acceptance` builds the pinned acceptance image and runs the test
phase without network access. It does not depend on host Node.js packages or
browser installations.

## Commands

The `observatory` wrapper accepts only these npm-script names:

```sh
./observatory up
./observatory dev
./observatory build
./observatory typecheck
./observatory lint
./observatory test
./observatory test:e2e
./observatory refresh
./observatory refresh:observatory --live
./observatory refresh:observatory --market-only
./observatory refresh:watch
./observatory conformance
./observatory verify:data
./observatory acceptance
./observatory package:release
./observatory export-static
```

`refresh`, `conformance` and `verify:data` use RPC endpoints supplied through
environment variables. `release/refresh-config.json` records the release
block, query settings and the recorded-quote grid definition. `verify:data`
regenerates the release-block JSON and CSV files, including the recorded quote
grids, and compares them byte for byte with the committed data. A release
refresh sets `REFRESH_GENERATED_AT` to the configured `generatedAt` so the
regenerated files reproduce the committed bytes.

`package:release` takes a full `RELEASE_COMMIT` value and passing check
reports in `artifacts`. It runs offline acceptance and creates source and
static-site archives, a release manifest, `SHA256SUMS`, and a combined release
bundle. `release/source-files.txt` lists the packaged source.

## Recorded Broker quotes

`public/data/broker-quotes.json` records, at the release block, the deployed
Bill Broker's answers to `computePerpToUSDSwapAmt` and
`computeUSDToPerpSwapAmt` for a grid of trade sizes in both directions, and to
`computeRedemptionAmts` for a grid of LP amounts. For each LP amount that
returns SPOT, the contract is also asked to quote the sale of all of that SPOT
against the reserves left after the withdrawal, by passing those reserves as
the reserve-state argument. The grid is one whole token times quarter-decade
steps, stopping after two consecutive unavailable quotes or forty points; LP
amounts are one LP unit and fixed fractions of LP supply. Sizes between grid
points are not called and are not estimated. The one-unit points must
reproduce the standard quotes in `broker-state.json`, which the refresh
enforces.

## Versioned refresh and local background collection

`refresh:observatory` preserves the original release files and publishes
independently timestamped, content-addressed feeds plus
`public/data/observatory-manifest.json`. It stages and validates all new files
before one atomic manifest replacement. On a source failure the old file is
retained with a failure status. The browser polls published files once per
minute and labels observations older than 36 hours as historical.

Configure `ETHEREUM_RPC_URL` securely in the process environment; an optional
`AMPL_LOG_RPC_URL` can use a separate log provider. Do not place credentials in
source or browser configuration. `RPC_REQUEST_INTERVAL_MS` paces the
collector's requests to a no-key public endpoint exactly as it does for the
release refresh; feeds run in parallel but share one scheduler per endpoint.
Default history is 90 days sampled every seven days. `OBSERVATORY_HISTORY_DAYS` and `OBSERVATORY_SAMPLE_INTERVAL_DAYS` adjust
this range; samples are supported block observations rather than invented daily
values. `--bootstrap` can package the original release datasets without
claiming to have refreshed them.

`--market-only` uses the same RPC configuration and requires `RELEASE_BLOCK`
(with optional `RELEASE_BLOCK_HASH`) to pin collection. The default market range
is 90 completed UTC days ending at midnight before or at that block. It reads
the identity of the fixed Uniswap V3 SPOT/USDC 1% pool and its `Swap` logs
directly from Ethereum through the configured RPC endpoint.

Market payload schema version 2 records the final post-swap pool price of each
day in **USDC per SPOT**, with the raw event fields and summed absolute USDC
turnover. Protocol FMV remains **USD per SPOT** in a separate aligned panel;
there is no USDC-to-USD conversion. Quiet days explicitly have no price. Zero
turnover and zero active liquidity remain visible and qualified. A recorded
pool price is historical and does not establish an executable quote.

Incremental collection checks the prior boundary and rescans the last completed
day before publishing. A failed scan retains only previously published on-chain
coverage, labelled incomplete. The manifest and the other feeds use payload
schema version 1.

`refresh:watch` runs the collector repeatedly, retaining data on errors and
stopping gracefully on SIGINT or SIGTERM. `OBSERVATORY_REFRESH_MINUTES` defaults
to 60. A collector lock prevents duplicate background workers; after an abrupt
process kill, inspect that no collector is running before removing its lock.
`OBSERVATORY_DATA_DIRECTORY` can target a mounted data directory. For an existing
static export, target `out/data` so the served data changes without a UI rebuild.

An optional Compose overlay shares the data volume with the static server:

```sh
docker compose -f compose.yaml -f compose.refresh.yaml up --build
```

The regular `./observatory up` remains a static snapshot. No background service
is started merely by installing the project. A full archive backfill can require
many provider calls, especially the transfer ledger, and every feed reports its
actual coverage.

## Licensing

Copyright (c) 2026 Observatory for SPOT contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. It is distributed WITHOUT ANY WARRANTY, without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. The full
license text is in `LICENSE` (SPDX: `GPL-3.0-or-later`).

Third-party license notices are in `THIRD-PARTY-NOTICES.txt`. Its PROTOCOL
PROVENANCE section states which protocol figures are recorded contract outputs
rather than computed, identifies the GPL-licensed upstream source referenced
by the one remaining protocol reconstruction (the legacy AMPL target-rate
derivation), and states the licence terms that apply to any portion found to
derive from it; the record is maintained in `release/protocol-provenance.txt`
with the upstream notice in `release/upstream-licenses/`. See
`docs/data-notes.md` for the method.

Corresponding source for a release is the tagged commit linked from the site
footer and the `observatory-for-spot-<version>-source.tar.gz` archive that
`package:release` places under `out/source/` next to its SHA-256 sidecar. The
third-party packages compiled into the browser bundles are the versions pinned
in `package-lock.json`, obtainable from the npm registry; their licence texts
are reproduced in `THIRD-PARTY-NOTICES.txt`.

No container images are published; every image tag in `compose.yaml`,
`compose.refresh.yaml` and the `observatory` wrapper is local.

Names and affiliation are addressed in `TRADEMARKS.md`.
