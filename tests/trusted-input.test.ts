// Pure half of the trusted-input path: the key table, the typing plan and the
// "must this be real keystrokes?" decision. The browser half is covered by
// scripts/docs-smoke.mjs against the canvas-editor fixture.
import { describe, expect, it } from "vitest";
import {
  isCanvasEditorUrl,
  keyEventParams,
  MODIFIER_BITS,
  parseKeyCombo,
  planTyping,
  shouldUseTrustedInput,
  trustedInputFailure,
  type InputHints,
} from "../extension/src/shared/trusted-input";

/** The hints a real Google Docs text-event sink reports (measured shape). */
const DOCS_SINK: InputHints = {
  frameUrl: "https://docs.google.com/document/d/ABC/texteventtarget",
  topUrl: "https://docs.google.com/document/d/ABC/edit",
  editable: true,
  inIframe: true,
  boxHidden: true,
  colorTransparent: true,
  frameCanvases: 0,
  frameTextChars: 0,
  topCanvases: 1,
  sinkSignature: true,
};

/** An ordinary search box on an ordinary page. */
const PLAIN_INPUT: InputHints = {
  frameUrl: "https://example.com/search",
  topUrl: "https://example.com/search",
  editable: true,
  inIframe: false,
  boxHidden: false,
  colorTransparent: false,
  frameCanvases: 0,
  frameTextChars: 4200,
  topCanvases: 0,
  sinkSignature: false,
};

function parsed(combo: string) {
  const res = parseKeyCombo(combo);
  if (!res.ok) throw new Error(`expected ${combo} to parse: ${res.error}`);
  return res.parsed;
}

describe("parseKeyCombo", () => {
  it("maps named keys to their CDP virtual key codes", () => {
    expect(parsed("Enter")).toMatchObject({
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
    });
    expect(parsed("Backspace").windowsVirtualKeyCode).toBe(8);
    expect(parsed("Delete").windowsVirtualKeyCode).toBe(46);
    expect(parsed("Tab").windowsVirtualKeyCode).toBe(9);
    expect(parsed("Escape").windowsVirtualKeyCode).toBe(27);
    expect(parsed("ArrowLeft").windowsVirtualKeyCode).toBe(37);
    expect(parsed("ArrowDown").windowsVirtualKeyCode).toBe(40);
    expect(parsed("Home").windowsVirtualKeyCode).toBe(36);
    expect(parsed("PageUp").windowsVirtualKeyCode).toBe(33);
    expect(parsed("Space")).toMatchObject({ key: " ", code: "Space", text: " " });
  });

  it("accepts the aliases a model actually writes", () => {
    expect(parsed("return")).toMatchObject({ key: "Enter", windowsVirtualKeyCode: 13 });
    expect(parsed("esc").windowsVirtualKeyCode).toBe(27);
    expect(parsed("del").windowsVirtualKeyCode).toBe(46);
    expect(parsed("left").windowsVirtualKeyCode).toBe(37);
    expect(parsed("spacebar").text).toBe(" ");
  });

  it("maps letters and digits, with US shift symbols", () => {
    expect(parsed("a")).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
    expect(parsed("z").windowsVirtualKeyCode).toBe(90);
    expect(parsed("0")).toMatchObject({ code: "Digit0", windowsVirtualKeyCode: 48, text: "0" });
    expect(parsed("Shift+1")).toMatchObject({ key: "!", text: "!", windowsVirtualKeyCode: 49 });
    expect(parsed("Shift+a")).toMatchObject({ key: "A", text: "A" });
  });

  it("encodes modifiers as the CDP bitmask, in any order or spelling", () => {
    expect(parsed("Control+b").modifiers).toBe(MODIFIER_BITS.ctrl);
    expect(parsed("ctrl+b").modifiers).toBe(MODIFIER_BITS.ctrl);
    expect(parsed("Control+Shift+b").modifiers).toBe(MODIFIER_BITS.ctrl | MODIFIER_BITS.shift);
    expect(parsed("Shift+Control+b").modifiers).toBe(MODIFIER_BITS.ctrl | MODIFIER_BITS.shift);
    expect(parsed("Meta+k").modifiers).toBe(MODIFIER_BITS.meta);
    expect(parsed("cmd+k").modifiers).toBe(MODIFIER_BITS.meta);
    expect(parsed("Alt+ArrowLeft").modifiers).toBe(MODIFIER_BITS.alt);
    expect(parsed("option+ArrowLeft").modifiers).toBe(MODIFIER_BITS.alt);
    // Docs' heading shortcuts: Ctrl+Alt+1..6
    expect(parsed("Control+Alt+1").modifiers).toBe(MODIFIER_BITS.ctrl | MODIFIER_BITS.alt);
    expect(parsed("a").modifiers).toBe(0);
  });

  it("maps function keys and punctuation", () => {
    expect(parsed("F1")).toMatchObject({ key: "F1", code: "F1", windowsVirtualKeyCode: 112 });
    expect(parsed("F12").windowsVirtualKeyCode).toBe(123);
    expect(parsed(";")).toMatchObject({ code: "Semicolon", windowsVirtualKeyCode: 186 });
    expect(parsed("/")).toMatchObject({ code: "Slash", windowsVirtualKeyCode: 191 });
    expect(parsed("+")).toMatchObject({ code: "Equal", text: "+" });
  });

  it("treats a trailing + as the key, not a separator", () => {
    expect(parsed("Control++")).toMatchObject({ key: "+", modifiers: MODIFIER_BITS.ctrl });
  });

  it("carries text only for keys that insert a character", () => {
    expect(parsed("Enter").text).toBe("\r");
    expect(parsed("ArrowLeft").text).toBeUndefined();
    expect(parsed("Control+b").text).toBe("b");
    expect(parsed("Escape").text).toBeUndefined();
  });

  it("rejects what it cannot map, and says what to do instead", () => {
    expect(parseKeyCombo("")).toMatchObject({ ok: false });
    expect(parseKeyCombo("Control+Nope")).toMatchObject({ ok: false });
    const accented = parseKeyCombo("é");
    expect(accented.ok).toBe(false);
    if (!accented.ok) expect(accented.error).toMatch(/type instead/);
  });
});

describe("keyEventParams", () => {
  it("sends text on keyDown only — that is what makes the browser insert it", () => {
    const key = parsed("Control+b");
    expect(keyEventParams(key, "down")).toMatchObject({
      type: "keyDown",
      key: "b",
      code: "KeyB",
      windowsVirtualKeyCode: 66,
      nativeVirtualKeyCode: 66,
      modifiers: MODIFIER_BITS.ctrl,
      text: "b",
    });
    const up = keyEventParams(key, "up");
    expect(up).toMatchObject({ type: "keyUp", key: "b" });
    expect(up.text).toBeUndefined();
  });

  it("omits modifiers when none are held", () => {
    expect(keyEventParams(parsed("Enter"), "down").modifiers).toBeUndefined();
  });
});

describe("planTyping", () => {
  it("sends one insertText for a plain run", () => {
    expect(planTyping("hello docs")).toEqual([{ kind: "insertText", text: "hello docs" }]);
  });

  it("turns newlines into real Enter keys, so paragraphs are paragraphs", () => {
    expect(planTyping("one\ntwo")).toEqual([
      { kind: "insertText", text: "one" },
      { kind: "key", key: "Enter" },
      { kind: "insertText", text: "two" },
    ]);
    expect(planTyping("one\r\ntwo\r\nthree")).toEqual([
      { kind: "insertText", text: "one" },
      { kind: "key", key: "Enter" },
      { kind: "insertText", text: "two" },
      { kind: "key", key: "Enter" },
      { kind: "insertText", text: "three" },
    ]);
  });

  it("does not invent empty insertText steps", () => {
    expect(planTyping("\n")).toEqual([{ kind: "key", key: "Enter" }]);
    expect(planTyping("a\n\nb")).toEqual([
      { kind: "insertText", text: "a" },
      { kind: "key", key: "Enter" },
      { kind: "key", key: "Enter" },
      { kind: "insertText", text: "b" },
    ]);
  });

  it("submit means a trailing Enter, even with nothing to type", () => {
    expect(planTyping("q", { submit: true })).toEqual([
      { kind: "insertText", text: "q" },
      { kind: "key", key: "Enter" },
    ]);
    expect(planTyping("", { submit: true })).toEqual([{ kind: "key", key: "Enter" }]);
    expect(planTyping("")).toEqual([]);
  });
});

describe("isCanvasEditorUrl", () => {
  it("recognises the canvas editors", () => {
    for (const url of [
      "https://docs.google.com/document/d/ABC/edit",
      "https://docs.google.com/presentation/d/ABC/edit",
      "https://docs.google.com/spreadsheets/d/ABC/edit",
      "https://abc123.docs.google.com/document/d/ABC/edit",
      "https://officeapps.live.com/we/wordeditorframe.aspx?ui=en-US",
      "https://www.office.com/launch/word",
    ]) {
      expect(isCanvasEditorUrl(url), url).toBe(true);
    }
  });

  it("does not claim every page with a canvas in it", () => {
    for (const url of [
      "https://example.com/checkout",
      "https://docs.google.com/forms/d/e/123/viewform",
      "https://mail.google.com/mail/u/0/",
      "",
    ]) {
      expect(isCanvasEditorUrl(url), url).toBe(false);
    }
    expect(isCanvasEditorUrl(undefined)).toBe(false);
  });
});

describe("shouldUseTrustedInput", () => {
  it("keeps the DOM path for ordinary editable elements", () => {
    expect(shouldUseTrustedInput(PLAIN_INPUT)).toMatchObject({ use: false });
  });

  it("routes a Docs-shaped sink to real keystrokes", () => {
    const decision = shouldUseTrustedInput(DOCS_SINK);
    expect(decision.use).toBe(true);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("detects the sink by signature alone, without the canvas heuristics", () => {
    expect(
      shouldUseTrustedInput({ editable: true, sinkSignature: true }).use,
    ).toBe(true);
  });

  it("detects an invisible editable sink in a frame of a canvas page", () => {
    expect(
      shouldUseTrustedInput({
        editable: true,
        inIframe: true,
        boxHidden: true,
        topCanvases: 2,
        frameUrl: "https://school.example.com/embedded-sink",
      }).use,
    ).toBe(true);
  });

  it("detects the editor by URL even when the frame itself has no canvas", () => {
    expect(
      shouldUseTrustedInput({
        editable: true,
        inIframe: true,
        topUrl: "https://docs.google.com/document/d/ABC/edit",
      }).use,
    ).toBe(true);
  });

  it("never routes a non-editable target", () => {
    expect(
      shouldUseTrustedInput({
        editable: false,
        inIframe: true,
        boxHidden: true,
        topCanvases: 3,
        topUrl: "https://docs.google.com/document/d/ABC/edit",
      }).use,
    ).toBe(false);
  });

  it("honours an explicit choice from the model either way", () => {
    expect(shouldUseTrustedInput({ ...PLAIN_INPUT, explicit: true })).toMatchObject({
      use: true,
    });
    expect(shouldUseTrustedInput({ ...DOCS_SINK, explicit: false })).toMatchObject({
      use: false,
    });
  });

  it("routes a focused iframe of a canvas page, for `key` with no ref", () => {
    expect(
      shouldUseTrustedInput({
        editable: false,
        activeIsFrame: true,
        frameCanvases: 1,
        frameUrl: "https://school.example.com/portal",
      }).use,
    ).toBe(true);
    // An iframe on an ordinary page is not an editor: nothing to route.
    expect(
      shouldUseTrustedInput({ editable: false, activeIsFrame: true, frameCanvases: 0 }).use,
    ).toBe(false);
  });

  it("explains itself, because the reason lands in the run log", () => {
    expect(shouldUseTrustedInput({ ...PLAIN_INPUT, explicit: true }).reason).toMatch(/requested/);
    expect(shouldUseTrustedInput(PLAIN_INPUT).reason).toMatch(/ordinary/i);
  });
});

describe("trustedInputFailure", () => {
  it("is pre-tagged so the classifier leaves the advice alone", () => {
    const msg = trustedInputFailure("the sink lost focus", "take a fresh snapshot");
    expect(msg).toContain("TRANSPORT-FAILED");
    expect(msg).toContain("the sink lost focus");
    expect(msg).toContain("take a fresh snapshot");
  });
});
