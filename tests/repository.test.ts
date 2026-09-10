import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  RELEASE_ARCHIVE_PREFIX,
  RELEASE_TAG,
  RELEASE_TREE_URL,
  RELEASE_VERSION,
  REPOSITORY_URL,
  SOURCE_ARCHIVE_CHECKSUM_PATH,
  SOURCE_ARCHIVE_NAME,
  SOURCE_ARCHIVE_PATH,
} from "../src/lib/repository";

async function readVersion(path: string): Promise<string> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as {
    version?: unknown;
  };
  expect(typeof parsed.version).toBe("string");
  return parsed.version as string;
}

describe("release identity", () => {
  it("matches the package and release record versions", async () => {
    expect(await readVersion("package.json")).toBe(RELEASE_VERSION);
    expect(await readVersion("release/release.json")).toBe(RELEASE_VERSION);
    expect(RELEASE_TAG).toBe(`v${RELEASE_VERSION}`);
  });

  it("links corresponding source to the exact tag and the served archive", () => {
    expect(REPOSITORY_URL).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    expect(RELEASE_TREE_URL).toBe(`${REPOSITORY_URL}/tree/${RELEASE_TAG}`);
    expect(RELEASE_ARCHIVE_PREFIX).toBe(`observatory-for-spot-${RELEASE_VERSION}`);
    expect(SOURCE_ARCHIVE_NAME).toBe(`${RELEASE_ARCHIVE_PREFIX}-source.tar.gz`);
    expect(SOURCE_ARCHIVE_PATH).toBe(`/source/${SOURCE_ARCHIVE_NAME}`);
    expect(SOURCE_ARCHIVE_CHECKSUM_PATH).toBe(`${SOURCE_ARCHIVE_PATH}.sha256`);
  });
});
