import { describe, expect, it } from "vitest";
import { isStamped, versionLabel } from "../extension/src/shared/version";

describe("version label", () => {
  it("shows the commit stamp the build wrote", () => {
    expect(versionLabel({ version: "0.1.0", stamp: "116599e" })).toBe(
      "Version 0.1.0 · build 116599e",
    );
    // A build from modified sources says so rather than wearing a clean sha.
    expect(versionLabel({ version: "0.1.0", stamp: "116599e-dirty" })).toContain("116599e-dirty");
  });

  it("is honest when the build carried no stamp", () => {
    expect(versionLabel({ version: "0.1.0" })).toContain("unknown");
    expect(versionLabel({ version: "0.1.0", stamp: "   " })).toContain("unknown");
    expect(isStamped("116599e")).toBe(true);
    expect(isStamped("116599e-dirty")).toBe(true);
    expect(isStamped(undefined)).toBe(false);
    expect(isStamped("unknown")).toBe(false);
  });
});
