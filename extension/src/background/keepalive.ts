// Service-worker keepalive.
//
// Primary mechanism: the panel port-pings every ~20s while a task runs —
// each message resets the SW's ~30s idle teardown timer.
// Fallback: a 30s alarm that wakes (not preserves) a dead SW so `onWake`
// can resume the task from its checkpoint.

const ALARM_NAME = "ba-keepalive";

export class Keepalive {
  #suspended = false;

  constructor(onWake: () => void) {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) onWake();
    });
  }

  /** Arm wakeups while a task is running. */
  start(): void {
    if (this.#suspended) return;
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  }

  /** Disarm once the task ends. */
  stop(): void {
    void chrome.alarms.clear(ALARM_NAME);
  }

  /** Dev/test hook: behave like a browser that never wakes us. */
  suspend(): void {
    this.#suspended = true;
    this.stop();
  }
}
