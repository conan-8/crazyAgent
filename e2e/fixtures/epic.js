// Shared station logic for the marathon-epic fixture pages (epic-01..120.html).
// Identical contract to marathon.js at 120 stations: a submit is accepted only
// with this station's dispatch word plus the previous station's receipt
// (station 1 uses the printed start receipt). An accepted submit POSTs
// {step, word, receipt} to /marathon/step — the fixture server's request log
// is the server-side progress record — and only then reveals the receipt and
// the link onward. Rejected submits record nothing. Reloading a station
// resets its form, so a re-submit is possible and shows as a duplicate POST.
;(() => {
  const body = document.body
  const station = Number(body.dataset.station)
  const word = body.dataset.word
  const seal = body.dataset.seal
  const prevSeal = body.dataset.prevSeal ?? null
  const START_RECEIPT = 'START-E1'
  const expectedReceipt = station === 1 ? START_RECEIPT : `R${station - 1}-${prevSeal}`
  const form = document.getElementById('station-form')
  const status = document.getElementById('station-status')
  const accepted = document.getElementById('station-accepted')
  const receiptCode = document.getElementById('receipt-code')
  let done = false
  let rejects = 0
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (done) return
    const enteredWord = document.getElementById('word').value.trim()
    const enteredReceipt = document.getElementById('receipt').value.trim()
    if (enteredWord !== word || enteredReceipt !== expectedReceipt) {
      rejects += 1
      body.dataset.rejects = String(rejects)
      status.textContent = 'Rejected: the dispatch word or the receipt is wrong. Nothing was recorded.'
      return
    }
    status.textContent = 'Recording the station…'
    try {
      const response = await fetch('/marathon/step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: station, word: enteredWord, receipt: enteredReceipt }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
    } catch {
      status.textContent = 'The office server did not accept the record; try the submit again.'
      return
    }
    done = true
    form.hidden = true
    accepted.hidden = false
    receiptCode.textContent = `R${station}-${seal}`
    status.textContent = `Station ${station} accepted.`
  })
})()
