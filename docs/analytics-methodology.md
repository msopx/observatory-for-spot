# Holder and liquidity analytics

The browser calculations use integer or reduced rational arithmetic. Conversion
to floating point is confined to chart coordinates. All results identify their
observation block and date. Historical observations are not current quotes.

## Direct Ethereum pool history

The `spot-market` feed uses payload schema version 2. The other feed payloads
and the manifest retain version 1. Market observations come directly from
`Swap` events emitted by the fixed Uniswap V3 SPOT/USDC 1% pool
`0x898aDC9aa0C23DCE3fED6456C34DbE2b57784325`. At the pinned release block the
collector checks the canonical factory's pool mapping, the CREATE2 address,
token order, decimals, fee, tick spacing and the fixed pool runtime hash. The
expected runtime hash is
`0x7c06da9cbc2c7692833fddc2eced589e0014f25e6816e5a13dfe6390cfb8047b`.
It was compared with the explorer's deployed bytecode and with reads at
historical block 25276141 and finalized block 25916954. No implementation
bytecode is redistributed. A runtime mismatch rejects collection, including
the first run.

The default window contains 90 completed UTC days. Each row covers the half-open
time interval `[periodStart, timestamp)` and an inclusive block range
`[fromBlock, toBlock]`. Actual block timestamps establish the boundaries. The
collector scans bounded log ranges, splits failures or capped responses, checks
event block hashes, deduplicates identical logs, rejects conflicting logs,
and orders swaps by block number and log index. It re-reads the used block
hashes before returning a dataset. A failed day prevents publication of the new
window; previously published on-chain coverage remains labelled incomplete.

Token0 is USDC (6 decimals) and token1 is SPOT (9 decimals). For the day's final
swap, `sqrtPriceX96` encodes the square root of the raw token1/token0 ratio. The
inverse, decimal-adjusted price is computed with bigint arithmetic:

```text
priceQuote = floor(2^192 * 10^21 / sqrtPriceX96^2)
```

`priceQuote` has 18 decimals and means **USDC per SPOT**. The raw square-root
price, signed token amounts, tick, active liquidity, block hash, transaction
hash, transaction index, log index and actual event timestamp remain attached
to `lastSwap`. `volumeQuote` is the sum of `abs(amount0)` over unique swaps,
in six-decimal USDC base units. It counts both trading directions once each;
it does not add the SPOT leg or value active liquidity in dollars.

Quiet days are successfully scanned rows with zero swaps, zero turnover,
`lastSwap: null` and `priceQuote: null`. Prices are never carried forward.
Zero-amount or zero-active-liquidity swaps remain observations with visible
qualifications. The price is the historical post-swap marginal pool price;
it excludes execution fees, price impact and gas and is not a trade quote.

The pool-price and protocol-FMV charts share a date axis but use separate
scales and explicit units: **USDC/SPOT** and **USD/SPOT** respectively. A pool
point is plotted at the UTC day's end; the UI exposes its actual swap time.
No dollar conversion, premium or discount is inferred from these two series.
The downloads contain the data used in the browser.

## Recorded bond state

The collateral feed records, for each senior tranche SPOT holds, the values the
bond and tranche contracts reported at the observation block: the bond's
collateral balance, the senior token's total supply, the senior tokens SPOT
holds, the collateral the senior token itself holds after a processed maturity,
the maturity timestamp and whether the bond reports itself mature. The SPOT
page shows these values as a table. Nothing is projected, allocated or
stress-tested from them; the interface performs no contraction, waterfall or
maturity-path calculation.

The collector labels a bond's identity `verified` only when its runtime is an
EIP-1167 clone of a supported target, the target's runtime hash matches, and
the senior token is a member of that bond. Deployment addresses alone do not
validate a newly observed bond. The supported targets are listed in the
protocol's [mainnet deployment registry](https://docs.prl.one/buttonwood/developers/deployed-contracts/ethereum-mainnet);
no upstream implementation source is included in the project.

At block 25853823, mainnet code reads returned the following runtime hashes,
which correspond to the explorer's published deployments:

| Implementation | Runtime keccak256 |
| --- | --- |
| BondController `0x8c624d6a336ede5da3bda01574cf091a938ea906` | `0x5421ecbe8ea0a6d97526b3690cb91161fcb84011343ef036238768c39539de2c` |
| Tranche `0xa07df4a1721bf151104234a8b73b93e5e371f7e8` | `0xcf8328abd8e61f107f4bd0f70089cb5e9add8305070008a262173bfc13f79b52` |

The archived September 2 vintage's bond and senior token were EIP-1167
clones of these respective targets. The target identities are re-read at each
collected block; this observation does not describe future identity.

## Fixed LP notes benchmark

`fixed-lp-notes-v1` keeps the selected LP note quantity constant. At each
observation, note ownership is `notes / total LP supply`. Multiplying that
fraction by USDC and SPOT reserves produces the attributable asset claims.
This normalizes other users' deposits and withdrawals by LP supply.

Both the LP claim and the unchanged starting basket use the same observed USDC
oracle price and SPOT protocol FMV. Values are USD fractions; prices use 18
decimal places, USDC has 6 and SPOT has 9. The actual starting mix defines the
holding comparison. No 50/50 assumption is made, and USDC is not assumed to
always equal one dollar.

The explanation decomposes as follows:

- Asset price effect = ending mark of unchanged starting basket minus starting
  value.
- Inventory and fee effect = ending LP reserve value minus ending mark of the
  starting basket.
- Total value change = the sum of those two effects.

Period return divides total value change by starting value. The excess return
divides the inventory and fee effect by starting value and is shown as
percentage points relative to holding. A zero starting value produces no
percentage. None of these returns are annualized.

This is gross reserve ownership of existing notes, not an execution strategy.
It excludes entry/exit fees, gas, wallet acquisition cost, transfers between
wallets, staking and external reward programs. It is not a traded-market
valuation, USDC exit quote, personal wallet return, or a claim that all changes
in reserve ownership came from swap fees. Unknown Broker implementations and
invalid observation prices are rejected before browser evaluation.

## Transaction ledger

`broker-balance-ledger-v1` sums actual signed USDC, SPOT and LP-supply changes
over `(start block, end block]`. Inputs must be in strict chain order with a
unique block-global log index per economic event. The collector is responsible
for avoiding duplicate transfers when grouping an economic transaction.

Each asset's residual is the observed endpoint minus the start plus all supplied
changes. Zero residuals alone do not show completeness: the collector must
also record full transfer coverage. Missing transfers, donations or supply
changes stay visible as residuals. Partial coverage is not labeled reconciled.

Transaction-level swap fees may additionally explain positive fees, rebates,
protocol fees and retained net fees in each asset's base units. They are not
added to reserve changes a second time. Protocol fees cannot exceed a positive
fee and cannot be taken from a rebate. If any swap lacks transaction-level fee data,
the fee breakdown is labelled partial even when the balance ledger reconciles.
Pool-level fee totals are not personal returns and cannot be converted into
per-note fee returns with only endpoint LP supply.

## Reproducible reports

`observatory-for-spot/scenario-v1` includes full model inputs, expected outputs,
explicit assumptions, version, observation block hashes and timestamps,
contract implementation identities, and dataset content hashes. Every integer
is encoded as a decimal string. Object keys are sorted before SHA-256 hashing;
array ordering remains significant.

Imports reject incomplete envelopes, unexpected schema fields, unsafe numeric
values, unknown model versions, altered payloads and files larger than 2 MB.
Replay parses inputs with the model's strict decoder and compares recomputed
outputs against the expected canonical output. The digest describes the file contents,
not their origin: an imported file's chain observations are self-declared
unless separately compared with the chain.

The recorded Broker quotes CSV (`broker-recorded-quotes.csv`, and the LP-only
`broker-lp-exits.csv`) is a flat view of `broker-quotes.json`: one row per
recorded swap quote and per recorded LP redemption, in ascending size. Every
row ends with the same context columns: the amount unit (`base-units`), chain
ID, observation block number, block hash and timestamp, and the Broker address
with the deployed implementation address and runtime code hash, so a row can be
interpreted on its own. Columns prefixed `derived_` are arithmetic on recorded
values (equal-value output at recorded prices and the implied fee as an
18-decimal fraction); every other numeric column is a contract output. The
companion `broker-recorded-quotes.meta.json`
(`observatory-for-spot/recorded-broker-quotes-v1`, canonical JSON) repeats the
context and adds the recorded reserves and prices, the grid definition, the
dataset's provenance notes, the column list and the unit statements. A CSV row
is a historical contract output at the stated block, not an executable quote.

## Test scope

The tests exercise proportional LP deposits and withdrawals, fractions smaller
than one token base unit, inconsistent prices, signed fees, residual accounting
and report tampering. Synthetic accounting cases are marked as tests; they are
never packaged as financial history.

These deterministic tests exercise the documented model behavior. They do not
address unknown contracts, missing historical events, future market behavior or
gon-rounding outcomes.
