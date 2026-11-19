export const name = 'chat-attach-send'
export const fixture = 'chat.html'
export const prompt = "Screenshot the question card, paste it into the chat as a third image, type 'Which option?', send it, and report the reply."
export const maxTurnSeconds = 150

async function snapshot(ctx) {
  return ctx.evaluate(`(() => {
    const state = window.chatFixtureState
    return {
      uploads: state?.uploads ?? null,
      viewerOpens: state?.viewerOpens ?? null,
      sentMessages: state?.sentMessages ?? [],
      reply: state?.reply ?? '',
      visibleReply: document.getElementById('reply')?.textContent ?? '',
      composerText: document.getElementById('composer')?.innerText ?? '',
      remainingAttachments: document.getElementById('attachments')?.children.length ?? null,
    }
  })()`)
}

export async function check(ctx) {
  const state = await snapshot(ctx)
  const problems = []
  if (state.sentMessages.length !== 1) problems.push(`${state.sentMessages.length} sent messages, expected exactly 1`)
  if (state.sentMessages[0]?.attachments !== 3) problems.push(`sent attachment count is ${state.sentMessages[0]?.attachments ?? 'missing'}, expected 3`)
  if (state.sentMessages[0]?.text !== 'Which option?') problems.push(`sent text is ${JSON.stringify(state.sentMessages[0]?.text)}, expected "Which option?"`)
  if (state.uploads !== 1) problems.push(`${state.uploads} uploads, expected exactly 1`)
  if (state.viewerOpens !== 0) problems.push(`${state.viewerOpens} viewer openings indicate wrong-target clicks`)
  if (state.reply !== 'Option C.' || state.visibleReply !== 'Reply: Option C.') problems.push('the scripted reply is not visible')
  if (problems.length === 0) {
    return { status: 'pass', reasons: ['one message with the requested text and exactly three attachments was sent; one upload, no wrong-target viewer, reply visible'], evidence: state }
  }
  const attempted = state.uploads > 0 || state.sentMessages.length > 0 || state.composerText.length > 0
  return { status: attempted ? 'partial' : 'fail', reasons: problems, evidence: state }
}

export async function tamper(ctx) {
  await ctx.evaluate(`(() => {
    const file = new File(['duplicate'], 'duplicate.png', { type: 'image/png' })
    window.chatFixture.uploadFiles([file, file])
    document.getElementById('composer').innerText = 'Which option?'
    document.getElementById('composer').dispatchEvent(new Event('input', { bubbles: true }))
    setTimeout(() => window.chatFixture.sendMessage(), 1100)
    return true
  })()`)
  await new Promise(resolve => setTimeout(resolve, 1250))
}

export async function solve(ctx) {
  await ctx.evaluate(`(() => {
    const file = new File(['positive-control'], 'question.png', { type: 'image/png' })
    window.chatFixture.uploadFiles([file])
    document.getElementById('composer').innerText = 'Which option?'
    document.getElementById('composer').dispatchEvent(new Event('input', { bubbles: true }))
    setTimeout(() => window.chatFixture.sendMessage(), 1100)
    return true
  })()`)
  await new Promise(resolve => setTimeout(resolve, 1250))
}
