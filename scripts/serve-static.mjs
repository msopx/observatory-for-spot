import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.env.STATIC_ROOT ?? "out");
const port = Number(process.env.PORT ?? "4173");
const host = process.env.HOST ?? "127.0.0.1";
const types = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function textResponse(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/** Streams a file with the given status; failures degrade to plain text. */
function streamFile(response, target, status) {
  let stream;
  try {
    stream = createReadStream(target);
  } catch {
    textResponse(response, 500, "file unavailable");
    return;
  }
  stream.once("error", () => {
    if (response.headersSent) response.destroy();
    else if (!response.destroyed)
      textResponse(response, 500, "file unavailable");
  });
  stream.once("open", () => {
    if (response.destroyed) {
      stream.destroy();
      return;
    }
    response.writeHead(status, {
      "cache-control": "no-store",
      "content-type": types[extname(target)] ?? "application/octet-stream",
    });
    stream.pipe(response);
  });
  response.once("close", () => stream.destroy());
}

createServer((request, response) => {
  let rawPath;
  try {
    // A fixed parsing base avoids trusting Host for local filesystem routing.
    rawPath = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    if (rawPath.includes("\0")) throw new URIError("Invalid path");
  } catch {
    textResponse(response, 400, "bad request");
    return;
  }
  const normalized = normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let target = join(root, normalized);
  try {
    if (
      target.endsWith("/") ||
      (existsSync(target) && statSync(target).isDirectory())
    ) {
      target = join(target, "index.html");
    }
    if (!target.startsWith(`${root}/`) || !isFile(target)) {
      // The static export's own 404 page keeps the site chrome and notices;
      // a build without one still answers with a plain 404.
      const notFoundPage = join(root, "404.html");
      if (isFile(notFoundPage)) {
        streamFile(response, notFoundPage, 404);
      } else {
        textResponse(response, 404, "not found");
      }
      return;
    }
  } catch {
    textResponse(response, 500, "file unavailable");
    return;
  }

  streamFile(response, target, 200);
}).listen(port, host, () => {
  process.stdout.write(`static server listening on http://${host}:${port}\n`);
});
