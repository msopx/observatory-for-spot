# Data and calculation notes

The adapters use public contract interfaces, published protocol references,
emitted events, and observable `eth_call` results. Liquidity analytics use
integer or rational arithmetic. Nothing calculates
market-dependent arbitrage, LP profit/loss, or impermanent loss.

The packaged source contains no Solidity source, vendored protocol repository,
submodule, or deployed bytecode, and no implementation of Bill Broker quote,
fee or redemption arithmetic.

## Provenance and method

Bill Broker figures are recorded, not computed: `broker-quotes.json` and
`broker-state.json` hold `eth_call` outputs of the deployed contract at the
release block, and the exit-inputs feed holds recorded redemption calls. The
integer helpers in `src/protocol/fixed-point.ts` are generic project
arithmetic (bounds checks, floor/ceiling/truncating division and decimal
formatting) and implement no protocol source. One place reconstructs a
protocol quantity: the legacy AMPL target-rate derivation in
`src/data/integration.ts`, written in TypeScript from the policy contract's
public ABI, its observable mainnet behavior and recorded events; the
GPL-licensed upstream Solidity source it names was consulted to confirm
rounding direction. No upstream source text is included, and the
implementation is not presented as a clean-room implementation. Bond and
tranche figures are recorded contract reads and are displayed without further
calculation. The upstream source, its licence and the licence terms that apply
to any portion found to derive from it are recorded in
`THIRD-PARTY-NOTICES.txt` under PROTOCOL PROVENANCE. That record is maintained
in `release/protocol-provenance.txt` and is part of the generated notices.

## AMPL rebases

For legacy policy events, the target rate is:

`targetRate = floor(cpi * 10^18 / 109195000000000007392)`.

For V2 events, the emitted `targetRate` is used. Actual supply change is derived
only from consecutive AMPL token `totalSupply` events, not from the requested
policy adjustment. Policy and token events are paired by transaction hash and
epoch; ambiguous or missing pairs are rejected.

Epoch identifiers are not assumed to be contiguous. For this release, the
full deployment-to-release query returned one unambiguous policy/token pair
for every identifier from 1 through 2609. The release-data conformance report
records the absent-identifier list (empty for this release) rather than
synthesizing a row for any missing pair.

## Recorded Bill Broker quotes

`broker-quotes.json` records the deployed Broker's own answers at the release
block. Swap grids call `computePerpToUSDSwapAmt` and
`computeUSDToPerpSwapAmt` with the recorded reserve state as the argument for
sizes of one whole token times quarter-decade steps (mantissas 1.000, 1.778,
3.162 and 5.623 per decade, stored as integers in thousandths), stopping after
two consecutive unavailable quotes or forty points. LP rows call
`computeRedemptionAmts` for one LP unit and fixed fractions of LP supply; where
SPOT is redeemed, the contract is asked to quote the sale of all of it with the
reserves minus the redeemed amounts as the reserve-state argument, which is the
only arithmetic in the dataset. The one-unit grid points must equal the
standard quotes in `broker-state.json`.

The interface labels two figures as derived: the equal-value output at the
recorded prices (`input × inputPrice × 10^outputDecimals ÷ (outputPrice ×
10^inputDecimals)`, rounded down) and the implied fee
(`(equalValue − output) ÷ equalValue`, 18-decimal fixed point, truncated).
Both are arithmetic on recorded numbers, shown with their formula, and are not
protocol computations. Historical contract outputs are not executable quotes:
gas, transaction ordering and pause state are not represented.

An unavailable quote records only what was observed: `zero-output` when the
call returned an output of zero (whether the size exceeded what the reserves
allow or the amount rounded to zero is not inferred), and `contract-reverted`
when the call reverted. Grid points and LP rows are written in ascending input
size; other arrays of objects are ordered canonically by the writer. Readers
still sort by input size rather than relying on file order.

## Implementation identity

The registry records block-bounded implementation epochs with implementation
addresses and runtime-code hashes. `assertSupportedImplementation` rejects:

1. a block outside all registered epochs;
2. an epoch without a supported implementation address or runtime code hash;
3. any observed address mismatch; and
4. any observed runtime-code-hash mismatch.

Unresolved historical epochs are unsupported.
