import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CONTRACTS } from "../../src/data/contracts";
import {
  observatoryDatasetSchema,
  observatoryManifestSchema,
} from "../../src/data/observatory-schemas";

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const Q96 = 2n ** 96n;
const dayStart = (index: number) =>
  `2026-08-${String(20 + index).padStart(2, "0")}T00:00:00.000Z`;
const generatedAt = "2026-08-25T12:00:00.000Z";

// Deliberately synthetic observations exist only in the Playwright router.
// Five fully scanned days include a quiet day, single-swap closes and a final
// zero-turnover/zero-liquidity event. No financial fixture is published.
function marketFixture() {
  const rows = Array.from({ length: 5 }, (_, index) => {
    const quiet = index === 2;
    const zeroLiquidity = index === 4;
    const sqrt = index === 1 || index === 4 ? 2n * Q96 : Q96;
    const fromBlock = 25_840_000 + index * 100;
    const endHash = hash(String(index + 1));
    return {
      periodStart: dayStart(index),
      timestamp: dayStart(index + 1),
      fromBlock: fromBlock.toString(),
      toBlock: (fromBlock + 99).toString(),
      toBlockHash: endHash,
      swapCount: quiet ? "0" : "1",
      volumeQuote: quiet || zeroLiquidity ? "0" : "100000000",
      priceQuote: quiet
        ? null
        : ((2n ** 192n * 10n ** 21n) / (sqrt * sqrt)).toString(),
      lastSwap: quiet
        ? null
        : {
            blockNumber: (fromBlock + 80).toString(),
            blockHash: hash("b"),
            timestamp: `2026-08-${20 + index}T${index === 1 ? "23:59:59" : index === 3 ? "00:00:01" : "06:12:23"}.000Z`,
            transactionHash: hash(String(index + 5)),
            transactionIndex: "2",
            logIndex: "3",
            sqrtPriceX96: sqrt.toString(),
            tick: sqrt === Q96 ? "0" : "13863",
            liquidity: zeroLiquidity ? "0" : "1000000000",
            amount0: zeroLiquidity ? "0" : "100000000",
            amount1: zeroLiquidity ? "0" : "-100000000",
          },
    };
  });
  return observatoryDatasetSchema.parse({
    schemaVersion: 2,
    feed: "spot-market",
    generatedAt,
    chainId: 1,
    source: "ethereum-rpc",
    notes: [
      "Synthetic browser test data. Never published.",
      "Daily pool prices use the final Swap event and retain its transaction timestamp.",
    ],
    pool: {
      address: "0x898aDC9aa0C23DCE3fED6456C34DbE2b57784325",
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      token0: CONTRACTS.usdc.address,
      token1: CONTRACTS.spot.address,
      baseToken: {
        address: CONTRACTS.spot.address,
        symbol: "SPOT",
        name: "Spot",
        decimals: "9",
      },
      quoteToken: {
        address: CONTRACTS.usdc.address,
        symbol: "USDC",
        name: "USD Coin",
        decimals: "6",
      },
      fee: "10000",
      tickSpacing: "200",
      codeHash: hash("a"),
      verifiedAt: {
        blockNumber: "25841000",
        blockHash: hash("c"),
        timestamp: generatedAt,
      },
    },
    rows,
  });
}

async function routeEvidence(
  page: Page,
  mode: "ready" | "unsupported" | "failed" | "legacy" | "retained" = "ready",
) {
  const manifest = observatoryManifestSchema.parse(
    JSON.parse(await readFile("public/data/observatory-manifest.json", "utf8")),
  );
  const fixture = marketFixture();
  const fmv = observatoryDatasetSchema.parse({
    schemaVersion: 1,
    feed: "spot-history",
    generatedAt,
    chainId: 1,
    source: "ethereum-rpc",
    notes: ["Synthetic protocol marks used only in browser tests."],
    rows: [0, 2, 4].map((index) => ({
      blockNumber: (25_840_050 + index * 100).toString(),
      blockHash: hash("d"),
      timestamp: `2026-08-${20 + index}T12:00:00.000Z`,
      implementation: { address: CONTRACTS.spot.address, codeHash: hash("e") },
      collateralAmpl: "1000000000",
      totalSupply: "1000000000",
      deviationRatio: "100000000",
      deviationRatioDecimals: "8",
      reserveCount: "1",
      fmvUsd: (BigInt(100 + index) * 10n ** 16n).toString(),
    })),
  });
  // An unsupported payload schema version must be rejected by the loader.
  const body = JSON.stringify(
    mode === "legacy" ? { ...fixture, schemaVersion: 1 } : fixture,
  );
  for (const [feed, text] of [
    ["spot-market", body],
    ["spot-history", JSON.stringify(fmv)],
  ] as const) {
    const contentHash = createHash("sha256").update(text).digest("hex");
    const path = `/data/observatory/${feed}.${contentHash}.json`;
    manifest.feeds[feed] = {
      status: "ok",
      path,
      contentHash,
      observedAt:
        feed === "spot-market" ? dayStart(5) : "2026-08-24T12:00:00.000Z",
      attemptedAt: generatedAt,
      message: null,
      rowCount: feed === "spot-market" ? 5 : 3,
      coverage: { fromBlock: "25840000", toBlock: "25840499" },
    };
    await page.route(`**${path}`, (route) =>
      feed === "spot-market" && mode === "failed"
        ? route.fulfill({
            status: 503,
            contentType: "text/plain",
            body: "Unavailable",
          })
        : route.fulfill({ contentType: "application/json", body: text }),
    );
  }
  if (mode === "unsupported")
    manifest.feeds["spot-market"] = {
      status: "unsupported",
      path: null,
      contentHash: null,
      observedAt: null,
      attemptedAt: generatedAt,
      message: "rpc-unavailable",
      rowCount: 0,
      coverage: null,
    };
  if (mode === "retained")
    manifest.feeds["spot-market"] = {
      ...manifest.feeds["spot-market"],
      status: "error",
      message: "market-source-unavailable",
    };
  manifest.generatedAt = generatedAt;
  await page.route("**/data/observatory-manifest.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(manifest),
    }),
  );
  return { fixture, body };
}

/** The download link is a plain static-file anchor; confirm it serves the published bytes. */
async function servedDownload(page: Page, pool: Locator, body: string) {
  const link = pool.getByRole("link", {
    name: "Download pool data JSON",
    exact: true,
  });
  await expect(link).toHaveAttribute("download", "");
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/data\/observatory\/spot-market\.[0-9a-f]{64}\.json$/);
  const downloaded = await page.evaluate(
    async (url) => (await fetch(url, { credentials: "omit" })).text(),
    href!,
  );
  expect(downloaded).toBe(body);
  return downloaded;
}

test("pool data separates USDC prices from USD FMV and preserves quiet days", async ({
  page,
}) => {
  const { fixture, body } = await routeEvidence(page);
  const external: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin !== "http://127.0.0.1:4173"
    )
      external.push(url.origin);
  });
  await page.goto("/spot/#market");
  const market = page.getByRole("main").locator("#market");
  const pool = market.getByRole("article", {
    name: "Uniswap pool history",
    exact: true,
  });
  const protocol = market.getByRole("article", {
    name: "Protocol valuation history",
    exact: true,
  });
  await expect(
    pool.getByRole("heading", { name: "Pool price · USDC/SPOT", exact: true }),
  ).toBeVisible();
  await expect(
    protocol.getByRole("heading", {
      name: "Protocol FMV · USD/SPOT",
      exact: true,
    }),
  ).toBeVisible();
  await expect(pool.getByText("USDC / SPOT", { exact: true })).toBeVisible();
  await expect(protocol.getByText("USD / SPOT", { exact: true })).toBeVisible();
  await expect(pool.locator(".metric-value")).toHaveText("250 USDC / SPOT");
  await expect(protocol.locator(".metric-value")).toHaveText("$1.04 per SPOT");
  await expect(pool.getByText("1%", { exact: true })).toBeVisible();
  await expect(pool.getByText("5 UTC days", { exact: true })).toBeVisible();
  await expect(pool.getByText("300 USDC", { exact: true })).toBeVisible();
  await expect(pool.locator(".market-last-swap")).toContainText(
    "2026-08-24 06:12:23 UTC",
  );
  await expect(pool.getByRole("status")).toContainText([
    "Low observed activity",
    "zero active liquidity",
  ]);
  const curve = pool
    .getByTestId("pool-price-chart")
    .locator(".recharts-line-curve");
  await expect(curve).toHaveAttribute("d", /M/);
  expect(((await curve.getAttribute("d")) ?? "").match(/M/g)).toHaveLength(2);
  const poolDateTicks = pool
    .getByTestId("pool-price-chart")
    .locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value");
  const protocolDateTicks = protocol
    .getByTestId("protocol-fmv-chart")
    .locator(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value");
  await expect(poolDateTicks.nth(1)).toBeVisible();
  await expect(protocolDateTicks.nth(1)).toBeVisible();
  const dates = await poolDateTicks.allTextContents();
  expect(dates.length).toBeGreaterThan(1);
  await expect(protocolDateTicks).toHaveText(dates);
  await pool
    .getByText("Daily coverage & swaps", { exact: true })
    .click();
  const quiet = pool.getByTestId("market-day-2026-08-22");
  await expect(quiet).toContainText("Quiet day · no swap");
  await expect(quiet.locator("td").nth(1)).toContainText("No price");
  await expect(quiet.locator("td").nth(2)).toHaveText("0");
  await expect(quiet.locator("td").nth(3)).toContainText("Zero USDC turnover");
  await quiet.getByText("Inspect scanned coverage", { exact: true }).click();
  await expect(quiet).toContainText("25840200–25840299");
  const final = pool.getByTestId("market-day-2026-08-24");
  await expect(final).toContainText("Zero active liquidity at final swap");
  await final.getByText("Inspect final swap", { exact: true }).click();
  await expect(final).toContainText("2026-08-24 06:12:23 UTC");
  await expect(final.getByRole("link")).toHaveAttribute(
    "href",
    `https://etherscan.io/tx/${hash("9")}`,
  );
  await pool
    .getByText("Pool identity & source files", {
      exact: true,
    })
    .click();
  // Collector notes stay inside the downloadable file; the page does not render them.
  await expect(pool).not.toContainText(
    "Synthetic browser test data. Never published.",
  );
  await expect(pool).toContainText(hash("a"));
  const downloaded = await servedDownload(page, pool, body);
  expect(observatoryDatasetSchema.parse(JSON.parse(downloaded))).toEqual(
    fixture,
  );
  expect(external).toEqual([]);

  await page.goto("/data/");
  const card = page
    .getByRole("main")
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", {
        name: "SPOT pool prices · USDC",
        exact: true,
      }),
    });
  await expect(card).toContainText("Uniswap V3 Swap events");
  await expect(
    card.getByRole("link", {
      name: "Inspect pool activity & source ↗",
      exact: true,
    }),
  ).toHaveAttribute("href", "/spot/#market");
});

test("failed collection keeps the published pool data with an explicit incomplete coverage warning", async ({
  page,
}) => {
  const { body } = await routeEvidence(page, "retained");
  await page.goto("/spot/#market");
  const pool = page
    .getByRole("main")
    .locator("#market")
    .getByRole("article", { name: "Uniswap pool history", exact: true });
  await expect(pool.getByRole("alert")).toHaveText(
    "Coverage incomplete for the latest refresh. The last published daily history is retained; no new days are inferred.",
  );
  await expect(pool.locator(".metric-value")).toHaveText("250 USDC / SPOT");
  await expect(pool.getByTestId("pool-price-chart")).toBeVisible();
  await expect(pool.getByText("5 UTC days", { exact: true })).toBeVisible();
  await servedDownload(page, pool, body);
});

test("dashboards and downloads work without crypto.subtle", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "subtle", {
      configurable: true,
      value: undefined,
    });
  });
  const { body } = await routeEvidence(page);
  await page.goto("/spot/#market");
  expect(await page.evaluate(() => globalThis.crypto.subtle)).toBeUndefined();
  const main = page.getByRole("main");
  // This card uses the legacy loader; the market and FMV use the new feed loader.
  const collateral = main
    .getByRole("article")
    .filter({ has: page.getByText("SPOT collateral TVL", { exact: true }) });
  await expect(collateral.locator(".metric-value")).toContainText("AMPL");
  const pool = main
    .locator("#market")
    .getByRole("article", { name: "Uniswap pool history", exact: true });
  await expect(pool.locator(".metric-value")).toHaveText("250 USDC / SPOT");
  await expect(
    main
      .getByRole("article", { name: "Protocol valuation history", exact: true })
      .locator(".metric-value"),
  ).toHaveText("$1.04 per SPOT");
  await servedDownload(page, pool, body);
});

for (const mode of ["unsupported", "failed", "legacy"] as const) {
  test(`pool history fails clearly for ${mode} evidence while protocol FMV remains available`, async ({
    page,
  }) => {
    await routeEvidence(page, mode);
    await page.goto("/spot/#market");
    const market = page.getByRole("main").locator("#market");
    const pool = market.getByRole("article", {
      name: "Uniswap pool history",
      exact: true,
    });
    await expect(
      pool.getByText("On-chain pool history unavailable", { exact: true }),
    ).toBeVisible();
    await expect(pool.getByTestId("pool-price-chart")).toHaveCount(0);
    await expect(
      pool.getByRole("link", {
        name: "Download pool data JSON",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      market
        .getByRole("article", {
          name: "Protocol valuation history",
          exact: true,
        })
        .locator(".metric-value"),
    ).toHaveText("$1.04 per SPOT");
  });
}
