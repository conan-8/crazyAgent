/**
 * The glowing yellow cursor shown on the page while the agent works.
 *
 * It is decoration only: `pointer-events:none`, inert, and hidden from every
 * screenshot, so it cannot affect a click, a guard, or what the model sees. It
 * is never a substitute for the trusted input that follows it, and a cursor
 * failure must never fail an action.
 */

/**
 * Serialized into the page, so it must not reference module state. Everything
 * after the first insertion happens inside a closed shadow root, which a
 * page's (or our own) document MutationObserver cannot see.
 * @param {'ensure'|'move'|'hide'|'show'|'stop'|'read'} command
 * @param {{x?: number, y?: number, press?: boolean, maxMs?: number}} [options]
 */
export function agentCursorPage(command, options = {}) {
  const KEY = '__crazyagentCursor'
  const existing = globalThis[KEY]
  if (command === 'stop' && !existing) return { ok: true, present: false }
  if (command === 'read' && !existing) return { ok: true, present: false }

  const create = () => {
    existing?.dispose()
    const TTL_MS = 15_000
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const div = css => {
      const node = document.createElement('div')
      node.style.cssText = css
      return node
    }

    const host = document.createElement('div')
    host.setAttribute('data-crazyagent-cursor', '')
    host.setAttribute('aria-hidden', 'true')
    host.inert = true
    host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;left:0!important;top:0!important;'
      + 'width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;'
      + 'background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;'
    const root = host.attachShadow({ mode: 'closed' })
    const mover = div('position:absolute;left:0;top:0;width:0;height:0;will-change:transform;opacity:0;')
    const halo = div('position:absolute;left:-34px;top:-34px;width:72px;height:72px;border-radius:50%;will-change:transform,opacity;'
      + 'background:radial-gradient(circle,rgba(255,195,0,.5) 0,rgba(255,195,0,.2) 38%,rgba(255,195,0,0) 70%);')
    const ring = div('position:absolute;left:-20px;top:-20px;width:40px;height:40px;box-sizing:border-box;border-radius:50%;opacity:0;'
      + 'border:2px solid #ffc300;box-shadow:0 0 16px rgba(255,195,0,.85),inset 0 0 8px rgba(255,195,0,.5);will-change:transform,opacity;')
    const arrow = div('position:absolute;left:-2px;top:-2px;width:26px;height:26px;transform-origin:2px 2px;will-change:transform;'
      + 'filter:drop-shadow(0 0 4px rgba(255,195,0,.95)) drop-shadow(0 0 12px rgba(255,195,0,.6));')
    const SVG = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 32 32')
    svg.setAttribute('width', '26')
    svg.setAttribute('height', '26')
    svg.style.overflow = 'visible'
    // A wider black copy underneath is the border, so it follows the rounded corners.
    const border = document.createElementNS(SVG, 'path')
    border.setAttribute('d', 'M2.2 2.2 29.8 15.8 15.2 17.4 12.4 29.8Z')
    border.setAttribute('fill', '#000')
    border.setAttribute('stroke', '#000')
    border.setAttribute('stroke-width', '5.8')
    border.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(border)
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', 'M2.2 2.2 29.8 15.8 15.2 17.4 12.4 29.8Z')
    path.setAttribute('fill', '#ffc300')
    // Same shape as icons/cursor.svg: the wide round-joined stroke rounds the corners.
    path.setAttribute('stroke', '#ffc300')
    path.setAttribute('stroke-width', '2.6')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    arrow.appendChild(svg)
    mover.append(halo, ring, arrow)
    root.appendChild(mover)
    document.documentElement.appendChild(host)

    const clampX = value => Math.max(0, Math.min(window.innerWidth - 1, value))
    const clampY = value => Math.max(0, Math.min(window.innerHeight - 1, value))
    const state = {
      x: Number.isFinite(options.x) ? clampX(options.x) : window.innerWidth * 0.62,
      y: Number.isFinite(options.y) ? clampY(options.y) : window.innerHeight * 0.42,
      motion: null,
      moveToken: 0,
      hidden: 0,
      pingAt: performance.now(),
      disposed: false,
    }
    const place = () => { mover.style.transform = `translate(${state.x}px,${state.y}px)` }
    place()

    // Stop any running path where it is, so the next one starts from there.
    const halt = () => {
      if (!state.motion) return
      const matrix = new DOMMatrixReadOnly(getComputedStyle(mover).transform)
      state.motion.onfinish = null
      state.motion.cancel()
      state.motion = null
      state.x = matrix.m41
      state.y = matrix.m42
      place()
    }

    const curve = (p0, c1, c2, p3, t) => {
      const u = 1 - t
      const point = key => u * u * u * p0[key] + 3 * u * u * t * c1[key] + 3 * u * t * t * c2[key] + t * t * t * p3[key]
      return { x: point('x'), y: point('y') }
    }

    // Sampled keyframes on `transform` run on the compositor, so the cursor stays
    // smooth even while the page's own main thread is busy.
    const travel = (p0, c1, c2, p3, durationMs, ease) => {
      const samples = Math.max(8, Math.min(180, Math.ceil(durationMs / 24)))
      const frames = []
      for (let index = 0; index <= samples; index += 1) {
        const at = curve(p0, c1, c2, p3, ease(index / samples))
        frames.push({ transform: `translate(${at.x}px,${at.y}px)` })
      }
      const motion = mover.animate(frames, { duration: durationMs, easing: 'linear', fill: 'both' })
      state.motion = motion
      motion.onfinish = () => {
        if (state.motion !== motion) return
        state.motion = null
        state.x = p3.x
        state.y = p3.y
        place()
        motion.cancel()
      }
    }

    const press = () => {
      if (reduced) return
      // `add` multiplies onto the breathing, so the size never jumps.
      arrow.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.8)', offset: 0.35 }, { transform: 'scale(1)' }],
        { duration: 240, easing: 'cubic-bezier(.2,0,0,1)', composite: 'add' },
      )
      ring.animate(
        [{ transform: 'scale(.3)', opacity: 0.95 }, { transform: 'scale(1.5)', opacity: 0 }],
        { duration: 460, easing: 'cubic-bezier(.2,0,0,1)' },
      )
      halo.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.4)', offset: 0.3 }, { transform: 'scale(1)' }],
        { duration: 460, easing: 'cubic-bezier(.2,0,0,1)', composite: 'add' },
      )
    }

    // Anything the page has since put in the top layer would otherwise cover us.
    const raise = () => {
      if (!document.querySelector(':modal, :popover-open:not([data-crazyagent-cursor])')) return
      try {
        host.hidePopover()
        host.showPopover()
      } catch { /* z-index still applies */ }
    }

    const fade = (opacity, ms) => {
      mover.style.transition = `opacity ${ms}ms linear`
      mover.style.opacity = String(opacity)
    }

    const cursor = {
      host,
      ping() { state.pingAt = performance.now() },
      raise,
      read() {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(mover).transform)
        return {
          ok: true,
          present: true,
          x: matrix.m41,
          y: matrix.m42,
          opacity: Number(getComputedStyle(mover).opacity),
          moving: state.motion !== null,
          hidden: state.hidden,
        }
      },
      move({ x, y, press: pressing = false, maxMs = 460 }) {
        halt()
        const token = ++state.moveToken
        const to = { x: clampX(Number(x)), y: clampY(Number(y)) }
        const from = { x: state.x, y: state.y }
        const dx = to.x - from.x
        const dy = to.y - from.y
        const distance = Math.hypot(dx, dy)
        const arrive = () => {
          if (pressing && token === state.moveToken) press()
        }
        if (reduced || document.hidden || distance < 2) {
          state.x = to.x
          state.y = to.y
          place()
          arrive()
          return Promise.resolve(cursor.read())
        }
        const durationMs = Math.min(Math.max(1, maxMs), Math.max(190, Math.min(460, 170 + distance * 0.28)))
        const bow = Math.min(distance * 0.14, 70) * (Math.random() < 0.5 ? -1 : 1)
        const nx = -dy / distance
        const ny = dx / distance
        const c1 = { x: from.x + dx * 0.33 + nx * bow, y: from.y + dy * 0.33 + ny * bow }
        const c2 = { x: from.x + dx * 0.72 + nx * bow * 0.7, y: from.y + dy * 0.72 + ny * bow * 0.7 }
        travel(from, c1, c2, to, durationMs, t => t * t * t * (10 + t * (6 * t - 15)))
        // A timer, not `finished`: arrival must not wait on a throttled background tab.
        return new Promise(resolve => setTimeout(() => {
          arrive()
          resolve(cursor.read())
        }, durationMs))
      },
      async hide() {
        state.hidden += 1
        if (document.hidden) return cursor.read()
        fade(0, 60)
        await Promise.race([
          new Promise(resolve => setTimeout(() => {
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          }, 64)),
          new Promise(resolve => setTimeout(resolve, 130)),
        ])
        return cursor.read()
      },
      show() {
        state.hidden = Math.max(0, state.hidden - 1)
        if (state.hidden === 0) fade(1, 180)
        return cursor.read()
      },
      dispose() {
        if (state.disposed) return
        state.disposed = true
        clearInterval(watchdog)
        window.removeEventListener('resize', onResize)
        host.remove()
        if (globalThis[KEY] === cursor) delete globalThis[KEY]
      },
      stop() {
        fade(0, 200)
        state.hidden = 1
        setTimeout(() => cursor.dispose(), 220)
        return { ok: true, present: false }
      },
    }

    const onResize = () => {
      halt()
      state.x = clampX(state.x)
      state.y = clampY(state.y)
      place()
    }
    window.addEventListener('resize', onResize)
    // If the extension goes away mid-turn, nothing would ever stop this.
    const watchdog = setInterval(() => {
      if (performance.now() - state.pingAt > TTL_MS) cursor.dispose()
    }, 2_000)

    try {
      host.popover = 'manual'
      host.showPopover()
    } catch { /* z-index still applies */ }
    if (!reduced) {
      // Arrow and glow share one slow breath, anchored at the tip so it keeps pointing at the same spot.
      const breath = { duration: 1_500, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' }
      arrow.animate([{ transform: 'scale(.84)' }, { transform: 'scale(1.18)' }], breath)
      halo.animate([{ transform: 'scale(.82)', opacity: 0.55 }, { transform: 'scale(1.14)', opacity: 1 }], breath)
    }
    requestAnimationFrame(() => {
      if (state.hidden === 0) fade(1, 240)
    })
    globalThis[KEY] = cursor
    return cursor
  }

  const cursor = existing?.host?.isConnected ? existing : create()
  cursor.ping()
  switch (command) {
    case 'move':
      cursor.raise()
      return cursor.move(options)
    case 'hide':
      return cursor.hide()
    case 'show':
      return cursor.show()
    case 'stop':
      return cursor.stop()
    case 'read':
      return cursor.read()
    default:
      cursor.raise()
      return cursor.read()
  }
}

const PING_MS = 4_000
const COMMAND_TIMEOUT_MS = 800

/**
 * Owns the cursor for one agent turn at a time, following the active tab.
 * Every method swallows its own failures: restricted pages simply have no cursor.
 * @param {{run: Function, activeTabId: () => Promise<number>}} deps
 */
export function createAgentCursor({ run, activeTabId }) {
  let active = false
  let tabId
  let position
  let pingTimer = null

  const send = async (id, command, options = {}, timeoutMs = COMMAND_TIMEOUT_MS) => {
    try {
      const result = await run(id, agentCursorPage, [command, { ...position, ...options }], timeoutMs)
      if (Number.isFinite(result?.x) && Number.isFinite(result?.y)) position = { x: result.x, y: result.y }
      return result
    } catch {
      return undefined
    }
  }

  const useTab = async id => {
    if (tabId === id) return
    const previous = tabId
    tabId = id
    if (previous !== undefined) void send(previous, 'stop')
  }

  /** Put the cursor on whichever tab the agent is now looking at. */
  const follow = async () => {
    if (!active) return
    const id = await activeTabId().catch(() => undefined)
    if (!active || id === undefined) return
    await useTab(id)
    await send(id, 'ensure')
  }

  return {
    isActive: () => active,
    follow,

    start() {
      if (active) return
      active = true
      void follow()
      pingTimer = setInterval(() => { void follow() }, PING_MS)
      pingTimer.unref?.()
    },

    stop() {
      if (!active) return
      active = false
      clearInterval(pingTimer)
      pingTimer = null
      if (tabId !== undefined) void send(tabId, 'stop')
      tabId = undefined
    },

    /** Glide to top-level viewport CSS coordinates; resolves on arrival. */
    async moveTo(id, x, y, { press = false, maxMs } = {}) {
      if (!active) return
      await useTab(id)
      await send(id, 'move', { x, y, press, ...(maxMs === undefined ? {} : { maxMs }) })
      position = { x, y }
    },

    /** Run a capture with the cursor out of the picture. */
    async whileHidden(id, capture) {
      if (!active) return capture()
      await useTab(id)
      await send(id, 'hide', {}, 300)
      try {
        return await capture()
      } finally {
        void send(id, 'show')
      }
    },
  }
}
