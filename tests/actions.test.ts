// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Actions } from "../extension/src/content/actions";
import { ElementRegistry } from "../extension/src/content/registry";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("Actions", () => {
  let registry: ElementRegistry;
  let actions: Actions;

  beforeEach(() => {
    registry = new ElementRegistry();
    actions = new Actions(registry);
  });

  function refOf(name: string): string {
    const snap = registry.collect();
    const el = snap.elements.find((e) => e.name === name);
    if (!el) throw new Error(`no element named ${name}`);
    return el.ref;
  }

  it("click fires the full mouse sequence ending in one click", () => {
    setBody(`<button id="b">Button</button>`);
    const order: string[] = [];
    const b = document.getElementById("b")!;
    for (const t of ["mousedown", "mouseup", "click"]) {
      b.addEventListener(t, () => order.push(t));
    }
    const res = actions.run({ action: "click", ref: refOf("Button") });
    expect(res).toMatchObject({ ok: true });
    expect(order).toEqual(["mousedown", "mouseup", "click"]);
  });

  it("type sets the value and fires input/change events", () => {
    setBody(`<input id="i" placeholder="name" />`);
    const events: string[] = [];
    const input = document.getElementById("i") as HTMLInputElement;
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    const res = actions.run({ action: "type", ref: refOf("name"), text: "alice" });
    expect(res.ok).toBe(true);
    expect(input.value).toBe("alice");
    expect(events).toEqual(["input", "change"]);
  });

  it("type with submit submits the enclosing form", () => {
    setBody(`
      <form id="f"><input id="i" placeholder="name" /></form>
    `);
    let submitted = false;
    document.getElementById("f")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });
    actions.run({ action: "type", ref: refOf("name"), text: "x", submit: true });
    expect(submitted).toBe(true);
  });

  it("select sets the value and fires change", () => {
    setBody(`
      <select id="s">
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
    `);
    let changed = false;
    const select = document.getElementById("s") as HTMLSelectElement;
    select.addEventListener("change", () => (changed = true));
    const res = actions.run({ action: "select", ref: refOf("A"), value: "b" });
    expect(res.ok).toBe(true);
    expect(select.value).toBe("b");
    expect(changed).toBe(true);
  });

  it("key Enter in a form field submits the form", () => {
    setBody(`<form id="f"><input id="i" placeholder="name" /></form>`);
    let submitted = false;
    document.getElementById("f")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });
    actions.run({ action: "key", ref: refOf("name"), key: "Enter" });
    expect(submitted).toBe(true);
  });

  it("recovers a stale ref across a re-render and still clicks", () => {
    setBody(`<ul id="l"><li><button>Row 1</button></li></ul>`);
    const ref = refOf("Row 1");
    document.getElementById("l")!.innerHTML = `<li><button>Row 1</button></li>`;
    let clicked = false;
    document.querySelector("button")!.addEventListener("click", () => (clicked = true));
    const res = actions.run({ action: "click", ref });
    expect(res.ok).toBe(true);
    expect(clicked).toBe(true);
  });

  it("returns a clean error when the target is truly gone", () => {
    setBody(`<button>Row 1</button>`);
    const ref = refOf("Row 1");
    document.body.innerHTML = `<p>emptied</p>`;
    const res = actions.run({ action: "click", ref });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("stale or unknown ref");
  });

  it("history action calls history.go", () => {
    const spy = vi.spyOn(history, "go").mockImplementation(() => {});
    actions.run({ action: "history", dir: -1 });
    expect(spy).toHaveBeenCalledWith(-1);
    spy.mockRestore();
  });

  // Regression: Instagram's DM composer (and Draft.js/Lexical/ProseMirror
  // editors) are contenteditable divs, not form controls. Assigning `.value`
  // or resolving the HTMLInputElement setter threw "Illegal invocation".
  describe("contenteditable targets", () => {
    const COMPOSER = `<div id="dm" role="textbox" contenteditable="true" aria-label="Message"></div>`;

    it("types into a contenteditable div without throwing Illegal invocation", () => {
      setBody(COMPOSER);
      const res = actions.run({ action: "type", ref: refOf("Message"), text: "hello group" });
      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
      expect(document.getElementById("dm")!.textContent).toContain("hello group");
    });

    it("reports the typed text back as the value", () => {
      setBody(COMPOSER);
      const res = actions.run({ action: "type", ref: refOf("Message"), text: "hi" });
      expect((res.data as { value: string }).value).toContain("hi");
    });

    it("fires an input event so framework editors observe the change", () => {
      setBody(COMPOSER);
      const seen: string[] = [];
      const dm = document.getElementById("dm")!;
      dm.addEventListener("input", () => seen.push("input"));
      dm.addEventListener("change", () => seen.push("change"));
      actions.run({ action: "type", ref: refOf("Message"), text: "x" });
      expect(seen).toContain("input");
    });

    it("appends rather than clobbering existing draft text", () => {
      setBody(`<div id="dm" role="textbox" contenteditable="true" aria-label="Message">draft </div>`);
      actions.run({ action: "type", ref: refOf("Message"), text: "more" });
      const text = document.getElementById("dm")!.textContent!;
      expect(text).toContain("draft");
      expect(text).toContain("more");
    });

    it("rejects a non-editable div with a clear error instead of crashing", () => {
      setBody(`<div id="plain" role="button" aria-label="Plain">Plain</div>`);
      const res = actions.run({ action: "type", ref: refOf("Plain"), text: "nope" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("not typable");
    });
  });

  // The trusted-input driver needs two things from the frame that owns a ref:
  // real focus (CDP keystrokes go wherever the renderer has focused) and the
  // frame's shape, which is how the worker recognises a canvas editor's hidden
  // sink. Both come back from one `focus` action.
  describe("focus (trusted-input handshake)", () => {
    it("focuses the element and reports that it took", () => {
      setBody(`<input id="i" placeholder="name" />`);
      const res = actions.run({ action: "focus", ref: refOf("name") });
      expect(res.ok).toBe(true);
      expect((res.data as { focused: boolean }).focused).toBe(true);
      expect(document.activeElement).toBe(document.getElementById("i"));
    });

    it("reports the hints the routing decision is made from", () => {
      setBody(`<input id="i" placeholder="name" /><canvas id="c"></canvas>`);
      const res = actions.run({ action: "focus", ref: refOf("name") });
      const hints = (res.data as { hints: Record<string, unknown> }).hints;
      expect(hints.editable).toBe(true);
      expect(hints.inIframe).toBe(false);
      expect(hints.activeIsFrame).toBe(false);
      expect(hints.frameCanvases).toBe(1);
      expect(hints.frameUrl).toBe(location.href);
      expect(typeof hints.boxHidden).toBe("boolean");
    });

    it("recognises a named canvas-editor sink by signature", () => {
      setBody(
        `<div id="sink" class="docs-texteventtarget-body" role="textbox" aria-label="Document body" contenteditable="true"></div>`,
      );
      const res = actions.run({ action: "focus", ref: refOf("Document body") });
      const hints = (res.data as { hints: { sinkSignature: boolean; editable: boolean } }).hints;
      expect(hints.editable).toBe(true);
      expect(hints.sinkSignature).toBe(true);
    });

    it("focuses whatever is already focused when no ref is given", () => {
      setBody(`<input id="i" placeholder="name" />`);
      document.getElementById("i")!.focus();
      const res = actions.run({ action: "focus" });
      expect(res.ok).toBe(true);
      expect((res.data as { focused: boolean }).focused).toBe(true);
    });

    it("says so instead of guessing when nothing is focused", () => {
      setBody(`<p>text</p>`);
      const res = actions.run({ action: "focus" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("pass a ref");
    });

    it("reports a stale ref the same way every other action does", () => {
      setBody(`<input id="i" placeholder="name" />`);
      refOf("name");
      const res = actions.run({ action: "focus", ref: "9999" });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("stale or unknown ref");
    });

    it("canvasPoint is null when there is no canvas to click", () => {
      setBody(`<p>text</p>`);
      const res = actions.run({ action: "canvasPoint" });
      expect(res.ok).toBe(true);
      expect(res.data).toBeNull();
    });

    it("canvasPoint does not throw when a canvas exists", () => {
      setBody(`<canvas id="c" width="400" height="200"></canvas>`);
      const res = actions.run({ action: "canvasPoint" });
      expect(res.ok).toBe(true);
      // jsdom lays nothing out, so a zero-size canvas yields no point.
      const data = res.data as { x?: number } | null;
      expect(data === null || typeof data.x === "number").toBe(true);
    });
  });
});
