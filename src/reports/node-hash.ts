import { createHash } from "node:crypto";

import { canonicalJson } from "./report";

/** Node-only synchronous companion to the Web Crypto scenario-ID helper. */
export function hashScenarioIdNode(scenario: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(scenario), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
