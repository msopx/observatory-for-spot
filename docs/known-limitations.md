# Known limitations

Observatory for SPOT 1.0.0 is a fixed snapshot at its release commit. It is
provided as-is, without warranty, and nothing obliges anyone to address the
items below; they are recorded so that a reader knows what this release does
and does not do.

## Data sources

- All chain data is read from public Ethereum JSON-RPC endpoints chosen by the
  operator. No data is signed by a protocol party, and the project does not
  operate a node.
- The release datasets under `public/data` are pinned to block `25853823` and
  are the only files that `verify:data` regenerates and compares byte for
  byte. The versioned feeds under `public/data/observatory` record their own
  observation blocks and are not covered by that check.
- The recorded Bill Broker quote grid (`broker-quotes.json`) is fixed at the
  release block, while the refreshed feeds may describe later state. The two
  are separate reads and are not interchangeable; the interface states the
  block of each.
- Every observation older than 36 hours is labelled historical. A deployment
  republishes its feeds only when its operator runs the collector.

## Collector

The background collector (`refresh:observatory`, `refresh:watch`) is local
tooling provided for the operator's own use. It is not hardened against:

- two collectors running against the same data directory at once; one run's
  additions can replace another's;
- a previously published market payload in an older schema, which is not
  migrated and is retained under a failure status;
- a bootstrap over a data directory that already holds a longer history;
- re-verifying the block hashes of already-sampled observations after a chain
  reorganisation; canonicality is checked for newly requested blocks only.

The Broker transaction ledger labels each transfer by the token it queried
rather than by the emitting contract in the log, and therefore assumes a
faithful RPC response.

## Analytics

- The recorded bond table on the SPOT page shows the collateral feed's latest
  observation; when that feed and the SPOT state feed describe different
  blocks, the two sections of the page describe different moments.
- Recorded LP exit exports state that LP amounts use the LP token's decimals
  but do not include that number or the LP supply in the companion file.

## Interface

- The Data page labels a feed "Available" or "Historical" from the manifest
  alone; a damaged or mismatched payload is detected by the page that
  consumes it, not by that label.
- Pool activity is summarised per UTC day by its final swap and total
  turnover; a zero-liquidity or zero-volume swap earlier in an active day is
  not separately flagged.
