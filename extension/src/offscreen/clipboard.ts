// Offscreen clipboard document — a transient DOM whose only job is getting an
// image onto the OS clipboard for the agent (the MV3 service worker has
// neither a document nor focus, so `navigator.clipboard.write` is unreachable
// from there). Two routes, in order:
//
//   1. The async Clipboard API (`navigator.clipboard.write` + ClipboardItem).
//      The image is converted to PNG first — the one format ClipboardItem
//      reliably accepts, and the shelf holds JPEGs. This route enforces a
//      document-focus check, which an offscreen document does not always pass
//      ("Document is not focused") — hence route 2.
//   2. The classic extension route: a selected <img> inside a contenteditable
//      holder + `document.execCommand("copy")`, which the extension's
//      clipboardWrite permission allows without a user gesture.
//
// Both failing is reported with the underlying errors so the tool layer can
// point the model at the synthetic-paste route instead.

const TARGET = "ba-clipboard";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every clipboard primitive here can HANG instead of rejecting (measured on
 * headless Linux: `navigator.clipboard.write` without focus, `img.decode` in
 * an invisible document). The caller is waiting on a message response, so each
 * gets its own deadline — a late answer beats no answer.
 */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    sleep(ms).then(() => {
      throw new Error(`${what} timed out after ${ms}ms`);
    }),
  ]);
}

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { target?: string; dataUrl?: string } | null;
  if (m?.target !== TARGET || typeof m.dataUrl !== "string") return false;
  void write(m.dataUrl).then(sendResponse);
  return true; // async response
});

async function write(
  dataUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let png: Blob;
  try {
    png = await toPng(await (await fetch(dataUrl)).blob());
  } catch (err) {
    return { ok: false, error: `could not decode the image: ${String((err as Error)?.message ?? err)}` };
  }
  let apiError = "";
  try {
    // Offscreen documents can sometimes claim focus programmatically; the
    // async clipboard API refuses without it.
    window.focus();
    await withTimeout(
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]),
      5_000,
      "navigator.clipboard.write",
    );
    return { ok: true };
  } catch (err) {
    apiError = String((err as Error)?.message ?? err);
  }
  try {
    if (await execCommandCopyImage(png)) return { ok: true };
    apiError += "; the execCommand('copy') fallback reported failure";
  } catch (err) {
    apiError += `; the execCommand('copy') fallback threw: ${String((err as Error)?.message ?? err)}`;
  }
  return {
    ok: false,
    error: `${apiError} (document.hasFocus()=${document.hasFocus()})`,
  };
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close();
      return blob;
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return await canvas.convertToBlob({ type: "image/png" });
  } catch {
    return blob; // let the write attempt report the real refusal
  }
}

/**
 * Copy the image by selecting it in a hidden contenteditable and running
 * execCommand("copy") — the pre-async-clipboard extension route, permitted
 * without a user gesture by the manifest's clipboardWrite permission.
 */
async function execCommandCopyImage(png: Blob): Promise<boolean> {
  const url = URL.createObjectURL(png);
  const holder = document.createElement("div");
  holder.setAttribute("contenteditable", "true");
  holder.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0.01";
  const img = document.createElement("img");
  img.src = url;
  holder.appendChild(img);
  document.body.appendChild(holder);
  try {
    // the copy only carries pixels once the image has loaded — but a decode
    // that stalls must not strand the caller; try the copy regardless.
    await withTimeout(img.decode(), 3_000, "img.decode").catch(() => undefined);
    holder.focus();
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return document.execCommand("copy");
  } finally {
    window.getSelection()?.removeAllRanges();
    holder.remove();
    URL.revokeObjectURL(url);
  }
}
