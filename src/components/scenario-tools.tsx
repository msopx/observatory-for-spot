"use client";
import { useRef, useState } from "react";
import {
  createScenarioReport,
  importScenarioReport,
  replayAnalyticsScenario,
  serializeScenarioReport,
  type ScenarioProvenance,
} from "../analytics/scenarios";
import { downloadFile } from "../lib/display";
export function ScenarioTools({
  modelVersion,
  provenance,
  assumptions,
  inputs,
  outputs,
  exportLabel = "Export scenario",
  importLabel = "Import & replay",
}: {
  modelVersion: string;
  provenance: ScenarioProvenance;
  assumptions: string[];
  inputs: unknown;
  outputs: unknown;
  exportLabel?: string;
  importLabel?: string;
}) {
  const [message, setMessage] = useState("");
  const [imported, setImported] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="button-row">
        <button
          type="button"
          onClick={async () => {
            try {
              const report = await createScenarioReport({
                modelVersion,
                provenance,
                assumptions,
                inputs,
                expectedOutputs: outputs,
              });
              downloadFile(
                `${modelVersion}-scenario.json`,
                serializeScenarioReport(report),
              );
              setMessage(
                "Scenario saved with inputs, assumptions, provenance and results.",
              );
            } catch {
              setMessage("Scenario could not be exported.");
            }
          }}
        >
          {exportLabel}
        </button>
        <button
          className="secondary"
          type="button"
          onClick={() => file.current?.click()}
        >
          {importLabel}
        </button>
        <input
          ref={file}
          type="file"
          aria-label={importLabel}
          accept="application/json,.json"
          hidden
          onChange={async (event) => {
            const selected = event.target.files?.[0];
            if (!selected) return;
            try {
              if (selected.size > 2_000_000)
                throw new Error("Scenario exceeds the 2 MB limit.");
              const report = await importScenarioReport(await selected.text());
              if (report.payload.modelVersion !== modelVersion)
                throw new Error(
                  "This report uses a different model. Open its matching analysis page.",
                );
              const replay = await replayAnalyticsScenario(report);
              if (!replay.matchesExpected)
                throw new Error("Recomputed outputs do not match this report.");
              setImported(serializeScenarioReport(report));
              setMessage(
                "Scenario loaded; results reproduced from its inputs. Imported provenance is self-declared and was not re-read from the chain.",
              );
            } catch (error) {
              setImported(null);
              setMessage(
                error instanceof Error
                  ? error.message
                  : "Unable to import report.",
              );
            }
            event.target.value = "";
          }}
        />
      </div>
      {message ? (
        <p className="small muted" role="status">
          {message}
        </p>
      ) : null}
      {imported ? (
        <details>
          <summary>
            Replayed report: inputs, assumptions and outputs
          </summary>
          <pre>{imported}</pre>
        </details>
      ) : null}
    </>
  );
}
