import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const sourceFiles = (
  await readFile("release/source-files.txt", "utf8")
)
  .split("\n")
  .filter((path) => path.length > 0);

const forbiddenPaths = sourceFiles.filter(
  (path) =>
    path.endsWith(".sol") ||
    path === ".gitmodules" ||
    path.split("/").some((segment) =>
      ["node_modules", "vendor", "vendored"].includes(segment),
    ),
);
if (forbiddenPaths.length > 0) {
  throw new Error(
    `Excluded content path in source boundary: ${forbiddenPaths[0]}`,
  );
}

const implementationExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);
for (const path of sourceFiles) {
  if (
    path === "scripts/check-source-boundary.ts" ||
    !implementationExtensions.has(extname(path))
  ) {
    continue;
  }
  const contents = await readFile(path, "utf8");
  if (/pragma\s+solidity/.test(contents)) {
    throw new Error(`Excluded content marker in ${path}`);
  }
}

process.stdout.write(
  "source boundary check passed: the release allowlist contains no Solidity file, submodule manifest, vendored directory or `pragma solidity` marker (this check does not assess authorship or licensing; see THIRD-PARTY-NOTICES.txt, PROTOCOL PROVENANCE)\n",
);
