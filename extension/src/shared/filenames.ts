// Filename hygiene for anything the agent writes to disk (screenshots, later
// exports): always a bare name, never a path the page could steer.

/** The bare name part of a model-supplied filename, or a timestamped fallback. */
export function safeBasename(raw: unknown, fallbackPrefix: string): string {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-");
  const base =
    typeof raw === "string" && raw.trim() ? (raw.trim().split(/[\\/]/).pop() ?? "") : "";
  return base || `${fallbackPrefix}-${stamp}`;
}

/**
 * A sanitised filename with an enforced extension: path parts are dropped, an
 * extension of the right family is kept as-is, anything else gets `ext`
 * appended (so "shot.png" never silently becomes "shot.png.jpg").
 */
export function safeFilename(
  raw: unknown,
  ext: string,
  fallbackPrefix: string,
  keepRe: RegExp = new RegExp(`\\.${ext}$`, "i"),
): string {
  const name = safeBasename(raw, fallbackPrefix);
  return keepRe.test(name) ? name : `${name}.${ext}`;
}

/** Screenshots always land as .jpg (the bytes the tool captures are JPEG). */
export function screenshotFilename(raw: unknown): string {
  return `${safeBasename(raw, "screenshot").replace(/\.(jpe?g|png|webp|gif)$/i, "")}.jpg`;
}
