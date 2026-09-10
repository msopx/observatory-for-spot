import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { tokenAmount } from "../../src/components/broker-results";
import {
  amplRebasesDatasetSchema,
  brokerQuotesDatasetSchema,
  brokerStateDatasetSchema,
} from "../../src/data/schemas";
import { gridFor, oneUnitQuote } from "../../src/lib/recorded-quotes";
import {
  RELEASE_TREE_URL,
  SOURCE_ARCHIVE_PATH,
} from "../../src/lib/repository";
import { RECORDED_QUOTE_CSV_COLUMNS } from "../../src/reports/report";

const requestsByPage = new Map<object, string[]>();
test.beforeEach(async ({ page }) => {
  const externalRequests: string[] = [];
  requestsByPage.set(page, externalRequests);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin !== "http://127.0.0.1:4173"
    )
      externalRequests.push(url.origin);
  });
  await page.goto("/");
});
test.afterEach(async ({ page }) => {
  expect(requestsByPage.get(page)).toEqual([]);
  requestsByPage.delete(page);
});

async function publishedDataset(
  request: APIRequestContext,
  name: "ampl-rebases" | "broker-state",
) {
  const manifestResponse = await request.get("/data/observatory-manifest.json");
  const manifest = manifestResponse.ok() ? await manifestResponse.json() : null;
  const path = manifest?.legacy?.[name]?.path ?? `/data/${name}.json`;
  const response = await request.get(path);
  expect(response.ok()).toBe(true);
  return response.json();
}

test("renders the expanded static dashboard and retains legal notices", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "A clearer view of the system.",
    }),
  ).toBeVisible();
  for (const [label, path, content] of [
    ["GPL-3.0-or-later license", "/LICENSE.txt", "GNU General Public License"],
    ["Third-party notices", "/THIRD-PARTY-NOTICES.txt", "Third-Party Notices"],
    [
      "Names & affiliation",
      "/TRADEMARKS.txt",
      "independent, unofficial analytics interface",
    ],
  ] as const) {
    await expect(page.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      path,
    );
    const response = await page.request.get(path);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain(content);
  }
  // Corresponding source is linked from the served page: the exact tagged
  // tree and the archive that package:release serves under /source/. The test
  // follows neither; the archive exists only in a packaged release.
  await expect(
    page.locator("footer").getByRole("link", { name: "Source", exact: true }),
  ).toHaveAttribute("href", RELEASE_TREE_URL);
  await expect(
    page
      .locator("footer")
      .getByRole("link", { name: "Source archive", exact: true }),
  ).toHaveAttribute("href", SOURCE_ARCHIVE_PATH);
  const routes = [
    ["/ampl/", "Every rebase, in view."],
    ["/spot/", "Know what sits beneath SPOT."],
    ["/broker/", "What the Broker quoted."],
    ["/lp/", "Did liquidity pay off?"],
    ["/stampl/", "The other side of the system."],
    ["/learn/", "Understand what moves underneath."],
  ] as const;
  for (const [route, heading] of routes) {
    await page.goto(route);
    await expect(
      page.getByRole("heading", { level: 1, name: heading }),
    ).toBeVisible();
    await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);
  }
  await page.goto("/data/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Use dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("filters indexed AMPL epochs, paginates history and selects a calendar day", async ({
  page,
}) => {
  const data = amplRebasesDatasetSchema.parse(
    await publishedDataset(page.request, "ampl-rebases"),
  );
  const latest = data.rows.at(-1)!;
  await page.goto("/ampl/");
  await page.getByRole("button", { name: "All history", exact: true }).click();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(Math.min(data.rows.length, 100));
  await expect(rows.first()).toContainText(latest.epoch);
  await expect(
    page.getByText(
      `Showing 1–${Math.min(data.rows.length, 100)} of ${data.rows.length.toLocaleString("en-US")} · newest first`,
    ),
  ).toBeVisible();
  if (data.rows.length > 100) {
    await page.getByRole("button", { name: "Older", exact: true }).click();
    await expect(rows.first()).toContainText(data.rows.at(-101)!.epoch);
    await page.getByRole("button", { name: "Newer", exact: true }).click();
    await expect(rows.first()).toContainText(latest.epoch);
  }
  const date = latest.timestamp.slice(0, 10);
  await page.getByLabel("From (UTC)", { exact: true }).fill(date);
  await page.getByLabel("To (UTC)", { exact: true }).fill(date);
  await expect(rows).toHaveCount(
    data.rows.filter((row) => row.timestamp.startsWith(date)).length,
  );
  const selected =
    data.rows
      .filter((row) => row.timestamp.startsWith(date.slice(0, 7)))
      .at(-2) ?? latest;
  await page
    .getByRole("button", {
      name: new RegExp(`^${selected.timestamp.slice(0, 10)}:`),
    })
    .click();
  await expect(page.locator(".calendar-selected")).toContainText(
    `Epoch ${selected.epoch}`,
  );
  await page.getByLabel("From (UTC)", { exact: true }).fill("2099-01-01");
  await expect(
    page.getByText("The end date must be on or after the start date.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);
});

test("shows recorded contract quotes by trade size and exports them verbatim", async ({
  page,
}) => {
  const quotesResponse = await page.request.get("/data/broker-quotes.json");
  expect(quotesResponse.ok(), "Recorded Broker quotes are required").toBe(
    true,
  );
  const quotes = brokerQuotesDatasetSchema.parse(await quotesResponse.json());
  const state = brokerStateDatasetSchema.parse(
    await publishedDataset(page.request, "broker-state"),
  );
  // When both datasets describe the same block, the one-unit grid point is the
  // standard quote recorded in broker-state.
  if (
    state.metadata.blockHash.toLowerCase() ===
    quotes.metadata.blockHash.toLowerCase()
  ) {
    expect(oneUnitQuote(quotes, "usd-to-spot")?.outputAmount).toBe(
      state.quotes.usdToSpot.outputAmount,
    );
    expect(oneUnitQuote(quotes, "spot-to-usd")?.outputAmount).toBe(
      state.quotes.spotToUsd.outputAmount,
    );
  }
  await page.goto("/broker/");
  const section = page.getByRole("region", { name: "Recorded Broker quotes" });
  await section
    .getByRole("combobox", { name: "Trade direction", exact: true })
    .selectOption("usd-to-spot");
  const first = gridFor(quotes, "usd-to-spot")[0]!;
  await section
    .getByRole("combobox", { name: "Recorded trade size", exact: true })
    .selectOption(first.inputAmount);
  await expect(section.getByText("Recorded quote", { exact: true })).toBeVisible();
  if (first.available && first.outputAmount !== null) {
    await expect(section.locator(".broker-quote-value").first()).toContainText(
      tokenAmount(
        BigInt(first.outputAmount),
        Number(quotes.spotToken.decimals),
      ),
    );
    await section
      .getByText("Integer values & recorded reserves", { exact: true })
      .click();
    await expect(
      section.getByText(first.outputAmount, { exact: true }),
    ).toBeVisible();
  }
  const unavailable = quotes.grid.usdToSpot.find((quote) => !quote.available);
  if (unavailable) {
    await section
      .getByRole("combobox", { name: "Recorded trade size", exact: true })
      .selectOption(unavailable.inputAmount);
    await expect(
      section.getByText("Quote unavailable", { exact: true }),
    ).toBeVisible();
  }
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);

  const csvPromise = page.waitForEvent("download");
  await section
    .getByRole("button", { name: "Export recorded quotes CSV", exact: true })
    .click();
  const csv = await csvPromise;
  expect(csv.suggestedFilename()).toBe("broker-recorded-quotes.csv");
  const text = await readFile((await csv.path())!, "utf8");
  const [header, ...rows] = text.trimEnd().split("\n");
  expect(header).toBe(RECORDED_QUOTE_CSV_COLUMNS.join(","));
  expect(rows).toHaveLength(
    quotes.grid.spotToUsd.length +
      quotes.grid.usdToSpot.length +
      quotes.lpRedemptions.length,
  );
  const blockColumn = RECORDED_QUOTE_CSV_COLUMNS.indexOf("observationBlock");
  for (const row of rows) {
    expect(row.split(",")[blockColumn]).toBe(quotes.metadata.blockNumber);
  }
  const firstRow = rows[0]!.split(",");
  expect(firstRow[RECORDED_QUOTE_CSV_COLUMNS.indexOf("kind")]).toBe(
    "swap-quote",
  );
  expect(firstRow[RECORDED_QUOTE_CSV_COLUMNS.indexOf("inputAmount")]).toBe(
    gridFor(quotes, "spot-to-usd")[0]!.inputAmount,
  );

  const metaPromise = page.waitForEvent("download");
  await section
    .getByRole("button", { name: "Export quotes context", exact: true })
    .click();
  const meta = await metaPromise;
  expect(meta.suggestedFilename()).toBe("broker-recorded-quotes.meta.json");
  const companion = JSON.parse(
    await readFile((await meta.path())!, "utf8"),
  ) as {
    schema: string;
    context: { blockNumber: string; implementationCodeHash: string };
    columns: string[];
  };
  expect(companion.schema).toBe(
    "observatory-for-spot/recorded-broker-quotes-v1",
  );
  expect(companion.context.blockNumber).toBe(quotes.metadata.blockNumber);
  expect(companion.context.implementationCodeHash).toBe(
    quotes.implementationCodeHash,
  );
  expect(companion.columns).toEqual([...RECORDED_QUOTE_CSV_COLUMNS]);
});

test("explains a missing recorded-quote dataset without fabricating an exit", async ({
  page,
}) => {
  await page.route("**/data/broker-quotes.json", (route) =>
    route.fulfill({ status: 404, body: "not found" }),
  );
  await page.goto("/lp/#withdrawal");
  const withdrawal = page.locator("#withdrawal");
  await expect(
    withdrawal.getByRole("heading", {
      name: "Start with the basket. Then the recorded sale.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    withdrawal.getByText(/recorded LP exit dataset could not be loaded/),
  ).toBeVisible();
  await expect(
    withdrawal.getByRole("button", { name: "Export LP exits CSV", exact: true }),
  ).toHaveCount(0);
  await expect(withdrawal.locator(".broker-quote-value")).toHaveCount(0);

  await page.goto("/broker/");
  const section = page.getByRole("region", { name: "Recorded Broker quotes" });
  await expect(
    section.getByText(/recorded quote dataset could not be loaded/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export recorded quotes CSV", exact: true }),
  ).toHaveCount(0);
});

test("keeps the recorded quotes and casebooks within a mobile viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ["/broker/", "/learn/"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    if (route === "/broker/")
      await expect(
        page.getByRole("combobox", { name: "Recorded trade size", exact: true }),
      ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
});
