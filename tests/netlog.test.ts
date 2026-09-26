import { describe, expect, it } from "vitest";
import { NetLog, NETLOG_MAX } from "../extension/src/background/netlog";

function logEvent(log: NetLog, tabId: number, text: string, type = "log") {
  log.handle(tabId, "Runtime.consoleAPICalled", {
    type,
    args: [{ value: text }],
    stackTrace: { callFrames: [{ url: "http://x/page.js", lineNumber: 3 }] },
  });
}

describe("NetLog console capture", () => {
  it("keeps console calls with their level and source", () => {
    const log = new NetLog();
    logEvent(log, 1, "hello");
    logEvent(log, 1, "careful", "warning");
    const entries = log.readConsole(1);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: "log", text: "hello", url: "http://x/page.js" });
    expect(entries[1]?.level).toBe("warning");
  });

  it("records uncaught exceptions as errors with the exception text", () => {
    const log = new NetLog();
    log.handle(1, "Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
    });
    expect(log.readConsole(1)[0]).toMatchObject({ level: "error", text: "TypeError: boom" });
  });

  it("filters by level, limits to the newest entries and clears per tab", () => {
    const log = new NetLog();
    logEvent(log, 1, "a");
    logEvent(log, 1, "b", "error");
    logEvent(log, 2, "other tab");
    expect(log.readConsole(1, { level: "error" }).map((e) => e.text)).toEqual(["b"]);
    expect(log.readConsole(1, { limit: 1 }).map((e) => e.text)).toEqual(["b"]);
    expect(log.readConsole(2)).toHaveLength(1);
    log.clear(1);
    expect(log.readConsole(1)).toHaveLength(0);
    expect(log.readConsole(2)).toHaveLength(1);
  });

  it("caps the buffer instead of growing without bound", () => {
    const log = new NetLog();
    for (let i = 0; i < NETLOG_MAX + 25; i++) logEvent(log, 1, `m${i}`);
    const entries = log.readConsole(1);
    expect(entries).toHaveLength(NETLOG_MAX);
    expect(entries[0]?.text).toBe(`m${NETLOG_MAX + 25 - NETLOG_MAX}`);
    expect(entries.at(-1)?.text).toBe(`m${NETLOG_MAX + 24}`);
  });
});

describe("NetLog network capture", () => {
  const request = (log: NetLog, id: string, url: string) =>
    log.handle(1, "Network.requestWillBeSent", { requestId: id, request: { method: "GET", url } });
  const response = (log: NetLog, id: string, status: number) =>
    log.handle(1, "Network.responseReceived", { requestId: id, response: { status, mimeType: "text/html" } });

  it("joins request and response halves into one entry", () => {
    const log = new NetLog();
    request(log, "r1", "http://x/api/data");
    response(log, "r1", 200);
    const [entry] = log.readNetwork(1);
    expect(entry).toMatchObject({
      method: "GET",
      url: "http://x/api/data",
      status: 200,
      ok: true,
      mime: "text/html",
    });
  });

  it("reports failed loads as failures with the error text", () => {
    const log = new NetLog();
    request(log, "r1", "http://x/gone");
    log.handle(1, "Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_ABORTED" });
    expect(log.readNetwork(1)[0]).toMatchObject({ ok: false, error: "net::ERR_ABORTED" });
  });

  it("filters by URL substring", () => {
    const log = new NetLog();
    request(log, "r1", "http://x/api/a");
    response(log, "r1", 200);
    request(log, "r2", "http://x/static/b.css");
    response(log, "r2", 200);
    expect(log.readNetwork(1, { urlFilter: "/api/" }).map((e) => e.url)).toEqual([
      "http://x/api/a",
    ]);
  });
});
