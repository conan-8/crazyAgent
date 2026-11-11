/**
 * Shared wording for unknown-argument rejections in the executor. It mirrors
 * the provider's formatter: name the stray key and list what is accepted.
 * @param {string} context
 * @param {Record<string, unknown>} value
 * @param {Iterable<string>} allowed
 * @returns {string | undefined} the message, or undefined when every key is allowed
 */
export function unknownArgumentMessage(context, value, allowed) {
  const list = [...allowed]
  const unknown = Object.keys(value ?? {}).find(key => !list.includes(key))
  if (unknown === undefined) return undefined
  return `${context} received unknown argument ${JSON.stringify(unknown)}. Allowed: ${list.join(', ')}`
}
