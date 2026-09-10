import { sha256 } from "viem";

/** SHA-256 of unchanged bytes (UTF-8 for strings), as lowercase unprefixed hex.
 * Uses viem's pure JavaScript implementation on HTTP and HTTPS origins alike.
 */
export function sha256Hex(value: string | Uint8Array): string {
  return sha256(
    typeof value === "string" ? new TextEncoder().encode(value) : value,
  ).slice(2);
}
