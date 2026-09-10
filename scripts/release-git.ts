import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

/**
 * Read-only Git access for release verification. Every command here reads
 * the repository (rev-parse, status, ls-files, archive) and sets any option it
 * depends on explicitly, so a plain `git` reproduces the checks for third
 * parties. `GIT_COMMAND` substitutes another executable or wrapper.
 */
export async function resolveGitCommand(): Promise<readonly string[]> {
  const override = process.env.GIT_COMMAND;
  if (override !== undefined && override.trim().length > 0) {
    return override.trim().split(/\s+/);
  }
  return ["git"];
}

function spawnGit(
  command: readonly string[],
  args: readonly string[],
  stdout: "pipe" | number,
): Promise<string> {
  const [executable, ...leading] = command;
  if (executable === undefined) {
    return Promise.reject(new Error("Git command is empty"));
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...leading, ...args], {
      stdio: ["ignore", stdout, "inherit"],
      env: process.env,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(chunks).toString("utf8"));
      } else {
        reject(
          new Error(
            `${executable} ${args.join(" ")} exited with status ${code ?? 1}`,
          ),
        );
      }
    });
  });
}

/** Runs a Git subcommand and returns its standard output. */
export function gitCapture(
  command: readonly string[],
  args: readonly string[],
): Promise<string> {
  return spawnGit(command, args, "pipe");
}

/** Runs a Git subcommand and writes its standard output to `path`. */
export async function gitToFile(
  command: readonly string[],
  args: readonly string[],
  path: string,
): Promise<void> {
  const descriptor = openSync(path, "w", 0o644);
  try {
    await spawnGit(command, args, descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export interface ReleaseCommitVerification {
  readonly commit: string;
  readonly treeHash: string;
  readonly trackedFiles: readonly string[];
}

/**
 * Proves that the working tree being packaged is the named commit: the commit
 * exists, it is HEAD, no tracked file differs from it, and the tracked file
 * list equals the release allowlist. Returns the commit's tree object ID.
 */
export async function verifyReleaseCommit(
  commit: string,
  allowlist: readonly string[],
): Promise<ReleaseCommitVerification> {
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("RELEASE_COMMIT must be a full lowercase Git object ID");
  }
  const git = await resolveGitCommand();
  const resolved = (
    await gitCapture(git, ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`])
  ).trim();
  if (resolved !== commit) {
    throw new Error(`RELEASE_COMMIT ${commit} is not a commit in this repository`);
  }
  const head = (await gitCapture(git, ["rev-parse", "HEAD"])).trim();
  if (head !== commit) {
    throw new Error(`HEAD ${head} is not RELEASE_COMMIT ${commit}`);
  }
  const status = await gitCapture(git, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (status.trim().length > 0) {
    throw new Error(
      `Tracked files differ from RELEASE_COMMIT ${commit}:\n${status.trimEnd()}`,
    );
  }
  const trackedFiles = (await gitCapture(git, ["ls-files", "-z"]))
    .split("\0")
    .filter((path) => path.length > 0)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const allowed = new Set(allowlist);
  const tracked = new Set(trackedFiles);
  const unlisted = trackedFiles.filter((path) => !allowed.has(path));
  const untracked = allowlist.filter((path) => !tracked.has(path));
  if (unlisted.length > 0 || untracked.length > 0) {
    throw new Error(
      [
        "release/source-files.txt does not equal the tracked file list.",
        ...unlisted.map((path) => `  tracked but not listed: ${path}`),
        ...untracked.map((path) => `  listed but not tracked: ${path}`),
      ].join("\n"),
    );
  }
  const treeHash = (await gitCapture(git, ["rev-parse", `${commit}^{tree}`])).trim();
  if (!/^[0-9a-f]{40}$/.test(treeHash)) {
    throw new Error(`Unexpected tree object ID for ${commit}: ${treeHash}`);
  }
  return { commit, treeHash, trackedFiles };
}
