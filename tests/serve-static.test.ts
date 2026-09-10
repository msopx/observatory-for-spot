import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const mocked = vi.hoisted(() => ({
  handler: undefined as Handler | undefined,
  createReadStream: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("node:fs", () => ({
  createReadStream: mocked.createReadStream,
  existsSync: mocked.existsSync,
  statSync: mocked.statSync,
}));
vi.mock("node:http", () => ({
  createServer: (handler: Handler) => {
    mocked.handler = handler;
    return { listen: mocked.listen };
  },
}));

beforeAll(async () => {
  // @ts-expect-error The dependency-free runtime entry point is plain JavaScript.
  await import("../scripts/serve-static.mjs");
});
beforeEach(() => {
  mocked.createReadStream.mockReset();
  mocked.existsSync.mockReset().mockReturnValue(true);
  mocked.statSync.mockReset().mockReturnValue({
    isDirectory: () => false,
    isFile: () => true,
  });
});

function response() {
  const result = Object.assign(new EventEmitter(), {
    headersSent: false,
    destroyed: false,
    writeHead: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  result.writeHead.mockImplementation(() => {
    result.headersSent = true;
  });
  result.destroy.mockImplementation(() => {
    result.destroyed = true;
  });
  return result;
}
function stream() {
  return Object.assign(new EventEmitter(), { pipe: vi.fn(), destroy: vi.fn() });
}
function request(path: string, target = response()) {
  mocked.handler!(
    { url: path, headers: { host: "%" } } as IncomingMessage,
    target as unknown as ServerResponse,
  );
  return target;
}

describe("static server request isolation", () => {
  it.each(["/%ZZ", "/%E0%A4%A", "/%00"])(
    "returns 400 for malformed path %s without touching files",
    (path) => {
      const target = response();
      expect(() => request(path, target)).not.toThrow();
      expect(target.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(target.end).toHaveBeenCalledWith("bad request\n");
      expect(mocked.existsSync).not.toHaveBeenCalled();
      expect(mocked.createReadStream).not.toHaveBeenCalled();
    },
  );

  it("serves the next valid request after a malformed one without trusting Host", () => {
    request("/%ZZ");
    const file = stream();
    mocked.createReadStream.mockReturnValue(file);
    const target = request("/data/observatory-manifest.json");
    expect(target.writeHead).not.toHaveBeenCalled();
    file.emit("open");
    expect(target.writeHead).toHaveBeenCalledWith(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    expect(file.pipe).toHaveBeenCalledWith(target);
    expect(mocked.listen).toHaveBeenCalledTimes(1);
  });

  it("returns a generic 500 when opening the file fails before headers", () => {
    const file = stream();
    mocked.createReadStream.mockReturnValue(file);
    const target = request("/index.html");
    expect(() =>
      file.emit("error", new Error("internal filesystem detail")),
    ).not.toThrow();
    expect(target.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(target.end).toHaveBeenCalledWith("file unavailable\n");
    expect(file.pipe).not.toHaveBeenCalled();
  });

  it("closes an interrupted transfer after headers instead of emitting a false success body", () => {
    const file = stream();
    mocked.createReadStream.mockReturnValue(file);
    const target = request("/index.html");
    file.emit("open");
    expect(() => file.emit("error", new Error("read failed"))).not.toThrow();
    expect(target.destroy).toHaveBeenCalledOnce();
    expect(target.writeHead).toHaveBeenCalledTimes(1);
    expect(target.end).not.toHaveBeenCalled();
  });

  it("stops reading when the client closes the response", () => {
    const file = stream();
    mocked.createReadStream.mockReturnValue(file);
    const target = request("/index.html");
    target.emit("close");
    expect(file.destroy).toHaveBeenCalledOnce();
  });

  it("serves the export's own 404 page, with a 404 status, for unknown routes", () => {
    mocked.existsSync.mockImplementation((path: unknown) =>
      String(path).endsWith("/404.html"),
    );
    const file = stream();
    mocked.createReadStream.mockReturnValue(file);
    const target = request("/no-such-page/");
    expect(mocked.createReadStream).toHaveBeenCalledWith(
      expect.stringMatching(/\/404\.html$/),
    );
    file.emit("open");
    expect(target.writeHead).toHaveBeenCalledWith(404, {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
    });
    expect(file.pipe).toHaveBeenCalledWith(target);
  });

  it("handles a metadata read failure and still serves missing paths as 404", () => {
    mocked.statSync.mockImplementationOnce(() => {
      throw new Error("metadata unavailable");
    });
    const failed = request("/index.html");
    expect(failed.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    mocked.existsSync.mockReturnValue(false);
    const missing = request("/missing.html");
    expect(missing.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(mocked.createReadStream).not.toHaveBeenCalled();
  });
});
