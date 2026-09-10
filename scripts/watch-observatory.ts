import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { main as refresh } from "./refresh-observatory";

/** Long-running local collector; the browser continues to serve static files. */
async function watch() {
  const setting = process.env.OBSERVATORY_REFRESH_MINUTES ?? "60";
  if (!/^[1-9][0-9]*$/.test(setting) || Number(setting) > 1440)
    throw new Error("Refresh interval must be 1 to 1440 minutes");
  const directory = resolve(
    process.env.OBSERVATORY_DATA_DIRECTORY || "public/data",
  );
  await mkdir(directory, { recursive: true });
  const lock = resolve(directory, ".observatory-collector-lock");
  await mkdir(lock).catch(() => {
    throw new Error(
      "A background collector is already running, or its lock needs operator review",
    );
  });
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    while (!stop.signal.aborted) {
      try {
        process.exitCode = 0;
        await refresh();
      } catch {
        process.stdout.write(
          JSON.stringify({
            status: "error",
            message: "Refresh attempt failed; published observations retained",
            attemptedAt: new Date().toISOString(),
          }) + "\n",
        );
      }
      process.exitCode = 0;
      if (stop.signal.aborted) break;
      try {
        await delay(Number(setting) * 60_000, undefined, {
          signal: stop.signal,
        });
      } catch {
        break;
      }
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    await rm(lock, { recursive: true, force: true });
  }
}
watch().catch(() => {
  process.stderr.write(
    "Collector could not start. Check interval, data directory and collector lock.\n",
  );
  process.exitCode = 1;
});
