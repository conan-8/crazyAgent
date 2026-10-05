// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  cssPath,
  ElementRegistry,
} from "../extension/src/content/registry";

function setBody(html: string): void {
  document.body.innerHTML = html;
}

describe("ElementRegistry", () => {
  let registry: ElementRegistry;

  beforeEach(() => {
    registry = new ElementRegistry();
  });

  it("collects interactive elements with names and refs", () => {
    setBody(`
      <a id="docs-link" href="/docs.html">Docs</a>
      <form>
        <label for="q">Search</label>
        <input id="q" name="q" type="text" placeholder="search terms" />
        <select id="scope"><option value="all">All</option></select>
        <input id="deep" type="checkbox" checked />
        <button id="search-btn" type="submit">Search</button>
      </form>
    `);
    const snap = registry.collect();
    const byName = (n: string) => snap.elements.find((e) => e.name === n);

    expect(snap.elements.map((e) => e.ref)).toEqual(["1", "2", "3", "4", "5"]);
    expect(byName("Docs")?.tag).toBe("a");
    expect(byName("Docs")?.href).toBe("/docs.html");
    expect(byName("Search")?.tag).toBe("input"); // label "Search" wins for the input
    expect(byName("All")?.tag).toBe("select");
    expect(byName("Search")?.type).toBe("text");
    const checkbox = snap.elements.find((e) => e.type === "checkbox");
    expect(checkbox?.checked).toBe(true);
    const submit = snap.elements.find(
      (e) => e.tag === "button" && e.name === "Search",
    );
    expect(submit?.type).toBe("submit");
  });

  it("collects elements inside open shadow roots", () => {
    setBody(`<div id="host"></div>`);
    const host = document.getElementById("host")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `
      <input id="shadow-input" placeholder="shadow input" />
      <button id="shadow-btn">Shadow button</button>
    `;
    const snap = registry.collect();
    const names = snap.elements.map((e) => e.name);
    expect(names).toContain("shadow input");
    expect(names).toContain("Shadow button");
  });

  it("excludes invisible elements", () => {
    setBody(`
      <button id="shown">Shown</button>
      <button id="hidden1" style="display:none">Hidden 1</button>
      <button id="hidden2" hidden>Hidden 2</button>
    `);
    const snap = registry.collect();
    expect(snap.elements.map((e) => e.name)).toEqual(["Shown"]);
  });

  it("collects hidden file inputs — the styled-upload pattern is the one exemption", () => {
    setBody(`
      <label for="picker">Upload</label>
      <input id="picker" type="file" style="display:none" />
      <button id="hidden-btn" style="display:none">Nope</button>
    `);
    const snap = registry.collect();
    const fileEl = snap.elements.find((e) => e.tag === "input" && e.type === "file");
    expect(fileEl).toBeDefined();
    expect(registry.resolve(fileEl!.ref)).toBe(document.getElementById("picker"));
    // Other hidden elements stay excluded.
    expect(snap.elements.map((e) => e.name)).not.toContain("Nope");
  });

  it("resolves refs to the same element", () => {
    setBody(`<button id="b1">One</button><button id="b2">Two</button>`);
    const snap = registry.collect();
    const ref = snap.elements.find((e) => e.name === "Two")!.ref;
    expect(registry.resolve(ref)).toBe(document.getElementById("b2"));
  });

  it("recovers a stale ref after a SPA re-render", () => {
    setBody(`<ul id="list"><li><button id="old">Row 1</button></li></ul>`);
    const snap = registry.collect();
    const ref = snap.elements.find((e) => e.name === "Row 1")!.ref;

    // Simulate re-render: destroy and recreate the node.
    const list = document.getElementById("list")!;
    list.innerHTML = `<li><button id="new">Row 1</button></li>`;

    const resolved = registry.resolve(ref);
    expect(resolved).toBe(document.getElementById("new"));
  });

  it("returns null for refs whose target is truly gone", () => {
    setBody(`<button id="b1">One</button>`);
    const snap = registry.collect();
    const ref = snap.elements[0]!.ref;
    document.body.innerHTML = `<p>emptied</p>`;
    expect(registry.resolve(ref)).toBeNull();
  });

  it("produces stable refs and names across identical collections", () => {
    setBody(`
      <a href="/x">X</a><input placeholder="y" /><button>Z</button>
    `);
    const a = registry.collect();
    const b = registry.collect();
    expect(b.elements).toEqual(a.elements);
  });

  it("names a select by its selected option", () => {
    setBody(`
      <select id="scope">
        <option value="all">All</option>
        <option value="titles">Titles</option>
      </select>
    `);
    const snap = registry.collect();
    expect(snap.elements[0]?.name).toBe("All");
  });

  it("cssPath targets an element uniquely enough to re-find it", () => {
    setBody(`<div><button>One</button><button id="two">Two</button></div>`);
    const el = document.getElementById("two")!;
    expect(document.querySelector(cssPath(el))).toBe(el);
  });

  // Regression: Instagram's DM composer uses a bare `contenteditable`
  // attribute, which `[contenteditable="true"]` does not match — so the
  // composer never appeared in the snapshot as a typable element.
  it("discovers contenteditable composers using a bare attribute", () => {
    setBody(`<div id="dm" role="textbox" contenteditable aria-label="Message"></div>`);
    const snap = registry.collect();
    const dm = snap.elements.find((e) => e.name === "Message");
    expect(dm).toBeDefined();
    expect(dm?.tag).toBe("div");
    expect(dm?.editable).toBe(true);
  });

  it("discovers contenteditable=true and marks it editable", () => {
    setBody(`<div role="textbox" contenteditable="true" aria-label="Comment"></div>`);
    const el = registry.collect().elements.find((e) => e.name === "Comment");
    expect(el?.editable).toBe(true);
  });

  it("marks form controls editable and plain buttons not editable", () => {
    setBody(`
      <input placeholder="text field" />
      <textarea placeholder="notes"></textarea>
      <button>Send</button>
    `);
    const snap = registry.collect();
    const byName = (n: string) => snap.elements.find((e) => e.name === n);
    expect(byName("text field")?.editable).toBe(true);
    expect(byName("notes")?.editable).toBe(true);
    expect(byName("Send")?.editable).toBe(false);
  });

  it("does not misreport type/disabled/checked on a contenteditable div", () => {
    setBody(`<div role="textbox" contenteditable aria-label="Message"></div>`);
    const dm = registry.collect().elements.find((e) => e.name === "Message");
    expect(dm?.type).toBeUndefined();
    expect(dm?.disabled).toBeUndefined();
    expect(dm?.checked).toBeUndefined();
  });

  // Regression: describe() used `el.value` as its last name fallback and then
  // called `.trim()` on the result. Elements matched via [onclick]/role are not
  // form controls, so their `.value` need not be a string — <li value="2">
  // exposes it as a number — and collect() died with
  // "name.trim is not a function" before a single element was registered.
  it("survives interactive elements whose .value is not a string", () => {
    setBody(`<ul><li id="row" value="2" onclick="void 0">   </li></ul>`);
    // Sanity: the fixture reproduces the type confusion this guards against.
    expect(typeof (document.getElementById("row") as HTMLLIElement).value).toBe(
      "number",
    );

    const snap = registry.collect(); // must not throw
    const row = snap.elements.find((e) => e.tag === "li");
    expect(row?.name).toBe("2");
  });
});
