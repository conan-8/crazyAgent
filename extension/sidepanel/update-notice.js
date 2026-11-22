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

export function settingsUpdateAction(status, { connected = true, requesting = false } = {}) {
  const safeStatus = status !== null && typeof status === 'object' && !Array.isArray(status) ? status : null
  const current = version(safeStatus?.current)
  const latest = version(safeStatus?.latest)
  if (!connected) {
    return {
      label: 'Check for updates',
      action: 'check',
      disabled: true,
      primary: false,
      statusText: 'Connect to the companion to check for updates.',
      tone: 'muted',
    }
  }
  if (requesting || safeStatus?.state === 'checking') {
    return {
      label: 'Checking…',
      action: 'check',
      disabled: true,
      primary: false,
      statusText: 'Checking GitHub for a newer release…',
      tone: 'muted',
    }
  }
  switch (safeStatus?.state) {
    case 'installing':
      return {
        label: 'Updating…',
        action: 'install',
        disabled: true,
        primary: false,
        statusText: latest ? `Installing v${latest}… Companion will restart.` : 'Installing update… Companion will restart.',
        tone: 'info',
      }
    case 'pending':
      return {
        label: latest ? `Update to v${latest}` : 'Install update',
        action: 'install',
        disabled: false,
        primary: true,
        statusText: latest ? `v${latest} is ready to install now.` : 'An update is ready to install now.',
        tone: 'info',
      }
    case 'available':
      return {
        label: 'Check for updates',
        action: 'check',
        disabled: false,
        primary: false,
        statusText: latest
          ? `v${latest} available. Start with "npm run dev" or the service to install.`
          : 'Update available. Start with the supervisor to install.',
        tone: 'info',
      }
    case 'current':
      return {
        label: 'Check for updates',
        action: 'check',
        disabled: false,
        primary: false,
        statusText: current ? `Up to date (v${current}).` : 'Up to date.',
        tone: 'muted',
      }
    case 'ineligible':
      return {
        label: 'Check for updates',
        action: 'check',
        disabled: false,
        primary: false,
        statusText: `Unavailable: ${reason(safeStatus.reason)}`,
        tone: 'muted',
      }
    case 'disabled':
      return {
        label: 'Check for updates',
        action: 'check',
        disabled: true,
        primary: false,
        statusText: `Disabled: ${reason(safeStatus.reason)}`,
        tone: 'muted',
      }
    case 'error':
      return {
        label: 'Check for updates',
        action: 'check',
        disabled: false,
        primary: false,
        statusText: `Update check failed: ${reason(safeStatus.reason)}`,
        tone: 'error',
      }
    default:
      return {
        label: 'Check for updates',
        action: 'check',
        disabled: false,
        primary: false,
        statusText: '',
        tone: 'muted',
      }
  }
}
