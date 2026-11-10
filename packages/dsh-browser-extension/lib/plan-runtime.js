import { randomUUID } from 'node:crypto'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import {
  BROWSER_PLAN_TOOL,
  createPlanState,
  decidePlanFinalAnswer,
  recordPlanActivity,
  replacePlan,
  summarizePlan,
} from './plan.js'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function turnKey(sessionId, turn) {
  return `${String(sessionId)}\0${turn}`
}

function sameItems(current, candidate) {
  return Array.isArray(candidate)
    && current.length === candidate.length
    && current.every((item, index) => isRecord(candidate[index])
      && typeof candidate[index].content === 'string'
      && candidate[index].content.trim() === item.content
      && candidate[index].status === item.status)
}

function callId(data) {
  const message = isRecord(data?.message) ? data.message : {}
  const source = isRecord(message.source) ? message.source : {}
  return message.toolCallId ?? source.callId ?? data?.callId
}

function planError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function runtimeMessage(text, summary) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    source: Object.freeze({ kind: 'runtime-context', form: 'notice', summary }),
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
  })
}

function toolContent(plan, prefix) {
  const summary = summarizePlan(plan.state)
  return {
    content: [{
      type: 'text',
      text: `${prefix}\n${summary.text}\nUse expected_revision:${summary.revision} for the next browser_plan replacement.`,
    }],
    structuredContent: {
      revision: summary.revision,
      items: plan.state.items.map(item => ({ ...item })),
      counts: { ...summary.counts },
      active: summary.active ? { ...summary.active } : null,
    },
  }
}

export function createPlanRuntime({ ctx, bridge }) {
  let pendingTurnId = null
  let active = null
  let disposed = false

  const log = (type, data, severity = 'info') => {
    bridge.logEvent(type, data, severity)
  }

  function cleanup(plan, reason) {
    if (active === plan) active = null
    if (!plan.unregister) return
    try {
      plan.unregister()
    } catch (error) {
      log('plan.mode.cleanup_error', {
        turnId: plan.turnId,
        message: error instanceof Error ? error.message : String(error),
      }, 'warn')
    }
    plan.unregister = null
    if (reason) log('plan.mode.ended', { turnId: plan.turnId, reason })
  }

  function setMode(frame) {
    if (disposed) return
    if (frame?.enabled !== true || typeof frame.turnId !== 'string' || frame.turnId.length === 0) {
      pendingTurnId = null
      return
    }
    if (active?.turnId === frame.turnId) return
    pendingTurnId = frame.turnId
  }

  async function replace(plan, args) {
    if (disposed || active !== plan) {
      throw planError('PLAN_MODE_INACTIVE', 'browser_plan is available only in the active turn explicitly started with /plan')
    }
    if (isRecord(args) && args.user_input_needed !== undefined && typeof args.user_input_needed !== 'boolean') {
      throw planError('PLAN_WAIT_INVALID', 'user_input_needed must be a boolean')
    }
    const waiting = isRecord(args) && args.user_input_needed === true
    const planArgs = isRecord(args) ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'user_input_needed')) : args
    const result = replacePlan(plan.state, planArgs)

    if (waiting) {
      if (plan.state.items.length === 0) {
        throw planError('PLAN_WAIT_REQUIRES_PLAN', 'create a plan before declaring that user input is needed')
      }
      if (result.ok || !sameItems(plan.state.items, planArgs?.items)) {
        throw planError('PLAN_WAIT_UNCHANGED_REQUIRED', 'user_input_needed:true requires the unchanged complete plan; update statuses in a separate call first')
      }
      if (result.error.code !== 'PLAN_UNCHANGED') {
        throw planError(result.error.code, result.error.message)
      }
      plan.waitingForUser = true
      log('plan.waiting_for_user', {
        turnId: plan.turnId,
        sessionId: plan.sessionId,
        turn: plan.turn,
        revision: plan.state.revision,
      })
      bridge.activity({
        kind: 'plan',
        revision: plan.state.revision,
        items: plan.state.items.map(item => ({ ...item })),
        awaitingUser: true,
      })
      return toolContent(plan, 'Plan is waiting for user input. Ask the user now; do not mark open items completed or blocked merely to finish.')
    }

    if (!result.ok) throw planError(result.error.code, result.error.message)
    plan.state = result.state
    plan.waitingForUser = false
    log('plan.updated', {
      turnId: plan.turnId,
      sessionId: plan.sessionId,
      turn: plan.turn,
      ...result.audit,
    })
    bridge.activity({
      kind: 'plan',
      revision: plan.state.revision,
      items: plan.state.items.map(item => ({ ...item })),
      awaitingUser: false,
    })
    return toolContent(plan, `Plan revision ${plan.state.revision} updated. Status is model-reported, not independent verification.`)
  }

  function claim(agent, turn) {
    if (disposed || pendingTurnId === null || !Number.isSafeInteger(turn) || !agent?.session) return
    const sessionId = String(agent.session.id)
    if (active?.key === turnKey(sessionId, turn)) {
      pendingTurnId = null
      return
    }
    if (active) cleanup(active, 'superseded')
    const turnId = pendingTurnId
    pendingTurnId = null
    const plan = {
      key: turnKey(sessionId, turn),
      turnId,
      sessionId,
      turn,
      agent,
      state: createPlanState(),
      callIds: new Set(),
      waitingForUser: false,
      finalOutcome: null,
      unregister: null,
    }
    try {
      const definition = createMcpToolDefinition(ctx, {
        ...BROWSER_PLAN_TOOL,
        call: args => replace(plan, args),
      })
      plan.unregister = ctx.tools.register(definition)
      active = plan
      log('plan.mode.started', { turnId, sessionId, turn, revision: 0 })
    } catch (error) {
      log('plan.mode.error', {
        turnId,
        sessionId,
        turn,
        message: error instanceof Error ? error.message : String(error),
      }, 'error')
    }
  }

  function forTurn(sessionId, turn) {
    return active?.key === turnKey(sessionId, turn) ? active : null
  }

  function observeToolCall(session, data) {
    if (!Number.isSafeInteger(data?.turn)) return
    const plan = forTurn(session?.id, data.turn)
    if (!plan || data.name !== BROWSER_PLAN_TOOL.name || typeof data.callId !== 'string') return
    plan.callIds.add(data.callId)
  }

  function observeToolResult(session, data) {
    if (!Number.isSafeInteger(data?.turn)) return
    const plan = forTurn(session?.id, data.turn)
    if (!plan) return
    const id = callId(data)
    if (typeof id === 'string' && plan.callIds.delete(id)) return
    const result = recordPlanActivity(plan.state)
    plan.state = result.state
    if (!result.reminder) return
    log('plan.stale', {
      turnId: plan.turnId,
      sessionId: plan.sessionId,
      turn: plan.turn,
      revision: result.reminder.revision,
      reminder: result.reminder.reminder,
      openItemCount: result.reminder.openItemCount,
    }, 'warn')
    queueMicrotask(() => {
      if (disposed || active !== plan) return
      try {
        plan.agent.steer(runtimeMessage(result.reminder.text, 'Stale plan reminder'))
      } catch (error) {
        log('plan.stale.error', {
          turnId: plan.turnId,
          message: error instanceof Error ? error.message : String(error),
        }, 'warn')
      }
    })
  }

  function stopping({ agent, turn, signal }) {
    const plan = forTurn(agent?.session?.id, turn)
    if (!plan) return false
    const decision = decidePlanFinalAnswer(plan.state, {
      aborted: signal?.aborted === true,
      userInputNeeded: plan.waitingForUser,
    })
    plan.state = decision.state
    plan.finalOutcome = decision.outcome
    log('plan.final', {
      turnId: plan.turnId,
      sessionId: plan.sessionId,
      turn,
      action: decision.action,
      reason: decision.reason,
      outcome: decision.outcome,
      revision: plan.state.revision,
      completionNudges: decision.completionNudges,
    }, decision.outcome === 'unfinished' ? 'warn' : 'info')
    if (decision.action !== 'nudge') return decision.action === 'ask_user' || decision.outcome === 'aborted'
    try {
      agent.steer(runtimeMessage(decision.message, 'Unfinished plan'))
    } catch (error) {
      log('plan.final.error', {
        turnId: plan.turnId,
        message: error instanceof Error ? error.message : String(error),
      }, 'warn')
    }
    return true
  }

  function endTurn(session, turn, data) {
    const plan = forTurn(session?.id, turn)
    if (!plan) return
    const summary = summarizePlan(plan.state)
    const outcome = plan.finalOutcome ?? (summary.counts.open > 0
      ? 'unfinished'
      : summary.total === 0
        ? 'not-assessed'
        : summary.counts.blocked > 0 ? 'blocked' : 'reported-complete')
    if (isRecord(data)) {
      data.planOutcome = outcome
      data.planRevision = plan.state.revision
      data.planCounts = { ...summary.counts }
    }
    log('plan.mode.ended', {
      turnId: plan.turnId,
      sessionId: plan.sessionId,
      turn,
      outcome,
      revision: plan.state.revision,
      counts: summary.counts,
    }, outcome === 'unfinished' ? 'warn' : 'info')
    cleanup(plan)
  }

  function dispose() {
    disposed = true
    pendingTurnId = null
    if (active) cleanup(active)
  }

  return Object.freeze({
    setMode,
    claim,
    observeToolCall,
    observeToolResult,
    stopping,
    endTurn,
    dispose,
  })
}
