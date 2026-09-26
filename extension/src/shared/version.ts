// Build identity — which commit the loaded extension was built from.
//
// The stamp is produced by build/build.mjs (git rev-parse + a dirty marker)
// and written into the built manifest as `version_name`, so the same string is
// visible in chrome://extensions ("0.1.0 (116599e)") and in the Settings
// drawer. Pure formatting here so it is unit-testable and the panel stays a
// dumb renderer.

export interface BuildIdentity {
  /** manifest.json `version`. */
  version: string;
  /** manifest.json `version_name` — the git stamp, when the build ran with git. */
  stamp?: string;
}

/** The Settings-drawer line, e.g. `Version 0.1.0 · build 116599e`. */
export function versionLabel({ version, stamp }: BuildIdentity): string {
  const build = stamp?.trim() || "unknown (rebuild dist to stamp)";
  return `Version ${version} · build ${build}`;
}

/** What chrome://extensions shows under the name, when it shows the raw parts. */
export function isStamped(stamp?: string): boolean {
  return Boolean(stamp && stamp.trim() && stamp.trim() !== "unknown");
}
