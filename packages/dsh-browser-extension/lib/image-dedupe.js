import { createHash } from 'node:crypto'

const MAX_SESSIONS = 50

export class ImageDedupe {
  #latestBySession = new Map()

  /**
   * @param {unknown} sessionId
   */
  clear(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return
    this.#latestBySession.delete(sessionId)
  }

  /**
   * @param {unknown} sessionId
   * @param {unknown} image
   * @returns {{attach: boolean, duplicate: boolean}}
   */
  admit(sessionId, image) {
    if (sessionId === undefined || sessionId === null || sessionId === ''
      || typeof image !== 'object' || image === null || Array.isArray(image)
      || typeof image.data !== 'string' || image.data.length === 0
      || typeof image.mimeType !== 'string' || image.mimeType.length === 0) {
      return { attach: true, duplicate: false }
    }

    const fingerprint = createHash('sha256')
      .update(JSON.stringify([image.mimeType, image.data]))
      .digest('hex')
    const duplicate = this.#latestBySession.get(sessionId) === fingerprint
    this.#latestBySession.delete(sessionId)
    this.#latestBySession.set(sessionId, fingerprint)
    if (this.#latestBySession.size > MAX_SESSIONS) {
      const oldest = this.#latestBySession.keys().next().value
      this.#latestBySession.delete(oldest)
    }
    return { attach: !duplicate, duplicate }
  }
}
