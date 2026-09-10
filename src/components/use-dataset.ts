"use client";

import { useEffect, useState } from "react";
import type { ZodType } from "zod";

import { loadDatasetResult } from "../data/client";

export type DatasetState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; data: T; refreshError?: boolean };

export function useDataset<T>(
  filename: string,
  schema: ZodType<T>,
): DatasetState<T> {
  const [state, setState] = useState<DatasetState<T>>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    const read = () =>
      loadDatasetResult(filename, schema)
        .then(({ data, sourceFailed }) => {
          if (active) {
            setState({ status: "ready", data, refreshError: sourceFailed });
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setState((previous) =>
              previous.status === "ready"
                ? { ...previous, refreshError: true }
                : {
                    status: "error",
                    error:
                      error instanceof Error ? error.message : "unknown error",
                  },
            );
          }
        });
    void read();
    const interval = setInterval(() => void read(), 60_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [filename, schema]);

  return state;
}
