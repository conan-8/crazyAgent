const VERSION = /^v?\d{1,6}(?:\.\d{1,6}){2}$/u

function version(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return VERSION.test(text) ? text.replace(/^v/u, '') : null
}

function reason(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return (text || 'unknown error').slice(0, 240)
}

export function updateNotice(status) {
  if (status === null || typeof status !== 'object' || Array.isArray(status)) return null
  const latest = version(status.latest)
  switch (status.state) {
    case 'pending':
      return {
        key: `pending:${latest ?? 'unknown'}`,
        tone: 'info',
        text: latest
          ? `Update v${latest} is ready. It will install automatically when crazyAgent is idle.`
          : 'An update is ready. It will install automatically when crazyAgent is idle.',
      }
    case 'installing':
      return {
        key: `installing:${latest ?? 'unknown'}`,
        tone: 'info',
        text: latest
          ? `Updating to v${latest}… The companion will restart automatically.`
          : 'Updating… The companion will restart automatically.',
      }
    case 'available':
      return {
        key: `available:${latest ?? 'unknown'}`,
        tone: 'info',
        text: latest
          ? `Update v${latest} is available. Start the companion with its supervisor to enable automatic installation.`
          : 'An update is available. Start the companion with its supervisor to enable automatic installation.',
      }
    case 'error': {
      const detail = reason(status.reason)
      return { key: `error:${detail}`, tone: 'error', text: `Automatic update failed: ${detail}` }
    }
    default:
      return null
  }
}

export function completedUpdateNotice(status) {
  if (status === null || typeof status !== 'object' || Array.isArray(status)) return null
  const last = status.last
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return null
  const to = version(last.to)
  const from = version(last.from)
  const at = typeof last.at === 'string' ? last.at : ''
  if (!to || !from || !Number.isFinite(Date.parse(at))) return null
  return {
    key: `${from}:${to}:${at}`,
    text: `Updated to v${to}. The companion restarted automatically.`,
  }
}
