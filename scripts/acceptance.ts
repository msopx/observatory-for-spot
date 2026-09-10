import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

import { verifyReleaseCommit } from "./release-git";

// The licence check runs after the static export so that licence banners in
// the emitted browser chunks are reconciled against the notice inventory.
const checks = [
  ["check.typecheck", "typecheck"],
  ["check.lint", "lint"],
  ["check.source-boundary", "check:source"],
  ["check.unit-integration", "test"],
  ["check.static-export", "export-static"],
  ["check.licenses", "check:licenses"],
  ["check.browser", "test:e2e"],
  ["check.privacy", "check:privacy"],
] as const;

interface ReleaseCommitRecord {
  readonly releaseCommit: string;
  readonly releaseTreeHash: string | null;
  /** How the commit value above was established; never a bare label. */
  readonly releaseCommitVerification: string;
}

/**
 * Records RELEASE_COMMIT only when it is proven to describe this tree, either
 * by this run (a Git checkout is available) or by the packager that invoked
 * this run. A Docker acceptance run has no `.git` and reports "unverified".
 */
async function describeReleaseCommit(): Promise<ReleaseCommitRecord> {
  const commit = process.env.RELEASE_COMMIT;
  if (commit === undefined) {
    return {
      releaseCommit: "development",
      releaseTreeHash: null,
      releaseCommitVerification: "no RELEASE_COMMIT supplied",
    };
  }
  if (process.env.RELEASE_COMMIT_VERIFIED === "1") {
    return {
      releaseCommit: commit,
      releaseTreeHash: process.env.RELEASE_TREE_HASH ?? null,
      releaseCommitVerification:
        "verified by package:release against HEAD, the tracked files and release/source-files.txt",
    };
  }
  const allowlist = (await readFile("release/source-files.txt", "utf8"))
    .split("\n")
    .filter((path) => path.length > 0);
  try {
    const verification = await verifyReleaseCommit(commit, allowlist);
    return {
      releaseCommit: verification.commit,
      releaseTreeHash: verification.treeHash,
      releaseCommitVerification:
        "verified by this run: HEAD equals commit, tracked files clean, tracked set equals release/source-files.txt",
    };
  } catch (error) {
    return {
      releaseCommit: "unverified",
      releaseTreeHash: null,
      releaseCommitVerification: `RELEASE_COMMIT ${commit} could not be verified in this environment: ${
        error instanceof Error ? error.message.split("\n")[0] : "unknown error"
      }`,
    };
  }
}

function runScript(script: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function main() {
  const results: {
    id: string;
    script: string;
    status: "pass" | "fail";
  }[] = [];
  for (const [id, script] of checks) {
    const code = await runScript(script);
    results.push({ id, script, status: code === 0 ? "pass" : "fail" });
    if (code !== 0) {
      throw new Error(`${id} failed`);
    }
  }

  const releaseFiles = [
    "public/data/ampl-rebases.json",
    "public/data/ampl-rebases.csv",
    "public/data/broker-state.json",
    "public/data/broker-state.csv",
    "public/data/broker-quotes.json",
    "public/data/broker-quotes.csv",
    "public/data/meta.json",
    "public/data/observatory-manifest.json",
    "public/data/spot-health.json",
    "public/data/spot-health.csv",
    "LICENSE",
    "THIRD-PARTY-NOTICES.txt",
    "TRADEMARKS.md",
    "public/TRADEMARKS.txt",
    "release/release.json",
    "release/refresh-config.json",
  ];
  const releaseFileHashes = Object.fromEntries(
    await Promise.all(
      releaseFiles.map(async (path) => [path, await sha256(path)] as const),
    ),
  );
  const report = {
    schemaVersion: 2,
    result: "pass",
    ...(await describeReleaseCommit()),
    sourceArchiveSha256: process.env.SOURCE_ARCHIVE_SHA256 ?? "not-created",
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      dockerEngine: process.env.DOCKER_ENGINE_VERSION ?? null,
      dockerCompose: process.env.DOCKER_COMPOSE_VERSION ?? null,
    },
    releaseFileHashes,
    checks: results,
    generatedAt: new Date().toISOString(),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/acceptance-report.json",
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  process.stdout.write("acceptance passed\n");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "acceptance failed"}\n`,
  );
  process.exitCode = 1;
});
