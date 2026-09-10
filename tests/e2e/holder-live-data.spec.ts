import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { tokenAmount } from "../../src/components/broker-results";
import {
  observatoryDatasetSchema,
  observatoryManifestSchema,
  type ObservatoryDatasetFor,
  type ObservatoryFeed,
} from "../../src/data/observatory-schemas";
import { brokerQuotesDatasetSchema } from "../../src/data/schemas";
import { token } from "../../src/lib/display";
import { lpExitTotalUsd } from "../../src/lib/recorded-quotes";
import { RECORDED_QUOTE_CSV_COLUMNS } from "../../src/reports/report";

// These tests require real published evidence. They neither mock missing feeds
// nor skip a workflow when its data is absent or unsupported.
const externalRequests = new Map<object, string[]>();
test.beforeEach(async ({ page }) => {
  const unexpected: string[] = [];
  externalRequests.set(page, unexpected);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin !== "http://127.0.0.1:4173"
    )
      unexpected.push(url.origin);
  });
});
test.afterEach(async ({ page }) => {
  expect(externalRequests.get(page)).toEqual([]);
  externalRequests.delete(page);
});

async function manifestFor(request: APIRequestContext) {
  const response = await request.get("/data/observatory-manifest.json");
  expect(response.ok(), "A published manifest is required").toBe(true);
  return observatoryManifestSchema.parse(await response.json());
}

async function publishedFeed<F extends ObservatoryFeed>(
  request: APIRequestContext,
  name: F,
): Promise<ObservatoryDatasetFor<F>> {
  const manifest = await manifestFor(request);
  const state = manifest.feeds[name];
  expect(state.status, `${name} must be supported and published`).toBe("ok");
  expect(state.path).not.toBeNull();
  expect(state.rowCount).toBeGreaterThan(0);
  const response = await request.get(state.path!);
  expect(response.ok()).toBe(true);
  const contents = await response.text();
  expect(createHash("sha256").update(contents).digest("hex")).toBe(
    state.contentHash,
  );
  const dataset = observatoryDatasetSchema.parse(JSON.parse(contents));
  expect(dataset.feed).toBe(name);
  expect(dataset.rows).toHaveLength(state.rowCount);
  expect(dataset.source).toBe("ethereum-rpc");
  return dataset as ObservatoryDatasetFor<F>;
}

test("SPOT redemption presets show the exact published contract-call baskets", async ({
  page,
}) => {
  const exits = await publishedFeed(page.request, "exit-inputs");
  const point = exits.rows.at(-1)!;
  expect(point.spotPaused).toBe(false);
  const available = point.spotRedemptions.filter((quote) => quote.available);
  expect(available.length).toBeGreaterThanOrEqual(2);
  await page.goto("/spot/#claims");
  const claims = page.getByRole("main").locator("#claims");
  for (const quote of [available[0]!, available.at(-1)!]) {
    await claims
      .getByRole("combobox", {
        name: "Recorded SPOT redemption amount",
        exact: true,
      })
      .selectOption(quote.inputAmount);
    const returned = claims.locator("tbody tr");
    await expect(returned).toHaveCount(quote.tokensOut.length);
    for (const [index, output] of quote.tokensOut.entries()) {
      const reserve = point.spotReserves.find(
        (asset) =>
          asset.token.address.toLowerCase() === output.token.toLowerCase(),
      );
      expect(reserve).toBeDefined();
      // Several tranche tokens share a symbol, so the cell also carries the
      // maturity (or "underlying") and the token address.
      const asset = returned.nth(index).locator("td").nth(0);
      await expect(asset).toContainText(reserve!.token.symbol ?? output.token);
      await expect(asset).toContainText(
        `${output.token.slice(0, 8)}…${output.token.slice(-4)}`,
      );
      if (reserve!.maturity) {
        await expect(asset).toContainText("matures");
      } else if (reserve!.isUnderlying) {
        await expect(asset).toContainText("underlying");
      }
      await expect(returned.nth(index).locator("td").nth(1)).toHaveText(
        token(output.amount, Number(reserve!.token.decimals), 9),
      );
    }
  }
  await expect(
    claims.getByText(/Recorded contract calls at/),
  ).toBeVisible();
  await expect(claims.getByRole("alert")).toHaveCount(0);
});

test("recorded LP exits show the contract's redemption and post-withdrawal sale", async ({
  page,
}) => {
  const quotesResponse = await page.request.get("/data/broker-quotes.json");
  expect(quotesResponse.ok(), "Recorded Broker quotes are required").toBe(
    true,
  );
  const quotes = brokerQuotesDatasetSchema.parse(await quotesResponse.json());
  // Use a recorded two-asset redemption whose sale the contract could fill.
  const recorded = [...quotes.lpRedemptions]
    .reverse()
    .find(
      (row) =>
        row.available &&
        row.usdOut !== null &&
        row.spotOut !== null &&
        BigInt(row.usdOut) > 0n &&
        BigInt(row.spotOut) > 0n &&
        row.sale?.available === true,
    );
  expect(
    recorded,
    "A recorded two-asset LP exit with an available sale is required",
  ).toBeDefined();
  const total = lpExitTotalUsd(recorded!);
  expect(total).not.toBeNull();
  const usdDecimals = Number(quotes.usdToken.decimals);
  const spotDecimals = Number(quotes.spotToken.decimals);
  await page.goto("/lp/#withdrawal");
  const withdrawal = page.getByRole("main").locator("#withdrawal");
  await withdrawal
    .getByRole("combobox", { name: "Recorded LP amount", exact: true })
    .selectOption(recorded!.lpAmount);
  const basket = withdrawal.locator(".grid.two.section .broker-quote-value");
  await expect(basket).toHaveCount(2);
  await expect(basket.nth(0)).toHaveText(
    `${tokenAmount(BigInt(recorded!.usdOut!), usdDecimals)} USDC`,
  );
  await expect(basket.nth(1)).toHaveText(
    `${tokenAmount(BigInt(recorded!.spotOut!), spotDecimals)} SPOT`,
  );
  await withdrawal
    .getByRole("combobox", { name: "After withdrawal", exact: true })
    .selectOption("sell");
  await expect(withdrawal.locator("p.broker-quote-value")).toContainText(
    `${tokenAmount(total!, usdDecimals)}`,
  );
  await withdrawal
    .getByText("Integer values & recorded reserves", { exact: true })
    .click();
  // The recorded sale output and the post-withdrawal reserves are displayed verbatim.
  await expect(
    withdrawal.getByText(recorded!.sale!.outputAmount!, { exact: true }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await withdrawal
    .getByRole("button", { name: "Export LP exits CSV", exact: true })
    .click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, "utf8");
  const [header, ...rows] = csv.trimEnd().split("\n");
  expect(header).toBe(RECORDED_QUOTE_CSV_COLUMNS.join(","));
  expect(rows).toHaveLength(quotes.lpRedemptions.length);
  const exported = rows.find((row) =>
    row.split(",")[RECORDED_QUOTE_CSV_COLUMNS.indexOf("lpAmount")] ===
    recorded!.lpAmount,
  );
  expect(exported).toBeDefined();
  const cells = exported!.split(",");
  expect(cells[RECORDED_QUOTE_CSV_COLUMNS.indexOf("kind")]).toBe(
    "lp-redemption",
  );
  expect(cells[RECORDED_QUOTE_CSV_COLUMNS.indexOf("usdOut")]).toBe(
    recorded!.usdOut,
  );
  expect(cells[RECORDED_QUOTE_CSV_COLUMNS.indexOf("saleOutputAmount")]).toBe(
    recorded!.sale!.outputAmount,
  );
  expect(cells[RECORDED_QUOTE_CSV_COLUMNS.indexOf("observationBlock")]).toBe(
    quotes.metadata.blockNumber,
  );
  await expect(withdrawal.getByRole("status")).toContainText(
    "Recorded LP exits exported.",
  );
  await expect(withdrawal.getByRole("alert")).toHaveCount(0);
});

test("stAMPL period performance and exported observations match published on-chain marks", async ({
  page,
}) => {
  const history = await publishedFeed(page.request, "stampl-history");
  expect(history.rows.length).toBeGreaterThanOrEqual(3);
  const first = history.rows[1]!;
  const last = history.rows.at(-1)!;
  const selected = history.rows.filter(
    (row) =>
      row.timestamp.slice(0, 10) >= first.timestamp.slice(0, 10) &&
      row.timestamp.slice(0, 10) <= last.timestamp.slice(0, 10),
  );
  expect(selected.length).toBeGreaterThanOrEqual(2);
  const startMark = BigInt(selected[0]!.amplPerStamplWad);
  const endMark = BigInt(selected.at(-1)!.amplPerStamplWad);
  const percent =
    Number(((endMark - startMark) * 100_000_000n) / startMark) / 1_000_000;
  const displayReturn = `${percent > 0 ? "+" : ""}${percent.toFixed(3)}%`;
  // Independently confirm that the published exchange rate uses the observed LP supply.
  expect(
    (
      (BigInt(last.collateralAmpl) *
        10n ** BigInt(last.decimals) *
        10n ** 18n) /
      (BigInt(last.totalSupply) * 10n ** 9n)
    ).toString(),
  ).toBe(last.amplPerStamplWad);
  await page.goto("/stampl/");
  const main = page.getByRole("main");
  await main
    .getByLabel("From (UTC)", { exact: true })
    .fill(first.timestamp.slice(0, 10));
  await main
    .getByLabel("To (UTC)", { exact: true })
    .fill(last.timestamp.slice(0, 10));
  const returnCard = main
    .locator("article.card")
    .filter({ has: page.getByText("Holding-period change", { exact: true }) });
  await expect(returnCard.locator(".metric-value")).toHaveText(displayReturn);
  await expect(returnCard).toContainText("not USD return or APR");
  const countCard = main
    .locator("article.card")
    .filter({ has: page.getByText("Observations in range", { exact: true }) });
  await expect(countCard.locator(".metric-value")).toHaveText(
    selected.length.toString(),
  );
  const funding = main
    .locator("article.card")
    .filter({
      has: page.getByRole("heading", {
        name: "Policy indication at observed TVLs",
        exact: true,
      }),
    });
  expect(last.indicatedFundingAmpl).not.toBeNull();
  // The magnitude is shown unsigned; the sign is stated as a direction.
  const indicated = BigInt(last.indicatedFundingAmpl!);
  await expect(funding.locator(".metric-value")).toHaveText(
    `${token(indicated < 0n ? -indicated : indicated, 9, 6)} AMPL`,
  );
  await expect(funding).toContainText(
    indicated === 0n
      ? "No transfer indicated"
      : indicated > 0n
        ? "Indicated direction: stAMPL → SPOT"
        : "Indicated direction: SPOT → stAMPL",
  );
  const downloadPromise = page.waitForEvent("download");
  await main
    .getByRole("button", { name: "Export observations CSV", exact: true })
    .click();
  const download = await downloadPromise;
  const contents = await readFile((await download.path())!, "utf8");
  const lines = contents.trim().split("\n");
  expect(lines).toHaveLength(selected.length + 1);
  expect(lines[0]).toContain('"amplPerStamplWad"');
  expect(lines[1]).toContain(`"${selected[0]!.blockHash}"`);
  expect(lines.at(-1)).toContain(`"${last.amplPerStamplWad}"`);
  await expect(main.getByRole("alert")).toHaveCount(0);
});
