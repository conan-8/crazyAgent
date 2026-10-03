import { describe, expect, it } from "vitest";
import {
  matchSlash,
  parseSlash,
  SLASH_COMMANDS,
} from "../extension/src/shared/slash";

describe("parseSlash", () => {
  it("parses a bare command", () => {
    expect(parseSlash("/new")).toEqual({ command: "new", arg: "", known: true });
  });

  it("parses command + argument, trimmed", () => {
    expect(parseSlash("/rename  My Thread ")).toEqual({
      command: "rename",
      arg: "My Thread",
      known: true,
    });
  });

  it("lowercases the command but preserves argument case", () => {
    expect(parseSlash("/MODEL GPT-4o")).toEqual({
      command: "model",
      arg: "GPT-4o",
      known: true,
    });
  });

  it("keeps multi-word arguments intact", () => {
    expect(parseSlash("/model deepseek chat v3")?.arg).toBe("deepseek chat v3");
  });

  it("tolerates leading whitespace", () => {
    expect(parseSlash("  /sessions")?.command).toBe("sessions");
  });

  it("flags unknown commands as not known (still parsed)", () => {
    expect(parseSlash("/frobnicate x")).toEqual({
      command: "frobnicate",
      arg: "x",
      known: false,
    });
  });

  it("returns null for ordinary text", () => {
    expect(parseSlash("hello /new")).toBeNull();
    expect(parseSlash("divide 10/2")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });

  it("knows exactly the shipped command set", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      "new",
      "model",
      "sessions",
      "rename",
    ]);
  });
});

describe("matchSlash", () => {
  it("lists every command for a bare slash", () => {
    expect(matchSlash("/").map((c) => c.name)).toEqual([
      "new",
      "model",
      "sessions",
      "rename",
    ]);
  });

  it("filters by prefix while the word is typed", () => {
    expect(matchSlash("/n").map((c) => c.name)).toEqual(["new"]);
    expect(matchSlash("/re").map((c) => c.name)).toEqual(["rename"]);
    expect(matchSlash("/s").map((c) => c.name)).toEqual(["sessions"]);
  });

  it("is case-insensitive", () => {
    expect(matchSlash("/MOD").map((c) => c.name)).toEqual(["model"]);
  });

  it("still matches a fully typed command word", () => {
    expect(matchSlash("/new").map((c) => c.name)).toEqual(["new"]);
  });

  it("closes once an argument space appears", () => {
    expect(matchSlash("/rename foo")).toEqual([]);
    expect(matchSlash("/model ")).toEqual([]);
  });

  it("returns nothing for unknown prefixes or ordinary text", () => {
    expect(matchSlash("/zzz")).toEqual([]);
    expect(matchSlash("hello")).toEqual([]);
    expect(matchSlash("")).toEqual([]);
  });
});
