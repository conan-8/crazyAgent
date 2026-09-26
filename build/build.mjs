// Build pipeline: bundles extension sources (background SW, content script,
// side panel) with esbuild and copies static assets into dist/.
// Usage: node build/build.mjs [--watch]
import { build, context } from "esbuild";
import { execSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

/**
 * Which commit this build is: the short git sha plus a `-dirty` marker when the
 * tree had uncommitted changes, so a build made from modified sources can never
 * masquerade as a clean commit. Falls back to "unknown" when git is unavailable
 * (a source zip, a checkout without history). Written into the built manifest's
 * `version_name`, which chrome://extensions displays and the Settings drawer
 * reads back — the loaded build always reports the truth about itself.
 */
function buildStamp() {
  try {
    const sha = execSync("git rev-parse --short=7 HEAD", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain", {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const stamp = buildStamp();

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
  // Stamp the commit into the built manifest (`version_name`) — never the
  // source manifest, so a rebuild is the only thing that can change it.
  const manifest = JSON.parse(
    await readFile(path.join(ext, "manifest.json"), "utf8"),
  );
  manifest.version_name = stamp;
  await writeFile(
    path.join(dist, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
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
  console.log(`[build] complete → dist/ (build ${stamp})`);
}
