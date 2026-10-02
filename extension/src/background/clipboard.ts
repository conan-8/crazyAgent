// OS-clipboard writer (background half). Opens a transient offscreen document
// (manifest permission "offscreen", reason CLIPBOARD), hands it the image data
// URL, and closes it again — the service worker itself has no DOM, so
// `navigator.clipboard.write` must run in a document. Failures come back as
// actionable messages: the paste route (`paste_image via:'paste'`) and the
// file-input route never depend on the OS clipboard, so a refusal here is a
// detour, not a dead end.

const OFFSCREEN_PATH = "offscreen/clipboard.html";
const TARGET = "ba-clipboard";
const WRITE_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ClipboardWrite = { ok: true } | { ok: false; error: string };

/**
 * Write an image data URL to the OS clipboard (as PNG — ClipboardItem's one
 * reliable format; the offscreen document converts). Resolves with the write's
 * verdict; never throws.
 */
export async function writeImageToClipboard(dataUrl: string): Promise<ClipboardWrite> {
  if (typeof chrome === "undefined" || !chrome.offscreen?.createDocument) {
    return {
      ok: false,
      error:
        "chrome.offscreen is unavailable in this browser — use via:'paste' (synthetic paste event) or attach to an <input type=\"file\"> ref with via:'file' instead",
    };
  }
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification:
          "Write an agent-staged image to the OS clipboard so it can be pasted into a page",
      });
    }
  } catch (err) {
    return {
      ok: false,
      error: `could not open the offscreen clipboard document: ${String((err as Error)?.message ?? err)}`,
    };
  }
  try {
    // createDocument resolving does not guarantee the document's listener is
    // registered yet — retry the "receiving end does not exist" race briefly.
    let res: unknown = null;
    let lastError = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        res = await Promise.race([
          chrome.runtime.sendMessage({ target: TARGET, dataUrl }),
          sleep(WRITE_TIMEOUT_MS).then(() => {
            throw new Error("the offscreen clipboard document did not answer in time");
          }),
        ]);
        lastError = "";
        break;
      } catch (err) {
        lastError = String((err as Error)?.message ?? err);
        if (!/receiving end does not exist/i.test(lastError)) break;
        await sleep(150);
      }
    }
    if (lastError) return { ok: false, error: lastError };
    const out = res as ClipboardWrite | null;
    if (!out) {
      return { ok: false, error: "the offscreen clipboard document did not answer" };
    }
    return out.ok
      ? { ok: true }
      : {
          ok: false,
          error: `${out.error} — the OS clipboard refused the write (focus or permission); use via:'paste' instead`,
        };
  } finally {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
}
