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
          ? `Update v${latest} ready; installs when crazyAgent is idle.`
          : 'Update ready; installs when crazyAgent is idle.',
      }
    case 'installing':
      return {
        key: `installing:${latest ?? 'unknown'}`,
        tone: 'info',
        text: latest
          ? `Updating to v${latest}… Companion will restart.`
          : 'Updating… Companion will restart.',
      }
    case 'available':
      return {
        key: `available:${latest ?? 'unknown'}`,
        tone: 'info',
        text: latest
          ? `Update v${latest} available. Start with the supervisor to install automatically.`
          : 'Update available. Start with the supervisor to install automatically.',
      }
    case 'error': {
      const detail = reason(status.reason)
      return { key: `error:${detail}`, tone: 'error', text: `Automatic update failed: ${detail}` }
    }
    default:
      return null
  }
}

export function settingsUpdateDetails(status, fallbackVersion) {
  const current = version(status?.current) ?? version(fallbackVersion)
  const last = status?.last
  const at = last !== null && typeof last === 'object' && !Array.isArray(last) && typeof last.at === 'string'
    ? Date.parse(last.at)
    : NaN
  return {
    version: current,
    updatedAt: Number.isFinite(at) ? new Date(at).toISOString() : null,
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
    text: `Updated to v${to}; companion restarted.`,
  }
}
