// Human handoff — the pure half. When the page turns into a CAPTCHA, or the
// agent reaches for a sign-in form it has no credentials for, the honest move
// is to stop and hand the keyboard to the user (what Claude in Chrome does on
// login pages and CAPTCHAs) instead of pretending the task proceeded. The gate
// + wiring live in background/handoff.ts.
//
// False positives cost one click ("Skip — let the agent continue") but they
// also hijack runs that were fine, so the detector is conservative in BOTH
// directions:
//   - a password field alone is never a wall (the user may have asked the
//     agent to fill exactly that);
//   - a sign-in page is only a wall when the action TARGET is part of the wall
//     (a credential field, a submit/continue control on the form) — clicking a
//     promo button that happens to live on a login page is not blocked;
//   - a CAPTCHA always qualifies (no agent can honestly complete one), and
//     "captcha" excludes the invisible reCAPTCHA badge that rides on many
//     ordinary pages (the content probe requires a widget of real size).

export interface WallProbe {
  tag: string;
  type?: string;
  text: string;
  inForm: boolean;
}

export interface AuthSignals {
  /** The frame's URL. */
  url: string;
  title?: string;
  /** A CAPTCHA / bot-check widget of real size is on the page. */
  captcha: boolean;
  /** The page has a password field (weak on its own — never a wall alone). */
  passwordField: boolean;
}

const AUTH_WALL_URL_RE =
  /\/(login|log-?in|signin|sign-?in|sso|auth|challenge|checkpoint|verify)(\/|$|\?|#|\.)/i;

const LOGIN_TITLE_RE =
  /sign\s?in|log\s?in|authenticate|verification required|verify your (identity|account)|two-?factor|2fa/i;

/** The task itself is about signing in — so a login form is the job, not a wall. */
const TASK_ABOUT_LOGIN_RE =
  /\b(log ?in(to)?|sign ?in(to)?|authenticate|passwords?|credentials?|2fa|two-?factor|verification code|captcha)\b/i;

/** Controls that only make sense as part of a sign-in flow. */
const WALL_CONTROL_RE =
  /\b(log ?in|sign ?in|continue|authenticate|verify|next|submit)\b/i;

export function taskMentionsLogin(task: string): boolean {
  return TASK_ABOUT_LOGIN_RE.test(task);
}

/** True when the action's target is part of a sign-in wall. */
export function isWallControl(probe: WallProbe | null | undefined): boolean {
  if (!probe) return false;
  if (String(probe.type ?? "").toLowerCase() === "password") return true;
  return probe.inForm && WALL_CONTROL_RE.test(probe.text ?? "");
}

/**
 * Why this step needs a human, or null when the agent should just continue.
 */
export function handoffReason(
  signals: AuthSignals,
  task: string,
  probe?: WallProbe | null,
): string | null {
  if (signals.captcha) {
    return "a CAPTCHA / bot check is on the page — only a human can complete it";
  }
  if (taskMentionsLogin(task)) return null;
  const wallPage =
    AUTH_WALL_URL_RE.test(signals.url) || LOGIN_TITLE_RE.test(signals.title ?? "");
  if (wallPage && isWallControl(probe)) {
    return "this is a sign-in form — it may need your account, credentials or a second factor";
  }
  return null;
}

/** One-line message the model sees after a handoff resolved. */
export function handoffMessage(reason: string, handled: boolean): string {
  return handled
    ? `[human handoff] ${reason}. You paused; the user took over and reports it is handled. Take a fresh snapshot and continue from what the page shows now.`
    : `[human handoff] ${reason}. You paused; the user chose to let you try anyway. Take a fresh snapshot before acting, and stop if the wall is still there.`;
}
