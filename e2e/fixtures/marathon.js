// Shared station logic for the marathon-long fixture pages (marathon-01..12.html).
// Each page declares data-station, data-word, data-seal (and data-prev-seal from
// station 2 onward) on <body>. A submit is accepted only when the dispatch word
// matches this station's word and the receipt matches the previous station's
// receipt (station 1 uses the start receipt printed on the page). An accepted
// submit POSTs {step, word, receipt} to /marathon/step — the fixture server's
// request log is the server-side record of completed steps — and only then
// reveals this station's receipt and the link onward. A rejected submit records
// nothing. Reloading a station resets its form, so an already-accepted station
// can be submitted again; the server log then shows the redo.
;(() => {
  const body = document.body
  const station = Number(body.dataset.station)
  const word = body.dataset.word
  const seal = body.dataset.seal
  const prevSeal = body.dataset.prevSeal ?? null
  const START_RECEIPT = 'START-7Q4'
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
