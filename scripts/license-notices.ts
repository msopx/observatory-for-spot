import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

interface LockPackage {
  readonly dev?: boolean;
  readonly devOptional?: boolean;
  readonly license?: string;
  readonly resolved?: string;
  readonly version?: string;
}

interface Lockfile {
  readonly lockfileVersion: number;
  readonly packages: Readonly<Record<string, LockPackage>>;
}

interface InstalledPackage {
  /** Set when the component is embedded by another package rather than installed. */
  readonly bundledBy?: string;
  /**
   * "installed": production dependency from the lockfile.
   * "bundled": embedded in emitted assets by an installed dependency.
   * "upstream": protocol source consulted for the arithmetic; see the
   * PROTOCOL PROVENANCE section.
   */
  readonly kind: "installed" | "bundled" | "upstream";
  readonly license: string;
  readonly licenseTexts: readonly string[];
  readonly name: string;
  readonly version: string;
}

interface PackageManifest {
  readonly cpu?: readonly string[];
  readonly license?: string;
  readonly name?: string;
  readonly os?: readonly string[];
  readonly version?: string;
}

const root = process.cwd();
const outputPaths = [
  resolve(root, "THIRD-PARTY-NOTICES.txt"),
  resolve(root, "public/THIRD-PARTY-NOTICES.txt"),
] as const;
/** Next.js embeds this polyfill bundle in the emitted browser assets. */
const polyfillBundlePath = resolve(
  root,
  "node_modules/next/dist/build/polyfills/polyfill-nomodule.js",
);
const hostPlatformPattern =
  /\b(?:darwin|win32|linux|freebsd|android)-(?:arm64|x64|ia32|arm|s390x|ppc64|riscv64)\b/;
/** Free-text provenance record for the protocol arithmetic; maintained by hand. */
const protocolProvenancePath = resolve(root, "release/protocol-provenance.txt");
/**
 * Upstream protocol source notices: `<name>.LICENSE.txt` for a verbatim licence
 * text, `<name>.NOTICE.txt` for a copyright and licence reference.
 */
const upstreamLicenseDirectory = resolve(root, "release/upstream-licenses");
const upstreamNoticeSuffixes = [".LICENSE.txt", ".NOTICE.txt"] as const;
/** Emitted browser chunks, present only after `next build`. */
const emittedChunkDirectory = resolve(root, "out/_next/static/chunks");
/** Licence banners that minifiers preserve: `/*! ... *\/` and `@license` blocks. */
const bannerPattern = /\/\*![\s\S]*?\*\/|\/\*\*?\s*@license[\s\S]*?\*\//g;
/** Component names that appear in banners but are not lockfile package names. */
const bannerAliases = ["core-js", "zloirock"] as const;

const mitLicenseText = (copyright: string) =>
  normalizeText(`${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`);

function asLockfile(value: unknown): Lockfile {
  if (
    typeof value !== "object" ||
    value === null ||
    !("lockfileVersion" in value) ||
    !("packages" in value) ||
    value.lockfileVersion !== 3 ||
    typeof value.packages !== "object" ||
    value.packages === null
  ) {
    throw new Error("package-lock.json must use lockfileVersion 3");
  }
  return value as Lockfile;
}

function asManifest(value: unknown, packagePath: string): PackageManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid package manifest at ${packagePath}`);
  }
  return value as PackageManifest;
}

function normalizeText(value: string): string {
  if (value.includes("\0")) {
    throw new Error("License text contains a NUL byte");
  }
  return `${value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()}\n`;
}

function cleanField(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

async function readLicenseTexts(packageDirectory: string): Promise<string[]> {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  const names = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(licen[cs]e|copying|copyright|notice)(?:[._-].*)?$/i.test(
          entry.name,
        ),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  return Promise.all(
    names.map(async (name) =>
      normalizeText(await readFile(join(packageDirectory, name), "utf8")),
    ),
  );
}

async function readInstalledPackages(
  lockfile: Lockfile,
): Promise<InstalledPackage[]> {
  const packages: InstalledPackage[] = [];
  for (const [packagePath, lockPackage] of Object.entries(lockfile.packages)) {
    if (
      packagePath.length === 0 ||
      lockPackage.dev === true ||
      lockPackage.devOptional === true ||
      !packagePath.startsWith("node_modules/") ||
      packagePath.includes("..")
    ) {
      continue;
    }
    const packageDirectory = resolve(root, packagePath);
    if (!packageDirectory.startsWith(resolve(root, "node_modules/"))) {
      throw new Error(`Unsafe package path: ${packagePath}`);
    }
    let manifestText: string;
    try {
      manifestText = await readFile(
        join(packageDirectory, "package.json"),
        "utf8",
      );
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const manifest = asManifest(JSON.parse(manifestText), packagePath);
    if (Array.isArray(manifest.os) || Array.isArray(manifest.cpu)) {
      // Platform-specific optional binaries are selected by the installing host
      // and are not part of the emitted static site.
      continue;
    }
    const name = manifest.name;
    const version = manifest.version ?? lockPackage.version;
    if (name === undefined || version === undefined) {
      throw new Error(`Package identity missing at ${packagePath}`);
    }
    packages.push({
      kind: "installed",
      name: cleanField(name),
      version: cleanField(version),
      license: cleanField(manifest.license ?? lockPackage.license ?? "UNKNOWN"),
      licenseTexts: await readLicenseTexts(packageDirectory),
    });
  }
  if (packages.length === 0) {
    throw new Error("No installed production dependencies were found");
  }
  return packages.sort((left, right) => {
    const byName = left.name.localeCompare(right.name, "en");
    return byName !== 0
      ? byName
      : left.version.localeCompare(right.version, "en");
  });
}

/** Components embedded in emitted assets without their own installed package. */
async function readBundledComponents(
  packages: readonly InstalledPackage[],
): Promise<InstalledPackage[]> {
  const nextPackage = packages.find((entry) => entry.name === "next");
  if (nextPackage === undefined) {
    throw new Error("next is not an installed production dependency");
  }
  const bundle = await readFile(polyfillBundlePath, "utf8");
  const match =
    /version:"(?<version>[^"]+)",mode:"global",copyright:"(?<copyright>[^"]+)"/.exec(
      bundle,
    );
  if (match?.groups === undefined) {
    throw new Error("core-js identity was not found in the Next.js polyfill");
  }
  const copyright = cleanField(match.groups.copyright!).replace(/^©\s*/, "");
  return [
    {
      bundledBy: `next@${nextPackage.version}`,
      kind: "bundled",
      license: "MIT",
      licenseTexts: [mitLicenseText(`Copyright (c) ${copyright}`)],
      name: "core-js",
      version: cleanField(match.groups.version!),
    },
  ];
}

interface ProtocolProvenance {
  readonly text: string;
  readonly sources: readonly InstalledPackage[];
}

/**
 * The hand-maintained provenance record and the verbatim licence texts of the
 * upstream protocol sources it names. Both are release files, so the generated
 * notices change only when the record or a licence text changes.
 */
async function readProtocolProvenance(): Promise<ProtocolProvenance> {
  const text = normalizeText(await readFile(protocolProvenancePath, "utf8"));
  if (text.trim().length === 0) {
    throw new Error("release/protocol-provenance.txt is empty");
  }
  const entries = await readdir(upstreamLicenseDirectory, {
    withFileTypes: true,
  });
  const names = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        upstreamNoticeSuffixes.some((suffix) => entry.name.endsWith(suffix)),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (names.length === 0) {
    throw new Error(
      "release/upstream-licenses contains no *.LICENSE.txt or *.NOTICE.txt file",
    );
  }
  const sources = await Promise.all(
    names.map(async (fileName): Promise<InstalledPackage> => {
      const noticeText = normalizeText(
        await readFile(join(upstreamLicenseDirectory, fileName), "utf8"),
      );
      const suffix = upstreamNoticeSuffixes.find((candidate) =>
        fileName.endsWith(candidate),
      )!;
      const licenseLine = noticeText
        .split("\n")
        .find((line) => /^licen[cs]e:/i.test(line));
      return {
        kind: "upstream",
        name: fileName.slice(0, -suffix.length),
        version: `release/upstream-licenses/${fileName}`,
        license:
          suffix === ".LICENSE.txt"
            ? cleanField(noticeText.split("\n")[0] ?? "") || "see licence text"
            : cleanField(licenseLine?.replace(/^licen[cs]e:\s*/i, "") ?? "") ||
              "see notice",
        licenseTexts: [noticeText],
      };
    }),
  );
  return { text, sources };
}

function entryLabel(packageInfo: InstalledPackage): string {
  return packageInfo.kind === "upstream"
    ? `upstream source ${packageInfo.name} (${packageInfo.version})`
    : `${packageInfo.name}@${packageInfo.version}`;
}

function renderNotices(
  packages: readonly InstalledPackage[],
  provenance: ProtocolProvenance,
): string {
  const uniquePackages = new Map<string, InstalledPackage>();
  for (const packageInfo of [...packages, ...provenance.sources]) {
    const key = `${packageInfo.kind}\0${packageInfo.name}\0${packageInfo.version}`;
    if (!uniquePackages.has(key)) {
      uniquePackages.set(key, packageInfo);
    }
  }
  const inventory = [...uniquePackages.values()];
  const installed = inventory.filter((entry) => entry.kind === "installed");
  const bundled = inventory.filter((entry) => entry.kind === "bundled");
  const upstream = inventory.filter((entry) => entry.kind === "upstream");
  const texts = new Map<
    string,
    { readonly text: string; readonly packages: string[] }
  >();
  for (const packageInfo of inventory) {
    for (const text of packageInfo.licenseTexts) {
      const hash = createHash("sha256").update(text).digest("hex");
      const label = entryLabel(packageInfo);
      const existing = texts.get(hash);
      if (existing === undefined) {
        texts.set(hash, { text, packages: [label] });
      } else {
        existing.packages.push(label);
      }
    }
  }

  const lines = [
    "Observatory for SPOT — Third-Party Notices",
    "",
    "This release contains or is built from the production dependencies listed",
    "below. Each dependency remains subject to its own license. The inventory is",
    "derived from package-lock.json; development-only packages and optional",
    "platform-specific binaries selected by the installing host are excluded.",
    "Components embedded in the emitted browser assets by a listed dependency",
    "appear under BUNDLED COMPONENTS. Upstream protocol sources consulted for",
    "the protocol arithmetic, and the licence terms that apply to any portion",
    "derived from them, appear under PROTOCOL PROVENANCE.",
    "",
    "PACKAGE INVENTORY",
    "",
    ...installed.map(
      (packageInfo) =>
        `- ${packageInfo.name}@${packageInfo.version} | ${packageInfo.license}`,
    ),
    "",
    "BUNDLED COMPONENTS",
    "",
    ...bundled.map(
      (packageInfo) =>
        `- ${packageInfo.name}@${packageInfo.version} | ${packageInfo.license} | bundled by ${packageInfo.bundledBy}`,
    ),
    "",
    "PROTOCOL PROVENANCE",
    "",
    provenance.text.trimEnd(),
    "",
    "Upstream notices and licence texts reproduced under LICENSE TEXTS:",
    "",
    ...upstream.map(
      (packageInfo) =>
        `- ${packageInfo.name} | ${packageInfo.license} | ${packageInfo.version}`,
    ),
    "",
    "LICENSE TEXTS",
    "",
  ];
  const sortedTexts = [...texts.entries()].sort(([left], [right]) =>
    left.localeCompare(right, "en"),
  );
  for (const [hash, notice] of sortedTexts) {
    lines.push(
      "------------------------------------------------------------------------------",
      `SHA-256: ${hash}`,
      `Applies to: ${notice.packages.sort().join(", ")}`,
      "",
      notice.text.trimEnd(),
      "",
    );
  }
  const output = `${lines.join("\n").trimEnd()}\n`;
  const hostSpecific = hostPlatformPattern.exec(output);
  if (hostSpecific !== null) {
    throw new Error(
      `License notices name a host-specific platform package: ${hostSpecific[0]}`,
    );
  }
  return output;
}

async function checkOutput(path: string, expected: string): Promise<void> {
  let actual: string;
  try {
    actual = await readFile(path, "utf8");
  } catch {
    throw new Error(`Missing generated license notice: ${path}`);
  }
  if (actual !== expected) {
    throw new Error(`License notice is stale: ${path}`);
  }
}

/**
 * Reconciles licence banners that survive minification in the emitted browser
 * chunks against the notice inventory. Every banner must name an inventoried
 * component; an unknown banner fails the check so the shipped artifact, not
 * only the lockfile, is inventoried. Skipped when no static export exists.
 */
async function reconcileEmittedBanners(
  inventory: readonly InstalledPackage[],
): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(emittedChunkDirectory, { recursive: true });
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return "emitted browser chunks are absent; banner reconciliation skipped";
    }
    throw error;
  }
  const knownNames = [
    ...inventory.map((entry) => entry.name.toLowerCase()),
    ...bannerAliases,
  ];
  const unknown: string[] = [];
  let bannerCount = 0;
  let fileCount = 0;
  for (const relativePath of entries) {
    if (!relativePath.endsWith(".js")) {
      continue;
    }
    fileCount += 1;
    const contents = await readFile(
      join(emittedChunkDirectory, relativePath),
      "utf8",
    );
    for (const banner of contents.match(bannerPattern) ?? []) {
      bannerCount += 1;
      const lowered = banner.toLowerCase();
      if (!knownNames.some((name) => lowered.includes(name))) {
        unknown.push(
          `${relativePath}: ${cleanField(banner).slice(0, 200)}`,
        );
      }
    }
  }
  if (unknown.length > 0) {
    throw new Error(
      `Emitted browser chunks carry licence banners for components absent from the notice inventory:\n${unknown.join("\n")}`,
    );
  }
  return `emitted browser chunks reconciled: ${bannerCount} licence banner(s) in ${fileCount} chunk(s) name inventoried components`;
}

async function main(): Promise<void> {
  const lockfile = asLockfile(
    JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8")),
  );
  const installed = await readInstalledPackages(lockfile);
  const bundled = await readBundledComponents(installed);
  const provenance = await readProtocolProvenance();
  const output = renderNotices([...installed, ...bundled], provenance);
  if (process.argv.includes("--check")) {
    await Promise.all(outputPaths.map((path) => checkOutput(path, output)));
    const bannerReport = await reconcileEmittedBanners([
      ...installed,
      ...bundled,
    ]);
    process.stdout.write(
      `license notices match the lockfile inventory, detected bundled components and the protocol provenance record\n${bannerReport}\n`,
    );
    return;
  }
  await Promise.all(
    outputPaths.map((path) =>
      writeFile(path, output, { encoding: "utf8", mode: 0o644 }),
    ),
  );
  process.stdout.write(
    "license notices generated from the lockfile inventory, detected bundled components and the protocol provenance record\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "license notice generation failed"}\n`,
  );
  process.exitCode = 1;
});
