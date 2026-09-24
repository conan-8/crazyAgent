#!/usr/bin/env node
// Tiny static server for the fixture site: main origin :8790, cross-origin
// frame origin :8791. Used by phase smoke scripts and (Phase 8) the e2e suite.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "e2e",
  "fixture",
);

function serve(port) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: "REAL" }));
      return;
    }
    if (url === "/api/alt") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: "ALT" }));
      return;
    }
    const file = url === "/" ? "index.html" : path.basename(url);
    try {
      const body = await readFile(path.join(FIXTURE_DIR, file));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}

export function startFixtureServers({ mainPort = 8790, framePort = 8791 } = {}) {
  return {
    main: serve(mainPort),
    frame: serve(framePort),
    mainPort,
    framePort,
    close() {
      for (const s of [this.main, this.frame]) s.close();
    },
  };
}

// Direct execution: `node scripts/fixture-server.mjs`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startFixtureServers();
  console.log("fixture serving on http://127.0.0.1:8790 and :8791");
}
