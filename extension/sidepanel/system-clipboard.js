const PRESERVE_MAX_BYTES = 25_000_000

function clipboardError(code, action, error) {
  const detail = error instanceof Error ? `${error.name || 'Error'}: ${error.message}` : String(error)
  const failure = new Error(`The system clipboard is unavailable for ${action} (${detail}). Keep the side panel focused and allow clipboard access for this extension.`)
  failure.code = code
  return failure
}

function requireClipboard(api) {
  if (!api) throw clipboardError('CLIPBOARD_DENIED', 'access', new Error('navigator.clipboard is unavailable'))
  return api
}

function requireItemConstructor(ctor) {
  if (typeof ctor !== 'function') throw clipboardError('CLIPBOARD_IMAGE_UNSUPPORTED', 'rich image paste', new Error('ClipboardItem is unavailable'))
  return ctor
}

export async function preserveSystemClipboard(api = globalThis.navigator?.clipboard, ClipboardItemCtor = globalThis.ClipboardItem) {
  requireClipboard(api)
  requireItemConstructor(ClipboardItemCtor)
  let read
  try {
    if (typeof api.read !== 'function') throw new Error('navigator.clipboard.read is unavailable')
    read = await api.read()
  } catch (error) {
    throw clipboardError('CLIPBOARD_PRESERVE_FAILED', 'preserving the previous clipboard before image paste', error)
  }
  const items = []
  let bytes = 0
  try {
    for (const item of Array.from(read ?? [])) {
      const entries = []
      for (const type of Array.from(item?.types ?? [])) {
        const blob = await item.getType(type)
        bytes += blob.size
        if (bytes > PRESERVE_MAX_BYTES) {
          const error = new Error(`the previous clipboard exceeds the ${PRESERVE_MAX_BYTES}-byte preservation limit`)
          error.code = 'CLIPBOARD_PRESERVE_FAILED'
          throw error
        }
        entries.push({ type, blob })
      }
      if (entries.length > 0) items.push(entries)
    }
  } catch (error) {
    if (error?.code === 'CLIPBOARD_PRESERVE_FAILED') throw error
    throw clipboardError('CLIPBOARD_PRESERVE_FAILED', 'preserving the previous clipboard before image paste', error)
  }
  return { items }
}

export async function writeImageToSystemClipboard(
  image,
  api = globalThis.navigator?.clipboard,
  ClipboardItemCtor = globalThis.ClipboardItem,
) {
  requireClipboard(api)
  requireItemConstructor(ClipboardItemCtor)
  if (image?.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length === 0) {
    const error = new Error('Rich image paste requires a PNG clipboard entry')
    error.code = 'BAD_CLIPBOARD_IMAGE'
    throw error
  }
  try {
    const blob = await (await fetch(`data:image/png;base64,${image.data}`)).blob()
    await api.write([new ClipboardItemCtor({ 'image/png': blob })])
  } catch (error) {
    throw clipboardError('CLIPBOARD_DENIED', 'staging the agent image for paste', error)
  }
}

export async function writeHtmlToSystemClipboard(
  html,
  text,
  api = globalThis.navigator?.clipboard,
  ClipboardItemCtor = globalThis.ClipboardItem,
  BlobCtor = globalThis.Blob,
) {
  requireClipboard(api)
  requireItemConstructor(ClipboardItemCtor)
  if (typeof html !== 'string' || html.length === 0 || typeof text !== 'string') {
    const error = new Error('Rich table paste requires HTML and a plain-text fallback')
    error.code = 'BAD_CLIPBOARD_HTML'
    throw error
  }
  try {
    await api.write([new ClipboardItemCtor({
      'text/html': new BlobCtor([html], { type: 'text/html' }),
      'text/plain': new BlobCtor([text], { type: 'text/plain' }),
    })])
  } catch (error) {
    throw clipboardError('CLIPBOARD_DENIED', 'staging the agent table for paste', error)
  }
}

export async function restoreSystemClipboard(
  snapshot,
  api = globalThis.navigator?.clipboard,
  ClipboardItemCtor = globalThis.ClipboardItem,
) {
  requireClipboard(api)
  try {
    if (!Array.isArray(snapshot?.items) || snapshot.items.length === 0) {
      if (typeof api.writeText !== 'function') throw new Error('navigator.clipboard.writeText is unavailable')
      await api.writeText('')
      return
    }
    requireItemConstructor(ClipboardItemCtor)
    const items = snapshot.items.map(entries => new ClipboardItemCtor(Object.fromEntries(entries.map(entry => [entry.type, entry.blob]))))
    await api.write(items)
  } catch (error) {
    throw clipboardError('CLIPBOARD_RESTORE_FAILED', 'restoring the previous clipboard after image paste', error)
  }
}
