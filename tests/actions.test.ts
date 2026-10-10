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

  it("refuses a bare file-input click (undrivable OS picker) and redirects to upload", () => {
    setBody(`<input id="f" type="file" aria-label="Attach" />`);
    let clicked = false;
    document.getElementById("f")!.addEventListener("click", () => (clicked = true));
    const res = actions.run({ action: "click", ref: refOf("Attach") });
    expect(res.ok).toBe(false);
    const err = String((res as { error?: string }).error ?? "");
    expect(err).toContain("file input");
    expect(err).toContain("upload");
    // The native picker must never open: no click event was dispatched.
    expect(clicked).toBe(false);
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

  it("type with submit clicks the form's own submit button when one exists", () => {
    setBody(`
      <form id="f">
        <input id="i" placeholder="name" />
        <button type="submit" id="b">Go</button>
      </form>
    `);
    let clicked = false;
    let submitted = false;
    document.getElementById("b")!.addEventListener("click", () => (clicked = true));
    document.getElementById("f")!.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });
    actions.run({ action: "type", ref: refOf("name"), text: "x", submit: true });
    // Button-bound handlers are the common SPA quiz pattern; the click must
    // reach the button, not just the form's submit event.
    expect(clicked).toBe(true);
    expect(submitted).toBe(true);
  });

  it("type with submit outside any form reports the no-op instead of silence", () => {
    setBody(`<input id="i" placeholder="answer" />`);
    const res = actions.run({
      action: "type",
      ref: refOf("answer"),
      text: "x",
      submit: true,
    });
    expect(res.ok).toBe(true);
    const data = (res as { data?: { note?: string } }).data;
    expect(data?.note).toContain("not inside a <form>");
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

// ---------------- pasteFiles / filesOf (the paste_image content half) ----------------

describe("pasteFiles", () => {
  let registry: ElementRegistry;
  let actions: Actions;

  // jsdom has no DataTransfer; the action only ever does items.add(f) and
  // reads .files back, so the minimal stand-in is exact for these tests.
  class FakeDataTransfer {
    files: File[] = [];
    items = {
      add: (f: File) => {
        this.files.push(f);
      },
    };
  }

  // 8 bytes of "PNG" — enough to prove the base64 decode path end to end.
  const B64 = "iVBORw0KGgo=";

  beforeEach(() => {
    (globalThis as { DataTransfer?: unknown }).DataTransfer = FakeDataTransfer;
    registry = new ElementRegistry();
    actions = new Actions(registry);
    document.body.innerHTML = "";
  });

  /** Ref of the first collected interactive element (bodies hold exactly one). */
  function firstRef(): string {
    const snap = registry.collect();
    const el = snap.elements[0];
    if (!el) throw new Error("no interactive element collected");
    return el.ref;
  }

  function fileArg(name = "q2.jpg"): { name: string; mime: string; base64: string } {
    return { name, mime: "image/jpeg", base64: B64 };
  }

  it("dispatches a paste carrying the image file; a consuming handler counts as handled", () => {
    document.body.innerHTML = `<div id="c" contenteditable="true" role="textbox"></div>`;
    const el = document.getElementById("c")!;
    let seen: { name: string; size: number; type: string }[] = [];
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const dt = (e as unknown as { clipboardData: FakeDataTransfer }).clipboardData;
      seen = (dt?.files ?? []).map((f) => ({ name: f.name, size: f.size, type: f.type }));
    });
    const res = actions.run({
      action: "pasteFiles",
      ref: firstRef(),
      files: [fileArg()],
    });
    expect(res.ok).toBe(true);
    const d = res.data as { route: string; handled: boolean; events: string[] };
    expect(d.route).toBe("paste");
    expect(d.handled).toBe(true);
    expect(d.events).toEqual(["paste"]);
    expect(seen).toEqual([{ name: "q2.jpg", size: 8, type: "image/jpeg" }]);
  });

  it("falls back to a drop event when no paste handler consumed the image", () => {
    document.body.innerHTML = `<div id="z" role="button">drop files here</div>`;
    const zone = document.getElementById("z")!;
    let dropped = 0;
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropped += (e as unknown as { dataTransfer: FakeDataTransfer }).dataTransfer?.files.length ?? 0;
    });
    const res = actions.run({ action: "pasteFiles", ref: firstRef(), files: [fileArg()] });
    expect(res.ok).toBe(true);
    const d = res.data as { route: string; handled: boolean; events: string[] };
    expect(d.events).toEqual(["paste", "drop"]);
    expect(d.route).toBe("drop");
    expect(d.handled).toBe(true);
    expect(dropped).toBe(1);
  });

  it("mode:'paste' never fires the drop fallback and reports the event as ignored", () => {
    document.body.innerHTML = `<div id="z" role="button">zone</div>`;
    const res = actions.run({
      action: "pasteFiles",
      ref: firstRef(),
      files: [fileArg()],
      mode: "paste",
    });
    const d = res.data as { route: string; handled: boolean; events: string[] };
    expect(d.events).toEqual(["paste"]);
    expect(d.handled).toBe(false);
  });

  it("mode:'drop' goes straight to the dropzone shape", () => {
    document.body.innerHTML = `<div id="z" role="button">zone</div>`;
    const zone = document.getElementById("z")!;
    zone.addEventListener("drop", (e) => e.preventDefault());
    const res = actions.run({
      action: "pasteFiles",
      ref: firstRef(),
      files: [fileArg()],
      mode: "drop",
    });
    const d = res.data as { route: string; events: string[]; handled: boolean };
    expect(d.events).toEqual(["drop"]);
    expect(d.route).toBe("drop");
    expect(d.handled).toBe(true);
  });

  it("with no ref it targets the focused element", () => {
    document.body.innerHTML = `<textarea id="t" aria-label="composer"></textarea>`;
    const t = document.getElementById("t")!;
    let pasted = false;
    t.addEventListener("paste", (e) => {
      e.preventDefault();
      pasted = true;
    });
    t.focus();
    const res = actions.run({ action: "pasteFiles", files: [fileArg()] });
    expect(res.ok).toBe(true);
    expect(pasted).toBe(true);
    expect((res.data as { targetTag: string }).targetTag).toBe("textarea");
  });

  it("delegates a file-input target to the DataTransfer upload route", () => {
    document.body.innerHTML = `<input id="f" type="file" />`;
    const input = document.getElementById("f") as HTMLInputElement;
    // jsdom refuses `input.files = <plain array>` (demands a real FileList) —
    // real Chrome accepts the DataTransfer's files, which is what
    // capability-smoke U1 pins in a live browser. Stub the setter here so the
    // delegation contract (assign + input/change events) is still unit-tested.
    let assigned: File[] | null = null;
    Object.defineProperty(input, "files", {
      configurable: true,
      get: () => assigned,
      set: (v: File[] | null) => {
        assigned = v;
      },
    });
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));
    input.focus();
    const res = actions.run({ action: "pasteFiles", files: [fileArg()] });
    expect(res.ok).toBe(true);
    const d = res.data as { route: string; attached: { name: string; size: number; type: string }[] };
    expect(d.route).toBe("file");
    expect(d.attached).toEqual([{ name: "q2.jpg", size: 8, type: "image/jpeg" }]);
    expect(events).toEqual(["input", "change"]);
    // (TS CFA can't see the setter callback ran — read through a cast.)
    const attached = assigned as unknown as File[] | null;
    expect(attached?.length).toBe(1);
    expect(attached?.[0]?.name).toBe("q2.jpg");
  });

  it("refuses with no files, like the upload action does", () => {
    document.body.innerHTML = `<div id="c" contenteditable="true" role="textbox"></div>`;
    const res = actions.run({ action: "pasteFiles", ref: firstRef(), files: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no files");
  });

  it("filesOf reads back what a file input actually holds", () => {
    document.body.innerHTML = `<input id="f" type="file" />`;
    const input = document.getElementById("f") as HTMLInputElement;
    // jsdom will not take a plain array through the files setter in every
    // version — pin the read-back contract directly.
    const fake = { length: 2, 0: { name: "a.jpg", size: 3, type: "image/jpeg" }, 1: { name: "b.png", size: 4, type: "image/png" } };
    Object.defineProperty(input, "files", { value: fake, configurable: true });
    const res = actions.run({ action: "filesOf", ref: firstRef() });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({
      count: 2,
      files: [
        { name: "a.jpg", size: 3, type: "image/jpeg" },
        { name: "b.png", size: 4, type: "image/png" },
      ],
    });
  });

  it("filesOf reports zero (not an error) for an empty input — the silent-failure probe", () => {
    document.body.innerHTML = `<input id="f" type="file" />`;
    const res = actions.run({ action: "filesOf", ref: firstRef() });
    expect(res.ok).toBe(true);
    expect((res.data as { count: number }).count).toBe(0);
  });
});

describe("resolvePoint (coordinate translation)", () => {
  let registry: ElementRegistry;
  let actions: Actions;

  beforeEach(() => {
    registry = new ElementRegistry();
    actions = new Actions(registry);
  });

  function refOfLocal(name: string): string {
    const snap = registry.collect();
    const el = snap.elements.find((e) => e.name === name);
    if (!el) throw new Error(`no element named ${name}`);
    return el.ref;
  }

  it("resolves a ref to its centre plus dx/dy, with its rect and hit", () => {
    setBody(`<div id="wrap"><button id="b" style="width:100px;height:40px">Plot</button></div>`);
    const btn = document.getElementById("b")!;
    btn.getBoundingClientRect = () =>
      ({ x: 200, y: 120, width: 100, height: 40, top: 120, left: 200, bottom: 160, right: 300 } as DOMRect);
    const res = actions.run({
      action: "resolvePoint",
      ref: refOfLocal("Plot"),
      dx: 10,
      dy: -5,
    });
    expect(res.ok).toBe(true);
    const data = (res as { data?: { point: { x: number; y: number }; rect?: { x: number; y: number; w: number; h: number }; hit?: { tag: string } } }).data!;
    // Centre (250, 140) + (10, -5); top-level frame adds no offset.
    expect(data.point).toEqual({ x: 260, y: 135 });
    expect(data.rect).toEqual({ x: 200, y: 120, w: 100, h: 40 });
    expect(data.hit?.tag.toLowerCase()).toBe("button");
  });

  it("resolves frame-local coordinates at the top frame without an offset", () => {
    const res = actions.run({ action: "resolvePoint", x: 33, y: 44 });
    expect(res.ok).toBe(true);
    const data = (res as { data?: { point: { x: number; y: number } } }).data!;
    expect(data.point).toEqual({ x: 33, y: 44 });
  });

  it("reports a blocked frame boundary instead of guessing an offset", () => {
    // jsdom: window.parent === window at top level, so simulate the boundary
    // by making a nested-looking window whose frameElement is null.
    const originalParent = Object.getOwnPropertyDescriptor(window, "parent");
    Object.defineProperty(window, "parent", { value: { isFakeParent: true }, configurable: true });
    try {
      const res = actions.run({ action: "resolvePoint", x: 5, y: 5 });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain("frame boundary");
    } finally {
      if (originalParent) Object.defineProperty(window, "parent", originalParent);
      else delete (window as { parent?: unknown }).parent;
    }
  });

  it("needs a ref or local coordinates", () => {
    const res = actions.run({ action: "resolvePoint" });
    expect(res.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The label-based primitives behind menu_path / docs_op: controls are found by
// what they SAY (aria-label, visible text, associated <label>), never by a
// coordinate that can drift when the menu shifts.
// ---------------------------------------------------------------------------

describe("label-based actions (clickByText / fillField / queryText)", () => {
  let actions: Actions;

  beforeEach(() => {
    actions = new Actions(new ElementRegistry());
    document.body.innerHTML = "";
  });

  function setBody(html: string): void {
    document.body.innerHTML = html;
  }

  it("clicks a menu row by exact text and reports what was clicked", () => {
    setBody(`
      <div role="menu">
        <div role="menuitem" id="ps">Page setup</div>
        <div role="menuitem" id="pr">Print</div>
      </div>`);
    let clicked: string | null = null;
    document.getElementById("ps")!.addEventListener("click", () => (clicked = "ps"));
    document.getElementById("pr")!.addEventListener("click", () => (clicked = "pr"));
    const res = actions.run({ action: "clickByText", labels: ["Page setup"] });
    expect(res.ok).toBe(true);
    expect(clicked).toBe("ps");
    const data = (res as { data?: { clicked?: string } }).data!;
    expect(data.clicked).toContain("Page setup");
  });

  it("matches aria-labels and rows carrying accelerator suffixes (prefix match)", () => {
    setBody(`
      <button id="ins" aria-label="Insert table">Insert</button>
      <div role="menuitem" id="fr">Find and replace Ctrl+H</div>`);
    let clicked = "";
    document.getElementById("ins")!.addEventListener("click", () => (clicked = "ins"));
    document.getElementById("fr")!.addEventListener("click", () => (clicked = "fr"));
    expect(actions.run({ action: "clickByText", labels: ["Insert table"] }).ok).toBe(true);
    expect(clicked).toBe("ins");
    expect(actions.run({ action: "clickByText", labels: ["Find and replace"] }).ok).toBe(true);
    expect(clicked).toBe("fr");
  });

  it("prefers the exact match over a prefix match", () => {
    setBody(`
      <div role="button" id="wrap">Share settings</div>
      <button id="exact">Share</button>`);
    let clicked = "";
    document.getElementById("wrap")!.addEventListener("click", () => (clicked = "wrap"));
    document.getElementById("exact")!.addEventListener("click", () => (clicked = "exact"));
    const res = actions.run({ action: "clickByText", labels: ["Share"] });
    expect(res.ok).toBe(true);
    expect(clicked).toBe("exact");
  });

  it("honours candidate preference order (the page-numbers alternates)", () => {
    setBody(`
      <div role="menuitem" id="bop">Bottom of page</div>
      <div role="menuitem" id="foot">Footer</div>`);
    let clicked = "";
    document.getElementById("bop")!.addEventListener("click", () => (clicked = "bop"));
    document.getElementById("foot")!.addEventListener("click", () => (clicked = "foot"));
    expect(actions.run({ action: "clickByText", labels: ["Bottom of page", "Footer"] }).ok).toBe(true);
    expect(clicked).toBe("bop");
    // When the first candidate is absent, the alternate fires.
    document.getElementById("bop")!.remove();
    expect(actions.run({ action: "clickByText", labels: ["Bottom of page", "Footer"] }).ok).toBe(true);
    expect(clicked).toBe("foot");
  });

  it("refuses a disabled row instead of clicking it", () => {
    setBody(`<div role="menuitem" aria-disabled="true" id="t">Table</div>`);
    let clicked = "";
    document.getElementById("t")!.addEventListener("click", () => (clicked = "t"));
    const res = actions.run({ action: "clickByText", labels: ["Table"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("DISABLED");
    expect(clicked).toBe("");
  });

  it("skips hidden rows and reports a clean miss when nothing matches", () => {
    setBody(`
      <div role="menuitem" style="display:none">Equation</div>
      <div role="menuitem" id="vis">Equation</div>`);
    let clicked = "";
    document.getElementById("vis")!.addEventListener("click", () => (clicked = "vis"));
    expect(actions.run({ action: "clickByText", labels: ["Equation"] }).ok).toBe(true);
    expect(clicked).toBe("vis");

    setBody(`<div>nothing here</div>`);
    const miss = actions.run({ action: "clickByText", labels: ["Page setup"] });
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error).toContain("no visible clickable element");
  });

  it("never clicks a file input by text (the OS picker trap)", () => {
    setBody(`<input type="file" aria-label="Upload from computer" />`);
    const res = actions.run({ action: "clickByText", labels: ["Upload from computer"] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("file input");
  });

  it("matches live Docs rows carrying submenu arrows and status badges", () => {
    // These five shapes come from a real in-page dump of the 2026 Insert menu.
    // The old matcher saw none of them (no exact text, no "label + space"),
    // which is how rows that were on screen got reported missing.
    setBody(`
      <div role="menu">
        <div role="menuitem" id="toc">Table of contents►</div>
        <div role="menuitem" id="pe">Page elementsUpdated►</div>
        <div role="menuitem" id="cm">CommentCtrl+Alt+M</div>
        <div role="menuitem" id="sc">Smart chips(Z)►</div>
        <div role="menuitem" id="es">eSignaturePremium(1)</div>
        <div role="menuitem" id="tab">Tab(F11)Shift+F11</div>
      </div>`);
    let clicked = "";
    for (const id of ["toc", "pe", "cm", "sc", "es", "tab"]) {
      document.getElementById(id)!.addEventListener("click", () => (clicked = id));
    }
    const want: Array<[string, string]> = [
      ["Table of contents", "toc"],
      ["Page elements", "pe"],
      ["Comment", "cm"],
      ["Smart chips", "sc"],
      ["eSignature", "es"],
      ["Tab", "tab"],
    ];
    for (const [label, id] of want) {
      clicked = "";
      expect(actions.run({ action: "clickByText", labels: [label] }).ok).toBe(true);
      expect(clicked).toBe(id);
    }
  });

  it("still prefers the exact row over a longer decorated neighbour", () => {
    setBody(`
      <div role="menu">
        <div role="menuitem" id="t">Table►</div>
        <div role="menuitem" id="toc">Table of contents►</div>
      </div>`);
    let clicked = "";
    document.getElementById("t")!.addEventListener("click", () => (clicked = "t"));
    document.getElementById("toc")!.addEventListener("click", () => (clicked = "toc"));
    expect(actions.run({ action: "clickByText", labels: ["Table"] }).ok).toBe(true);
    expect(clicked).toBe("t");
  });

  it("names the visible rows (and fields) when a label misses — the teaching miss", () => {
    setBody(`
      <div role="menu">
        <div role="menuitem">HeaderCtrl+Alt+O Ctrl+Alt+H</div>
        <div role="menuitem">FooterCtrl+Alt+O Ctrl+Alt+F</div>
        <div role="menuitem">Watermark</div>
      </div>`);
    const miss = actions.run({ action: "clickByText", labels: ["Headers and footers"] });
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toContain("rows in the OPEN menu");
      expect(miss.error).toContain("Header");
      expect(miss.error).toContain("Watermark");
    }

    setBody(`
      <div role="dialog">
        <input aria-label="Top margin" />
        <input placeholder="Bottom margin" />
      </div>`);
    const field = actions.run({ action: "fillField", labels: ["Paper size"], value: "Letter", kind: "select" });
    expect(field.ok).toBe(false);
    if (!field.ok) {
      expect(field.error).toContain("visible fields");
      expect(field.error).toContain("Top margin");
    }
  });

  it("teaches the OPEN submenu's rows, not the menu bar's", () => {
    // The real failure this replaces: Format ▸ Text ▸ Color missed and the hint
    // read "visible menu rows: File, Edit, View, Insert, Format, …" — the bar
    // and the sidebar, so the model could not see what the submenu offered and
    // retried the same wrong label.
    setBody(`
      <div role="menubar">
        <div role="menuitem">File</div>
        <div role="menuitem">Edit</div>
        <div role="menuitem">Format</div>
      </div>
      <div role="menu">
        <div role="menuitem">Font</div>
        <div role="menuitem">Size</div>
        <div role="menuitem">Text colour</div>
      </div>`);
    const miss = actions.run({ action: "clickByText", labels: ["Underline"] });
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toContain("rows in the OPEN menu");
      expect(miss.error).toContain("Text colour");
      expect(miss.error).not.toContain("File");
    }
  });

  it("says when no menu is open instead of implying the rows are gone", () => {
    setBody(`<div><div role="menuitem">File</div><div role="menuitem">Edit</div></div>`);
    const miss = actions.run({ action: "clickByText", labels: ["Underline"] });
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toContain("no menu is open");
      expect(miss.error).toContain("File");
    }
  });

  it("reports a hidden menu bar (Docs full-screen) separately from a rendered one", () => {
    // display:none on the bar AND its row: jsdom has no layout, so a hidden
    // PARENT would not hide its children here the way a 0×0 box does in a
    // browser (where the real signal is `.docs-menubars { display: none }`).
    setBody(`
      <div class="docs-menubars">
        <div class="docs-menubar" role="menubar" style="display:none">
          <div role="menuitem" style="display:none">Format</div>
        </div>
      </div>`);
    expect(actions.run({ action: "menuBarState" })).toMatchObject({
      ok: true,
      data: { visible: false, hiddenBar: true },
    });

    setBody(`
      <div class="docs-menubars">
        <div class="docs-menubar" role="menubar">
          <div role="menuitem">Format</div>
        </div>
      </div>`);
    expect(actions.run({ action: "menuBarState" })).toMatchObject({
      ok: true,
      data: { visible: true, hiddenBar: false },
    });
  });

  it("does not let an open popup stand in for the bar — the miss that skipped the recovery", () => {
    // Measured live (probe v8.4 S5): with the bar hidden, a walk's step 1
    // prefix-matched a toolbar control ("Insert" → "Insert image") and opened a
    // popup. Counting that popup's rows as "the bar is up" is what stopped
    // Ctrl+Shift+F from being pressed, so the walk failed twice and gave up.
    setBody(`
      <div class="docs-menubars">
        <div class="docs-menubar" role="menubar" style="display:none">
          <div role="menuitem" style="display:none">Insert</div>
        </div>
      </div>
      <div role="menu">
        <div role="menuitem">Upload</div>
        <div role="menuitem">By URL</div>
      </div>`);
    expect(actions.run({ action: "menuBarState" })).toMatchObject({
      ok: true,
      data: { visible: false, hiddenBar: true },
    });
  });

  it("says when the menu bar itself is not rendered — 'open it first' is a dead end there", () => {
    // Measured live: .docs-menubar present with a 0×0 box, 0 of 387 menu rows
    // visible, toolbar fine. A run that is told to "open the menu first" cannot.
    // (display:none on the rows themselves: jsdom has no layout, so a hidden
    // PARENT would not hide its children here the way a browser's 0×0 box does.)
    setBody(`
      <div role="menubar">
        <div role="menuitem" style="display:none">File</div>
        <div role="menuitem" style="display:none">Format</div>
      </div>
      <button>Normal text</button>`);
    const miss = actions.run({ action: "clickByText", labels: ["Underline"] });
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toContain("MENU BAR IS NOT ON SCREEN");
      expect(miss.error).toContain("keyboard shortcut");
      expect(miss.error).not.toContain("open it first");
    }
  });

  it("fills a text input found by aria-label, and one by its associated <label>", () => {
    setBody(`
      <input aria-label="Top margin" />
      <label for="lm">Left margin</label><input id="lm" />`);
    const a = actions.run({ action: "fillField", labels: ["Top margin"], value: "1", kind: "text" });
    expect(a.ok).toBe(true);
    expect((document.querySelector('input[aria-label="Top margin"]') as HTMLInputElement).value).toBe("1");
    const b = actions.run({ action: "fillField", labels: ["Left margin"], value: "2" });
    expect(b.ok).toBe(true);
    expect((document.getElementById("lm") as HTMLInputElement).value).toBe("2");
  });

  it("picks a select option by its TEXT and reports the chosen option", () => {
    setBody(`
      <select aria-label="Paper size">
        <option value="ltr">Letter</option>
        <option value="a4">A4</option>
      </select>`);
    const res = actions.run({ action: "fillField", labels: ["Paper size"], value: "A4" });
    expect(res.ok).toBe(true);
    expect((document.querySelector("select") as HTMLSelectElement).value).toBe("a4");
    expect((res as { data?: { option?: string } }).data?.option).toBe("A4");
  });

  it("names the real options when the wanted one does not exist", () => {
    setBody(`
      <select aria-label="Paper size"><option value="ltr">Letter</option></select>`);
    const res = actions.run({ action: "fillField", labels: ["Paper size"], value: "Folio" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("has no option");
      expect(res.error).toContain("Letter");
    }
  });

  it("clicks a radio found by aria-label", () => {
    setBody(`
      <input type="radio" name="o" aria-label="Portrait" />
      <input type="radio" name="o" aria-label="Landscape" />`);
    const res = actions.run({ action: "fillField", labels: ["Landscape"], kind: "radio" });
    expect(res.ok).toBe(true);
    const radios = document.querySelectorAll("input");
    expect(radios[0]!.checked).toBe(false);
    expect(radios[1]!.checked).toBe(true);
  });

  it("queryText reads text by selector and values by label, and reports absence", () => {
    setBody(`
      <div class="kix-paragraphstyles-combobox" role="combobox">Normal text</div>
      <input aria-label="Document title" value="Feature Test" />`);
    const bySelector = actions.run({
      action: "queryText",
      selector: ".kix-paragraphstyles-combobox",
    });
    expect(bySelector.ok).toBe(true);
    expect((bySelector as { data: { text: string } }).data.text).toBe("Normal text");
    const byLabel = actions.run({ action: "queryText", labels: ["Document title"] });
    expect(byLabel.ok).toBe(true);
    expect((byLabel as { data: { value: string } }).data.value).toBe("Feature Test");
    const missing = actions.run({ action: "queryText", selector: '[role="dialog"]' });
    expect(missing.ok).toBe(false);
  });
});
