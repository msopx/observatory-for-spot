import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { amplRebasesDatasetSchema } from "../src/data/schemas";
import {
  filterRebases,
  monthCells,
  rebaseSummary,
  offsetMonth,
} from "../src/analytics/rebases";
const row = amplRebasesDatasetSchema
  .parse(JSON.parse(readFileSync("public/data/ampl-rebases.json", "utf8")))
  .rows.at(-1)!;
describe("rebase calendar and history", () => {
  it("does not extend expansion streaks across missing epochs", () => {
    const point = (epoch: string) => ({
      ...row,
      epoch,
      previousTotalSupply: "100",
      totalSupply: "101",
    });
    expect(rebaseSummary([point("1"), point("2"), point("4")])).toMatchObject({
      longestExpansion: 2,
      currentStreak: 1,
    });
  });
  it("keeps leap days and UTC month boundaries", () => {
    expect(monthCells("2024-02").filter(Boolean)).toHaveLength(29);
    expect(offsetMonth("2026-01", -1)).toBe("2025-12");
  });
  it("includes the complete end date without including next day", () => {
    const points = [
      { ...row, timestamp: "2026-08-28T23:59:59.000Z" },
      { ...row, timestamp: "2026-08-29T00:00:00.000Z" },
    ];
    expect(filterRebases(points, "2026-08-28", "2026-08-28")).toHaveLength(1);
  });
});
