import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Pattern scan for selected identity and secret leaks in text files, plus
 * structural checks of the static export and of release archives. It matches
 * only the patterns listed here; a pass is not a legal, privacy or identity
 * clearance and the success message says so.
 */

const root = process.cwd();
const ignored = new Set([
  ".git",
  ".next",
  ".repo-keys",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const textExtensions = new Set([
  "",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".md",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const forbidden = [
  { label: "macOS home path", pattern: /\/Users\/[^/\s]+/g },
  { label: "Linux home path", pattern: /\/home\/[A-Za-z_][\w.-]*\//g },
  { label: "private key", pattern: /BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY/g },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: "embedded RPC secret",
    pattern: /ETHEREUM_RPC_URL\s*=\s*https?:\/\/\S+/g,
  },
];
/** Archive entries that must never ship in a release archive. */
const forbiddenArchiveSegments = new Set([
  ".git",
  ".repo-keys",
  "node_modules",
  ".next",
  "artifacts",
]);
const staticExportDirectory = join(root, "out");
const archiveDirectory = join(root, "artifacts");

async function listFiles(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}

async function isScannableText(path: string): Promise<boolean> {
  return (
    textExtensions.has(extname(path)) && (await stat(path)).size < 5_000_000
  );
}

async function scanText(paths: readonly string[]): Promise<string[]> {
  const violations: string[] = [];
  for (const path of paths) {
    if (
      relative(root, path) === "scripts/privacy-scan.ts" ||
      !(await isScannableText(path))
    ) {
      continue;
    }
    const contents = await readFile(path, "utf8");
    for (const rule of forbidden) {
      const matches = contents.match(rule.pattern);
      if (matches) {
        violations.push(
          `${relative(root, path)}: ${rule.label} (${matches.length})`,
        );
      }
    }
  }
  return violations;
}

/** Source maps would expose original paths and source; the export must not carry any. */
function scanSourceMaps(paths: readonly string[]): string[] {
  return paths
    .filter(
      (path) =>
        path.startsWith(`${staticExportDirectory}/`) && path.endsWith(".map"),
    )
    .map((path) => `${relative(root, path)}: source map in static export`);
}

function headerString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function headerOctal(header: Buffer, start: number, length: number): number {
  const text = headerString(header, start, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

/**
 * Walks a ustar/pax tar stream and reports forbidden paths, non-root owners
 * and named owners. Nested `.tar.gz` members (the release bundle) are walked
 * one level deep.
 */
function inspectTar(
  bytes: Buffer,
  label: string,
  violations: string[],
  depth: number,
): number {
  let entries = 0;
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const name = headerString(header, 0, 100);
    const prefix = headerString(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = headerOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const uid = headerOctal(header, 108, 8);
    const gid = headerOctal(header, 116, 8);
    const uname = headerString(header, 265, 32);
    const gname = headerString(header, 297, 32);
    entries += 1;

    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => forbiddenArchiveSegments.has(segment))) {
      violations.push(`${label}: forbidden archive entry ${path}`);
    }
    const leaf = segments.at(-1) ?? "";
    if (/^\.env(?:\..+)?$/.test(leaf) && leaf !== ".env.example") {
      violations.push(`${label}: environment file ${path}`);
    }
    if (uid !== 0 || gid !== 0) {
      violations.push(`${label}: ${path} has owner ${uid}:${gid}`);
    }
    if ((uname.length > 0 && uname !== "root") || (gname.length > 0 && gname !== "root")) {
      violations.push(`${label}: ${path} names owner ${uname || "-"}:${gname || "-"}`);
    }

    const dataStart = offset + 512;
    if (depth < 1 && (typeflag === "0" || typeflag === "\0") && path.endsWith(".tar.gz")) {
      try {
        entries += inspectTar(
          gunzipSync(bytes.subarray(dataStart, dataStart + size)),
          `${label}!${path}`,
          violations,
          depth + 1,
        );
      } catch (error) {
        violations.push(
          `${label}: nested archive ${path} could not be read (${error instanceof Error ? error.message : "unknown error"})`,
        );
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function scanArchives(): Promise<{ violations: string[]; summary: string }> {
  let names: string[];
  try {
    names = (await readdir(archiveDirectory)).filter((name) =>
      name.endsWith(".tar.gz"),
    );
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return { violations: [], summary: "no release archives present" };
    }
    throw error;
  }
  const violations: string[] = [];
  let entries = 0;
  for (const name of names.sort()) {
    const path = join(archiveDirectory, name);
    entries += inspectTar(
      gunzipSync(await readFile(path)),
      relative(root, path),
      violations,
      0,
    );
  }
  return {
    violations,
    summary: `${names.length} release archive(s) inspected, ${entries} entr(y/ies) checked for forbidden paths and owner metadata`,
  };
}

async function main() {
  const paths = await listFiles(root);
  const textViolations = await scanText(paths);
  const mapViolations = scanSourceMaps(paths);
  const archives = await scanArchives();
  const violations = [
    ...textViolations,
    ...mapViolations,
    ...archives.violations,
  ];
  if (violations.length > 0) {
    throw new Error(`privacy scan failed:\n${violations.join("\n")}`);
  }
  process.stdout.write(
    [
      "privacy pattern scan passed (selected home-path, key and RPC-secret patterns only; not a legal, privacy or identity clearance)",
      `static export: ${paths.some((path) => path.startsWith(`${staticExportDirectory}/`)) ? "present, no source maps" : "absent"}`,
      `archives: ${archives.summary}`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "privacy scan failed"}\n`,
  );
  process.exitCode = 1;
});
