import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";

import { stableJsonStringify } from "../src/data/writers";
import {
  RELEASE_ARCHIVE_PREFIX,
  RELEASE_VERSION,
  SOURCE_ARCHIVE_NAME,
} from "../src/lib/repository";
import {
  gitToFile,
  resolveGitCommand,
  verifyReleaseCommit,
} from "./release-git";

interface PackageManifest {
  readonly version: string;
}

interface ReleaseRecord {
  readonly version: string;
  readonly chainId: number;
  readonly releaseBlock: {
    readonly number: string;
    readonly hash: string;
  };
}

interface PassingReport {
  readonly passed?: boolean;
  readonly result?: string;
}

const artifactsDirectory = resolve("artifacts");

function run(
  command: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with status ${code ?? 1}`));
      }
    });
  });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function gzipTar(tarPath: string, gzipPath: string): Promise<void> {
  const tar = await readFile(tarPath);
  await writeFile(gzipPath, gzipSync(tar, { level: 9 }), {
    mode: 0o644,
  });
  await rm(tarPath);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function assertPassingReport(path: string, label: string): Promise<void> {
  const report = await readJson<PassingReport>(path);
  if (report.passed !== true && report.result !== "pass") {
    throw new Error(`${label} report is not passing`);
  }
}

async function fileRecord(path: string): Promise<{
  readonly bytes: number;
  readonly sha256: string;
}> {
  return {
    bytes: (await stat(path)).size,
    sha256: await sha256(path),
  };
}

async function main(): Promise<void> {
  const packageManifest = await readJson<PackageManifest>("package.json");
  const releaseRecord = await readJson<ReleaseRecord>("release/release.json");
  if (packageManifest.version !== releaseRecord.version) {
    throw new Error("Package and release record versions do not match");
  }
  if (packageManifest.version !== RELEASE_VERSION) {
    throw new Error(
      "package.json version and src/lib/repository.ts RELEASE_VERSION do not match",
    );
  }
  const version = packageManifest.version;
  const commit = process.env.RELEASE_COMMIT;
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("RELEASE_COMMIT must be a full Git object ID");
  }
  const sourceFiles = (await readFile("release/source-files.txt", "utf8"))
    .split("\n")
    .filter((path) => path.length > 0);
  if (
    sourceFiles.length === 0 ||
    new Set(sourceFiles).size !== sourceFiles.length ||
    sourceFiles.some(
      (path) =>
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((segment) => segment === ".."),
    )
  ) {
    throw new Error("release/source-files.txt contains an unsafe path");
  }
  const sortedSourceFiles = [...sourceFiles].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (sourceFiles.some((path, index) => path !== sortedSourceFiles[index])) {
    throw new Error("release/source-files.txt must be sorted");
  }
  for (const path of sourceFiles) {
    if (!(await stat(path)).isFile()) {
      throw new Error(`Release source path is not a file: ${path}`);
    }
  }

  // The packaged bytes must be the named commit: HEAD equals RELEASE_COMMIT,
  // no tracked file differs from it, and the allowlist equals the tracked set.
  const verification = await verifyReleaseCommit(commit, sourceFiles);
  const git = await resolveGitCommand();

  await mkdir(artifactsDirectory, { recursive: true });
  const prefix = RELEASE_ARCHIVE_PREFIX;
  const sourceTar = resolve(artifactsDirectory, `${prefix}-source.tar`);
  const sourceArchive = resolve(artifactsDirectory, SOURCE_ARCHIVE_NAME);
  await rm(sourceTar, { force: true });
  await rm(sourceArchive, { force: true });
  // `git archive` reads the commit's tree object, not the working directory,
  // so the archive cannot contain bytes that the commit does not.
  await gitToFile(
    git,
    [
      "-c",
      "tar.umask=022",
      "archive",
      "--format=tar",
      `--prefix=${prefix}/`,
      verification.commit,
    ],
    sourceTar,
  );
  await gzipTar(sourceTar, sourceArchive);
  const sourceArchiveSha256 = await sha256(sourceArchive);

  await run("npm", ["run", "acceptance"], {
    env: {
      ...process.env,
      RELEASE_COMMIT: commit,
      RELEASE_COMMIT_VERIFIED: "1",
      RELEASE_TREE_HASH: verification.treeHash,
      SOURCE_ARCHIVE_SHA256: sourceArchiveSha256,
    },
  });
  await assertPassingReport(
    resolve(artifactsDirectory, "acceptance-report.json"),
    "Acceptance",
  );
  await assertPassingReport(
    resolve(artifactsDirectory, "rpc-conformance.json"),
    "RPC conformance",
  );
  await assertPassingReport(
    resolve(artifactsDirectory, "release-data-conformance.json"),
    "Release data conformance",
  );

  // Corresponding source travels with the static site: the source archive and
  // its checksum are served under /source/ and are therefore inside the static
  // archive as well.
  const servedSourceDirectory = resolve("out", "source");
  await rm(servedSourceDirectory, { recursive: true, force: true });
  await mkdir(servedSourceDirectory, { recursive: true });
  await copyFile(
    sourceArchive,
    resolve(servedSourceDirectory, SOURCE_ARCHIVE_NAME),
  );
  await writeFile(
    resolve(servedSourceDirectory, `${SOURCE_ARCHIVE_NAME}.sha256`),
    `${sourceArchiveSha256}  ${SOURCE_ARCHIVE_NAME}\n`,
    { encoding: "utf8", mode: 0o644 },
  );

  const staticTar = resolve(artifactsDirectory, `${prefix}-static.tar`);
  const staticArchive = `${staticTar}.gz`;
  await rm(staticTar, { force: true });
  await rm(staticArchive, { force: true });
  await run("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--format=ustar",
    "-cf",
    staticTar,
    "-C",
    "out",
    ".",
  ]);
  await gzipTar(staticTar, staticArchive);

  const dataPaths = [
    "public/data/ampl-rebases.json",
    "public/data/ampl-rebases.csv",
    "public/data/spot-health.json",
    "public/data/spot-health.csv",
    "public/data/broker-state.json",
    "public/data/broker-state.csv",
    "public/data/broker-quotes.json",
    "public/data/broker-quotes.csv",
    "public/data/meta.json",
  ] as const;
  const evidencePaths = [
    "artifacts/acceptance-report.json",
    "artifacts/rpc-conformance.json",
    "artifacts/release-data-conformance.json",
  ] as const;
  const configurationPaths = [
    "release/release.json",
    "release/refresh-config.json",
  ] as const;
  const data = Object.fromEntries(
    await Promise.all(
      dataPaths.map(async (path) => [path, await fileRecord(path)] as const),
    ),
  );
  const evidence = Object.fromEntries(
    await Promise.all(
      evidencePaths.map(
        async (path) => [path, await fileRecord(path)] as const,
      ),
    ),
  );
  const configuration = Object.fromEntries(
    await Promise.all(
      configurationPaths.map(
        async (path) => [path, await fileRecord(path)] as const,
      ),
    ),
  );
  const archives = {
    [sourceArchive.slice(`${artifactsDirectory}/`.length)]:
      await fileRecord(sourceArchive),
    [staticArchive.slice(`${artifactsDirectory}/`.length)]:
      await fileRecord(staticArchive),
  };
  const manifestPath = resolve(artifactsDirectory, "release-manifest.json");
  await writeFile(
    manifestPath,
    stableJsonStringify({
      schemaVersion: 2,
      release: {
        version,
        commit,
        treeHash: verification.treeHash,
        commitVerification:
          "HEAD equals commit; tracked files clean; tracked set equals release/source-files.txt; source archive read from the commit tree",
        chainId: releaseRecord.chainId,
        blockNumber: releaseRecord.releaseBlock.number,
        blockHash: releaseRecord.releaseBlock.hash,
      },
      archives,
      correspondingSource: {
        servedPath: `source/${SOURCE_ARCHIVE_NAME}`,
        checksumPath: `source/${SOURCE_ARCHIVE_NAME}.sha256`,
        sha256: sourceArchiveSha256,
      },
      configuration,
      data,
      evidence,
    }),
    { encoding: "utf8", mode: 0o644 },
  );

  const bundleTar = resolve(artifactsDirectory, `${prefix}-release.tar`);
  const bundle = `${bundleTar}.gz`;
  await rm(bundleTar, { force: true });
  await rm(bundle, { force: true });
  const bundleEntries = [
    sourceArchive.slice(`${artifactsDirectory}/`.length),
    staticArchive.slice(`${artifactsDirectory}/`.length),
    "acceptance-report.json",
    "rpc-conformance.json",
    "release-data-conformance.json",
    "release-manifest.json",
  ];
  await run("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--format=ustar",
    "-cf",
    bundleTar,
    "-C",
    artifactsDirectory,
    ...bundleEntries,
  ]);
  await gzipTar(bundleTar, bundle);

  const checksums = await Promise.all(
    [
      sourceArchive,
      staticArchive,
      manifestPath,
      ...evidencePaths.map((path) => resolve(path)),
      bundle,
    ].map(async (path) => ({
      name: path.slice(`${artifactsDirectory}/`.length),
      hash: await sha256(path),
    })),
  );
  await writeFile(
    resolve(artifactsDirectory, "SHA256SUMS"),
    `${checksums
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map(({ hash, name }) => `${hash}  ${name}`)
      .join("\n")}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  process.stdout.write(
    stableJsonStringify({
      status: "ok",
      version,
      commit,
      treeHash: verification.treeHash,
      sourceArchiveSha256,
      releaseBundleSha256: await sha256(bundle),
    }),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "release packaging failed"}\n`,
  );
  process.exitCode = 1;
});
