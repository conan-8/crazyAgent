import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRecord } from './protocol.mjs'

const COMMITTED_TYPES = new Set([
  'chat.user',
  'chat.assistant',
  'chat.tool_call',
  'chat.tool_result',
  'chat.done',
  'chat.stopped',
  'chat.error',
])

/** Bounded companion-owned transcript history; never reads rendered panel HTML. */
export class RemoteHistoryStore {
  constructor(options = {}) {
    this.file = options.file
    this.limit = positive(options.limit, 12)
    this.messageLimit = positive(options.messageLimit, 300)
    this.byteLimit = positive(options.byteLimit, 1_000_000)
    this.log = options.log ?? (() => {})
    this.sessions = []
    this.timer = undefined
    if (this.file !== undefined) this.#load()
  }

  ingest(envelope) {
    if (!isRecord(envelope) || !COMMITTED_TYPES.has(envelope.type)) return false
    const sessionId = validSessionId(envelope.sessionId)
    if (sessionId === undefined || typeof envelope.instanceId !== 'string' || !Number.isSafeInteger(envelope.seq)) return false
    if (!isRecord(envelope.body) || typeof envelope.occurredAt !== 'string') return false

    let record = this.sessions.find(item => item.sessionId === sessionId)
    if (record === undefined) {
      record = {
        sessionId,
        title: 'Untitled chat',
        createdAt: envelope.occurredAt,
        updatedAt: envelope.occurredAt,
        droppedMessages: 0,
        messages: [],
      }
    }
    if (record.messages.some(message => message.instanceId === envelope.instanceId && message.seq === envelope.seq)) return false
    const message = structuredClone(envelope)
    message.sessionId = sessionId
    record.messages.push(message)
    record.updatedAt = envelope.occurredAt
    if (envelope.type === 'chat.user' && record.title === 'Untitled chat' && typeof envelope.body.text === 'string') {
      const title = envelope.body.text.trim().replace(/\s+/gu, ' ')
      if (title.length > 0) record.title = title.slice(0, 140)
    }
    while (record.messages.length > this.messageLimit) {
      record.messages.shift()
      record.droppedMessages += 1
    }
    while (record.messages.length > 1 && Buffer.byteLength(JSON.stringify(record.messages)) > this.byteLimit) {
      record.messages.shift()
      record.droppedMessages += 1
    }
    this.sessions = [record, ...this.sessions.filter(item => item.sessionId !== sessionId)].slice(0, this.limit)
    this.#schedulePersist()
    return true
  }

  summaries() {
    return this.sessions.map(record => ({
      sessionId: record.sessionId,
      title: record.title,
      updatedAt: record.updatedAt,
      messageCount: record.messages.length,
      truncated: record.droppedMessages > 0,
    }))
  }

  transcript(sessionId) {
    const record = this.sessions.find(item => item.sessionId === sessionId)
    return record === undefined ? undefined : structuredClone(record)
  }

  flush() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.file === undefined) return
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const temporary = `${this.file}.tmp-${process.pid}`
      writeFileSync(temporary, JSON.stringify({ v: 1, sessions: this.sessions }), { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch (error) {
      this.log(`remote history: could not save: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  close() {
    this.flush()
  }

  #schedulePersist() {
    if (this.file === undefined || this.timer !== undefined) return
    this.timer = setTimeout(() => this.flush(), 100)
    this.timer.unref?.()
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) return
      this.sessions = parsed.sessions.map(validateRecord).filter(Boolean).slice(0, this.limit)
      for (const record of this.sessions) {
        while (record.messages.length > 1 && Buffer.byteLength(JSON.stringify(record.messages)) > this.byteLimit) {
          record.messages.shift()
          record.droppedMessages += 1
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log(`remote history: could not load: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function validateRecord(value) {
  if (!isRecord(value)) return undefined
  const sessionId = validSessionId(value.sessionId)
  if (sessionId === undefined || !Array.isArray(value.messages)) return undefined
  const messages = value.messages.filter(message =>
    isRecord(message)
    && COMMITTED_TYPES.has(message.type)
    && message.sessionId === sessionId
    && typeof message.instanceId === 'string'
    && Number.isSafeInteger(message.seq)
    && typeof message.occurredAt === 'string'
    && isRecord(message.body),
  ).map(message => structuredClone(message))
  if (messages.length === 0) return undefined
  return {
    sessionId,
    title: typeof value.title === 'string' && value.title.trim().length > 0 ? value.title.slice(0, 140) : 'Untitled chat',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : messages[0].occurredAt,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : messages.at(-1).occurredAt,
    droppedMessages: Number.isSafeInteger(value.droppedMessages) && value.droppedMessages > 0 ? value.droppedMessages : 0,
    messages,
  }
}

function validSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value) ? value : undefined
}

function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
