import { describe, expect, it, vi } from "vitest";
import {
  assess,
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
});

describe("vi sanity", () => {
  it("keeps vi imported for future spies", () => {
    expect(typeof vi.fn).toBe("function");
  });
});
