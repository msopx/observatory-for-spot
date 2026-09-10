import { z } from "zod";
import { canonicalJson, hashScenarioId } from "../reports/report";
import { benchmarkLpNotes, reconcileLpLedger } from "./lp";

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const scenarioProvenanceSchema = z
  .object({
    chainId: uint,
    observations: z
      .array(
        z
          .object({
            blockNumber: uint,
            blockHash: hash,
            /** ISO UTC observation timestamp. */
            timestamp: z.iso.datetime(),
            contracts: z
              .array(
                z
                  .object({
                    address,
                    implementationAddress: address.nullable(),
                    runtimeCodeHash: hash,
                    interfaceVersion: z.string().min(1).max(120),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
    datasets: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
            sha256: digest,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type ScenarioProvenance = z.infer<typeof scenarioProvenanceSchema>;

const payloadSchema = z
  .object({
    schema: z.literal("observatory-for-spot/scenario-v1"),
    modelVersion: z.string().regex(/^[a-z0-9][a-z0-9-]*-v[1-9]\d*$/),
    provenance: scenarioProvenanceSchema,
    assumptions: z.array(z.string().min(1).max(1_000)).min(1),
    inputs: z
      .unknown()
      .refine((value) => value !== undefined, "Inputs are required"),
    expectedOutputs: z
      .unknown()
      .refine((value) => value !== undefined, "Expected outputs are required"),
  })
  .strict();

const reportSchema = z
  .object({
    scenarioId: digest,
    payload: payloadSchema,
  })
  .strict();

export type ScenarioReport = z.infer<typeof reportSchema>;

/**
 * Contains complete calculation inputs, result, assumptions and state identity.
 * JSON strings carry all integers. The digest is an integrity identifier, not
 * a signature or proof that the supplied chain observations are authentic.
 */
export async function createScenarioReport(input: {
  readonly modelVersion: string;
  readonly provenance: ScenarioProvenance;
  readonly assumptions: readonly string[];
  readonly inputs: unknown;
  readonly expectedOutputs: unknown;
}): Promise<ScenarioReport> {
  const payload = payloadSchema.parse(
    JSON.parse(
      canonicalJson({
        schema: "observatory-for-spot/scenario-v1",
        ...input,
      }),
    ),
  );
  return { scenarioId: await hashScenarioId(payload), payload };
}

export function serializeScenarioReport(report: ScenarioReport): string {
  return `${canonicalJson(reportSchema.parse(report))}\n`;
}

/** Rejects malformed/oversized reports, ambiguous numbers and changed payloads. */
export async function importScenarioReport(
  text: string,
): Promise<ScenarioReport> {
  if (new TextEncoder().encode(text).byteLength > 2_000_000)
    throw new RangeError("Scenario report exceeds the 2 MB import limit");
  const report = reportSchema.parse(JSON.parse(text));
  // Also rejects numbers nested in inputs/outputs rather than silently losing precision.
  const actual = await hashScenarioId(report.payload);
  if (report.scenarioId !== actual)
    throw new Error("Scenario payload does not match its identifier");
  return report;
}

/** Replay always parses untrusted inputs through the model's decoder. */
export async function replayScenario<TInput, TOutput>(
  report: ScenarioReport,
  model: {
    readonly modelVersion: string;
    readonly parseInput: (input: unknown) => TInput;
    readonly evaluate: (input: TInput) => TOutput;
  },
) {
  const checked = await importScenarioReport(serializeScenarioReport(report));
  if (checked.payload.modelVersion !== model.modelVersion)
    throw new Error("Unsupported scenario model version");
  const output = model.evaluate(model.parseInput(checked.payload.inputs));
  return {
    result: output,
    matchesExpected:
      canonicalJson(output) === canonicalJson(checked.payload.expectedOutputs),
    /** Replay only proves deterministic calculation, not chain provenance. */
    provenanceVerification: "not-verified" as const,
  };
}

const exactUint = uint.transform(BigInt);
const endpointSchema = z
  .object({
    blockNumber: exactUint,
    timestamp: exactUint,
    usdc: exactUint,
    spot: exactUint,
    lpSupply: exactUint,
    usdcPrice: exactUint,
    spotFmv: exactUint,
  })
  .strict();

export const lpBenchmarkInputSchema = z
  .object({
    start: endpointSchema,
    end: endpointSchema,
    lpAmount: exactUint,
  })
  .strict();

export const lpLedgerInputSchema = z
  .object({
    start: endpointSchema,
    end: endpointSchema,
    coverage: z.enum(["complete", "partial"]),
    events: z.array(
      z
        .object({
          blockNumber: exactUint,
          logIndex: exactUint,
          transactionHash: hash,
          kind: z.enum(["swap", "deposit", "withdrawal", "transfer", "other"]),
          usdcDelta: z
            .string()
            .regex(/^(0|-?[1-9]\d*)$/)
            .transform(BigInt),
          spotDelta: z
            .string()
            .regex(/^(0|-?[1-9]\d*)$/)
            .transform(BigInt),
          lpSupplyDelta: z
            .string()
            .regex(/^(0|-?[1-9]\d*)$/)
            .transform(BigInt),
          fee: z
            .object({
              asset: z.enum(["usdc", "spot"]),
              amount: z
                .string()
                .regex(/^(0|-?[1-9]\d*)$/)
                .transform(BigInt),
              protocolAmount: exactUint,
              evidence: z.literal("transaction-verified"),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export async function replayAnalyticsScenario(report: ScenarioReport) {
  switch (report.payload.modelVersion) {
    case "broker-balance-ledger-v1":
      return replayScenario(report, {
        modelVersion: "broker-balance-ledger-v1",
        parseInput: (input) => lpLedgerInputSchema.parse(input),
        evaluate: reconcileLpLedger,
      });
    case "fixed-lp-notes-v1":
      return replayScenario(report, {
        modelVersion: "fixed-lp-notes-v1",
        parseInput: (input) => lpBenchmarkInputSchema.parse(input),
        evaluate: benchmarkLpNotes,
      });
    default:
      throw new Error("Unsupported analytical scenario model version");
  }
}
