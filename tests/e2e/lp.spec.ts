import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  importScenarioReport,
  replayAnalyticsScenario,
} from "../../src/analytics/scenarios";
import { brokerStateDatasetSchema } from "../../src/data/schemas";
import {
  observatoryDatasetSchema,
  observatoryManifestSchema,
} from "../../src/data/observatory-schemas";

/** Synthetic UI evidence is served only by the test router, never published. */
async function mockHistory(page: Page) {
  const manifest = observatoryManifestSchema.parse(
    JSON.parse(await readFile("public/data/observatory-manifest.json", "utf8")),
  );
  const broker = brokerStateDatasetSchema.parse(
    JSON.parse(await readFile("public/data/broker-state.json", "utf8")),
  );
  const first = {
    blockNumber: "25853823",
    blockHash: broker.metadata.blockHash,
    timestamp: "2026-08-28T12:45:11.000Z",
    implementation: {
      address: broker.implementationAddress,
      codeHash: broker.implementationCodeHash,
    },
    usdBalance: "100000000",
    spotBalance: "25000000000",
    usdPrice: "1000000000000000000",
    spotFmv: "4000000000000000000",
    lpSupply: "100000000000000000000",
    lpDecimals: "18",
    paused: false,
    oracleStatus: "valid-at-observation",
    parameters: broker.parameters,
  };
  const second = {
    ...first,
    blockNumber: "25853833",
    timestamp: "2026-08-28T12:47:11.000Z",
    usdBalance: "110000000",
    spotBalance: "20000000000",
    spotFmv: "8000000000000000000",
  };
  const data = observatoryDatasetSchema.parse({
    schemaVersion: 1,
    feed: "broker-history",
    generatedAt: second.timestamp,
    chainId: 1,
    source: "ethereum-rpc",
    notes: ["Synthetic browser test observations. Never published."],
    rows: [first, second],
    events: [],
    ledger: {
      fromBlock: first.blockNumber,
      toBlock: second.blockNumber,
      coverage: "complete",
      events: [
        {
          blockNumber: second.blockNumber,
          logIndex: "1",
          transactionHash: `0x${"a".repeat(64)}`,
          kind: "swap",
          usdcDelta: "10000000",
          spotDelta: "-5000000000",
          lpSupplyDelta: "0",
          fee: null,
        },
      ],
    },
  });
  const body = JSON.stringify(data);
  const hash = createHash("sha256").update(body).digest("hex");
  const path = `/data/observatory/broker-history.${hash}.json`;
  manifest.feeds["broker-history"] = {
    status: "ok",
    path,
    contentHash: hash,
    observedAt: second.timestamp,
    attemptedAt: second.timestamp,
    message: null,
    rowCount: 2,
    coverage: { fromBlock: first.blockNumber, toBlock: second.blockNumber },
  };
  await page.route("**/data/observatory-manifest.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(manifest),
    }),
  );
  await page.route(`**${path}`, (route) =>
    route.fulfill({ contentType: "application/json", body }),
  );
}

test("LP benchmark uses the actual basket, reconciles transfers and reproduces exports", async ({
  page,
}) => {
  await mockHistory(page);
  await page.goto("/lp/");
  await expect(
    page.getByRole("heading", { name: "Did liquidity pay off?" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Existing LP notes", { exact: true }),
  ).toHaveValue("1");
  await expect(
    page
      .locator(".card")
      .filter({
        has: page.getByText("LP holding-period return", { exact: true }),
      }),
  ).toContainText("35%");
  await expect(
    page
      .locator(".card")
      .filter({ has: page.getByText("LP minus holding", { exact: true }) }),
  ).toContainText("-15%");
  await expect(
    page.getByText("Reserve balances and LP supply reconcile", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Partial fee attribution:/)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export scenario", exact: true })
    .click();
  const download = await downloadPromise;
  const text = await readFile((await download.path())!, "utf8");
  expect(
    (await replayAnalyticsScenario(await importScenarioReport(text)))
      .matchesExpected,
  ).toBe(true);
  await page
    .getByLabel("Import LP scenario", { exact: true })
    .setInputFiles({
      name: "lp.json",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
  await expect(
    page.getByRole("heading", {
      name: "Imported scenario · reproduced locally",
    }),
  ).toBeVisible();
  const tampered = JSON.parse(text);
  tampered.payload.inputs.lpAmount = "2";
  await page
    .getByLabel("Import LP scenario", { exact: true })
    .setInputFiles({
      name: "changed.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(tampered)),
    });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "does not match its identifier",
  );
  await expect(
    page.getByRole("heading", {
      name: "Imported scenario · reproduced locally",
    }),
  ).toHaveCount(0);
});

test("LP controls reject reversed periods and impossible note amounts", async ({
  page,
}) => {
  await mockHistory(page);
  await page.goto("/lp/");
  await page
    .getByLabel("Starting observation", { exact: true })
    .selectOption("25853833");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "advance",
  );
  await expect(
    page.getByRole("button", { name: "Export scenario", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Starting observation", { exact: true })
    .selectOption("25853823");
  await page.getByLabel("Existing LP notes", { exact: true }).fill("101");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "exceed",
  );
  await page
    .getByLabel("Existing LP notes", { exact: true })
    .fill("0.0000000000000000001");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "fractional",
  );
});
