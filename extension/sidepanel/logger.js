/**
 * Buffered client-side debug logger.
 *
 * Events are sent to the companion as `log.event` frames. If the bridge is not
 * connected yet (or drops), events stay in a bounded buffer and flush after the
 * next hello. The companion does the authoritative redaction and persistence.
 */

export class ClientLogger {
  /**
   * @param {{ send: (frame: Record<string, unknown>) => boolean, context?: Record<string, unknown>, maxBuffer?: number }} options
   */
  constructor(options) {
    this.send = options.send
    this.context = options.context ?? {}
    this.maxBuffer = options.maxBuffer ?? 500
    this.ready = false
    /** @type {Array<Record<string, unknown>>} */
    this.buffer = []
  }

  /** @param {boolean} ready */
  setReady(ready) {
    this.ready = ready === true
    if (this.ready) this.flush()
  }

  /** @param {Record<string, unknown>} context */
  setContext(context) {
    this.context = { ...this.context, ...context }
    this.log('app.context', this.context, 'info')
  }

  /**
   * @param {string} type
   * @param {unknown} data
   * @param {'debug'|'info'|'warn'|'error'} [severity]
   * @param {Record<string, unknown>} [meta]
   */
  log(type, data, severity = 'debug', meta = {}) {
    const frame = {
      v: 1,
      type: 'log.event',
      event: {
        source: 'extension',
        type,
        severity,
        time: Date.now(),
        ...meta,
        data,
      },
    }
    if (this.ready) {
      try {
        if (this.send(frame)) return
      } catch {
        // Fall through to the buffer.
      }
    }
    if (this.buffer.length >= this.maxBuffer) this.buffer.shift()
    this.buffer.push(frame)
  }

  flush() {
    if (!this.ready || this.buffer.length === 0) return
    const frames = this.buffer
    this.buffer = []
    for (const frame of frames) {
      try {
        if (!this.send(frame)) this.buffer.push(frame)
      } catch {
        this.buffer.push(frame)
      }
    }
  }

  get pending() {
    return this.buffer.length
  }
}