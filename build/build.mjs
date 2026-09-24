// Build pipeline: bundles extension sources (background SW, content script,
// side panel) with esbuild and copies static assets into dist/.
// Usage: node build/build.mjs [--watch]
import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

const options = {
  bundle: true,
  sourcemap: true,
  target: "chrome114",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
  entryPoints: [
    { in: path.join(ext, "src/background/sw.ts"), out: "background/sw" },
    { in: path.join(ext, "src/content/main.ts"), out: "content/main" },
    { in: path.join(ext, "src/sidepanel/main.tsx"), out: "sidepanel/main" },
  ],
  outdir: dist,
};

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await cp(path.join(ext, "manifest.json"), path.join(dist, "manifest.json"));
  for (const f of ["index.html", "styles.css"]) {
    await cp(path.join(ext, "src/sidepanel", f), path.join(dist, "sidepanel", f));
  }
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log("[build] watching…");
} else {
  await rm(dist, { recursive: true, force: true });
  await build(options);
  await copyStatic();
  console.log("[build] complete → dist/");
}
