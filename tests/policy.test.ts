import { describe, expect, it, vi } from "vitest";
import {
  assess,
  buildRiskState,
  JEV_GATE_QUESTIONS,
  JEV_RISK_QUESTIONS,
  toEffortHint,
  toProgressVerdict,
  toRiskAnswers,
  ConfirmGate,
  type ElementProbe,
  type GateDeps,
} from "../extension/src/background/policy";
import type { StepEvent } from "../extension/src/shared/protocol";

const passwordProbe: ElementProbe = {
  tag: "input",
  type: "password",
  text: "",
  inForm: true,
};
const submitProbe: ElementProbe = {
  tag: "button",
  type: "submit",
  text: "Log in",
  inForm: true,
};
const buyProbe: ElementProbe = {
  tag: "button",
  type: "submit",
  text: "Buy now",
  inForm: true,
};
const plainProbe: ElementProbe = {
  tag: "button",
  type: "button",
  text: "Add item",
  inForm: false,
};

describe("assess — policy matrix", () => {
  it("always confirms evaluate_js, download and network mocks", () => {
    expect(assess("evaluate_js", { expression: "1+1" })).toMatchObject({
      level: "confirm",
      rule: "evaluate_js",
    });
    expect(assess("download", { url: "http://x/f" })).toMatchObject({
      level: "confirm",
      rule: "download",
    });
    expect(assess("network_mock", {})).toMatchObject({
      level: "confirm",
      rule: "network_mock",
    });
    expect(assess("network_rewrite", {})).toMatchObject({
      level: "confirm",
      rule: "network_mock",
    });
  });

  it("gives evaluate_js with bypass_csp its own rule", () => {
    expect(assess("evaluate_js", { expression: "1+1", bypass_csp: true })).toMatchObject({
      level: "confirm",
      rule: "csp_bypass",
    });
    expect(assess("evaluate_js", { expression: "1+1", bypass_csp: false })).toMatchObject({
      rule: "evaluate_js",
    });
  });

  it("confirms purchase/checkout navigation and clicks", () => {
    expect(assess("navigate", { url: "https://shop.example/checkout?x=1" })).toMatchObject({
      level: "confirm",
      rule: "purchase",
    });
    expect(assess("click", { ref: "3" }, buyProbe)).toMatchObject({
      level: "confirm",
      rule: "purchase",
    });
    expect(assess("navigate", { url: "https://example.com/docs" })).toEqual({
      level: "allow",
    });
  });

  it("confirms typing into password fields", () => {
    expect(assess("type", { ref: "2", text: "pw" }, passwordProbe)).toMatchObject({
      level: "confirm",
      rule: "password",
    });
    expect(assess("type", { ref: "2", text: "hi" }, plainProbe)).toEqual({
      level: "allow",
    });
  });

  it("confirms form submission (submit click, typed submit, Enter)", () => {
    expect(assess("click", { ref: "3" }, submitProbe)).toMatchObject({
      level: "confirm",
      rule: "form_submit",
    });
    expect(
      assess("type", { ref: "2", text: "x", submit: true }, { ...plainProbe, inForm: true }),
    ).toMatchObject({ level: "confirm", rule: "form_submit" });
    expect(
      assess("key", { key: "Enter" }, { ...plainProbe, inForm: true }),
    ).toMatchObject({ level: "confirm", rule: "form_submit" });
  });

  it("allows ordinary actions", () => {
    expect(assess("click", { ref: "3" }, plainProbe)).toEqual({ level: "allow" });
    expect(assess("snapshot", {})).toEqual({ level: "allow" });
    expect(assess("scroll", { dy: 100 })).toEqual({ level: "allow" });
    expect(assess("key", { key: "Escape" }, plainProbe)).toEqual({ level: "allow" });
  });
});

function gateHarness(overrides: Partial<GateDeps> = {}) {
  const events: StepEvent[] = [];
  const saved: string[][] = [];
  const deps: GateDeps = {
    emit: (e) => events.push(e),
    loadAlways: async () => new Set(),
    saveAlways: async (s) => void saved.push([...s]),
    timeoutMs: 500,
    ...overrides,
  };
  return { events, saved, deps };
}

describe("ConfirmGate", () => {
  const risk = { level: "confirm" as const, rule: "password", summary: "pw" };

  it("emits need_confirm and resolves on allow", async () => {
    const { events, deps } = gateHarness();
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const p = gate.request(risk);
    const confirm = events.find((e) => e.kind === "need_confirm") as Extract<
      StepEvent,
      { kind: "need_confirm" }
    >;
    expect(confirm.tool).toBe("password");
    gate.resolve(confirm.id, true, false);
    expect(await p).toEqual({ allow: true });
  });

  it("forwards the Jev flag so the card can be highlighted pink", async () => {
    const { events, deps } = gateHarness();
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const p = gate.request({ ...risk, jev: true });
    const confirm = events.find((e) => e.kind === "need_confirm") as Extract<
      StepEvent,
      { kind: "need_confirm" }
    >;
    expect(confirm.jev).toBe(true);
    gate.resolve(confirm.id, false, false);
    await p;
  });

  it("omits the Jev flag on a rule-based confirm", async () => {
    const { events, deps } = gateHarness();
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const p = gate.request(risk);
    const confirm = events.find((e) => e.kind === "need_confirm") as Extract<
      StepEvent,
      { kind: "need_confirm" }
    >;
    expect(confirm.jev).toBeUndefined();
    gate.resolve(confirm.id, false, false);
    await p;
  });

  it("deny returns a cancellation reason", async () => {
    const { events, deps } = gateHarness();
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const p = gate.request(risk);
    const confirm = events.find((e) => e.kind === "need_confirm") as Extract<
      StepEvent,
      { kind: "need_confirm" }
    >;
    gate.resolve(confirm.id, false, false);
    expect(await p).toEqual({ allow: false, reason: expect.stringContaining("denied") });
  });

  it("always-allow suppresses future prompts and persists", async () => {
    const { events, saved, deps } = gateHarness();
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const p = gate.request(risk);
    const confirm = events.find((e) => e.kind === "need_confirm") as Extract<
      StepEvent,
      { kind: "need_confirm" }
    >;
    gate.resolve(confirm.id, true, true);
    await p;
    expect(saved[0]).toEqual(["password"]);

    events.length = 0;
    expect(await gate.request(risk)).toEqual({ allow: true });
    expect(events.some((e) => e.kind === "need_confirm")).toBe(false);
  });

  it("loads persisted always-allow rules", async () => {
    const gate = new ConfirmGate(
      gateHarness({
        loadAlways: async () => new Set(["password"]),
      }).deps,
    );
    await gate.ready();
    expect(await gate.request(risk)).toEqual({ allow: true });
  });

  it("times out to a denial", async () => {
    const { deps } = gateHarness({ timeoutMs: 30 });
    const gate = new ConfirmGate(deps);
    await gate.ready();
    expect(await gate.request(risk)).toEqual({
      allow: false,
      reason: expect.stringContaining("timed out"),
    });
  });

  it("names the timeout a closed route so the model moves on instead of guessing", async () => {
    const { deps } = gateHarness({ timeoutMs: 20 });
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const out = (await gate.request(risk)) as { allow: false; reason: string };
    // A bare "denied" left a real run convinced gated tools never work; the
    // reason must say the route is unavailable and point at the next move.
    expect(out.reason).toContain("route is unavailable");
    expect(out.reason).toContain("do NOT retry");
  });

  it("re-reads a function timeoutMs per request (unattended runs fail fast)", async () => {
    const { deps } = gateHarness({ timeoutMs: () => 20 });
    const gate = new ConfirmGate(deps);
    await gate.ready();
    const out = await gate.request(risk);
    expect(out).toMatchObject({ allow: false });
  });
});

describe("assess — new capability tools (coords, upload, screenshot-to-disk)", () => {
  it("gates click_at exactly like click, from the probe of the point", () => {
    expect(assess("click_at", { x: 10, y: 10 }, buyProbe)).toMatchObject({
      level: "confirm",
      rule: "purchase",
    });
    expect(assess("click_at", { x: 10, y: 10 }, submitProbe)).toMatchObject({
      level: "confirm",
      rule: "form_submit",
    });
    expect(assess("click_at", { x: 10, y: 10 }, plainProbe)).toEqual({ level: "allow" });
  });

  it("leaves hover_at / element_at / drag_at free (read or inert)", () => {
    expect(assess("hover_at", { x: 1, y: 1 })).toEqual({ level: "allow" });
    expect(assess("element_at", { x: 1, y: 1 })).toEqual({ level: "allow" });
    expect(assess("drag_at", { x: 1, y: 1, to_x: 2, to_y: 2 })).toEqual({ level: "allow" });
  });

  it("always confirms upload and names the files it would send", () => {
    const risk = assess("upload", {
      ref: "3",
      files: [{ name: "notes.txt" }],
      paths: ["/home/me/report.pdf"],
    });
    expect(risk).toMatchObject({ level: "confirm", rule: "upload" });
    expect(risk.level === "confirm" && risk.summary).toContain("notes.txt");
    expect(risk.level === "confirm" && risk.summary).toContain("report.pdf");
  });

  it("gates only the save_to_disk half of screenshot", () => {
    expect(assess("screenshot", {})).toEqual({ level: "allow" });
    expect(assess("screenshot", { save_to_disk: true, filename: "proof.jpg" })).toMatchObject({
      level: "confirm",
      rule: "download",
    });
  });

  it("gates paste_image under the SAME upload rule (always-allow carries over)", () => {
    const risk = assess("paste_image", { image: "shot_3", ref: "0#12", via: "clipboard" });
    expect(risk).toMatchObject({ level: "confirm", rule: "upload" });
    expect(risk.level === "confirm" && risk.summary).toContain("shot_3");
    expect(risk.level === "confirm" && risk.summary).toContain("clipboard");
    // No args at all: still gated, summary falls back to the defaults.
    const bare = assess("paste_image", {});
    expect(bare).toMatchObject({ level: "confirm", rule: "upload" });
    expect(bare.level === "confirm" && bare.summary).toContain("latest staged capture");
  });
});

describe("vi sanity", () => {
  it("keeps vi imported for future spies", () => {
    expect(typeof vi.fn).toBe("function");
  });
});

describe("Jev per-step routing layer", () => {
  const choice = (choice: string, confidence: number) => ({
    type: "choice" as const,
    choice,
    probabilities: { [choice]: confidence },
    confidence,
  });

  it("extends the risk batch with effort_next + progress, keeping the risk four", () => {
    for (const id of Object.keys(JEV_RISK_QUESTIONS)) {
      expect(JEV_GATE_QUESTIONS[id]).toBeDefined();
    }
    expect(JEV_GATE_QUESTIONS.effort_next).toMatchObject({ type: "choice" });
    expect(JEV_GATE_QUESTIONS.progress).toMatchObject({ type: "choice" });
    // The risk questions are untouched — the gate batch is a superset.
    expect(JEV_RISK_QUESTIONS.effort_next).toBeUndefined();
  });

  it("extracts effort/progress verdicts and ignores the wrong answer type", () => {
    expect(toEffortHint({ effort_next: choice("routine", 0.8) })).toEqual({
      choice: "routine",
      confidence: 0.8,
    });
    expect(toProgressVerdict({ progress: choice("stuck", 0.9) })).toEqual({
      choice: "stuck",
      confidence: 0.9,
    });
    // A noul answer where a choice was expected → no verdict, never a crash.
    expect(toEffortHint({ effort_next: { type: "noul", noul: 0.5 } })).toBeNull();
    expect(toEffortHint(null)).toBeNull();
    expect(toProgressVerdict({})).toBeNull();
  });

  it("risk merge never reads the routing questions (union-only is intact)", () => {
    // A full gate answer set: the risk noul fires a confirm; the routing
    // choices ride along and must not alter the risk verdict.
    const answers = {
      purchase: { type: "noul" as const, noul: 0.9 },
      effort_next: choice("deep", 0.9),
      progress: choice("stuck", 0.9),
    };
    const risk = toRiskAnswers(answers);
    expect(risk?.purchase).toBe(0.9);
    // toRiskAnswers only maps the four noul ids — the choices are invisible.
    expect(Object.keys(risk ?? {})).toEqual([
      "purchase",
      "credential",
      "irreversible",
      "beyondTask",
    ]);
  });

  it("buildRiskState carries recent-call history only when given one", () => {
    const bare = buildRiskState("task", "click", { ref: "1" }, null);
    expect(bare.history).toBeUndefined();
    const withHistory = buildRiskState("task", "click", { ref: "1" }, null, {
      recent: ["a", "b", "c", "d"],
      repeats: 2,
      repeatFails: 1,
    });
    expect(withHistory.history).toEqual({
      // Only the last three ride along — the state stays tiny.
      recent_calls: ["b", "c", "d"],
      this_call_previously_run: 2,
      this_call_previous_failures: 1,
    });
  });
});
