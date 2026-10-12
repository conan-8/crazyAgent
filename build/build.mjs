// Build pipeline: bundles extension sources (background SW, content script,
// side panel) with esbuild and copies static assets into dist/.
// Usage: node build/build.mjs [--watch] [--no-sourcemap] [--outdir <path>]
// `--no-sourcemap` is for release artifacts: the maps carry the original
// TypeScript, so a build meant to be handed to someone else omits them.
// `--outdir` lets a caller (scripts/package.mjs) build a release tree without
// disturbing the developer's own dist/.
import { build, context } from "esbuild";
import { execSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "extension");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

const outFlag = process.argv.indexOf("--outdir");
// outDir is `rm -rf`'d below, so a valueless --outdir must never resolve to
// the repo root.
if (outFlag !== -1 && !process.argv[outFlag + 1]) {
  console.error("[build] --outdir needs a path");
  process.exit(1);
}
const outDir =
  outFlag === -1 ? dist : path.resolve(root, process.argv[outFlag + 1]);

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
  sourcemap: !process.argv.includes("--no-sourcemap"),
  target: "chrome114",
  format: "iife",
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "info",
  entryPoints: [
    { in: path.join(ext, "src/background/sw.ts"), out: "background/sw" },
    { in: path.join(ext, "src/content/main.ts"), out: "content/main" },
    { in: path.join(ext, "src/sidepanel/main.tsx"), out: "sidepanel/main" },
    { in: path.join(ext, "src/offscreen/clipboard.ts"), out: "offscreen/clipboard" },
  ],
  outdir: outDir,
};

async function copyStatic() {
  await mkdir(outDir, { recursive: true });
  // Stamp the commit into the built manifest (`version_name`) — never the
  // source manifest, so a rebuild is the only thing that can change it.
  const manifest = JSON.parse(
    await readFile(path.join(ext, "manifest.json"), "utf8"),
  );
  manifest.version_name = stamp;
  await writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const f of ["index.html", "styles.css"]) {
    await cp(path.join(ext, "src/sidepanel", f), path.join(outDir, "sidepanel", f));
  }
  // Toolbar/manifest icons (regenerate with `node scripts/make-icons.mjs`).
  await cp(path.join(ext, "icons"), path.join(outDir, "icons"), { recursive: true });
  await mkdir(path.join(outDir, "offscreen"), { recursive: true });
  await cp(
    path.join(ext, "src/offscreen/clipboard.html"),
    path.join(outDir, "offscreen/clipboard.html"),
  );
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log("[build] watching…");
} else {
  await rm(outDir, { recursive: true, force: true });
  await build(options);
  await copyStatic();
  console.log(
    `[build] complete → ${path.relative(root, outDir)}/ (build ${stamp})`,
  );
}
