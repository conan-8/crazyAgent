import { describe, expect, it } from "vitest";
import {
  handoffMessage,
  handoffReason,
  isWallControl,
  taskMentionsLogin,
  type AuthSignals,
  type WallProbe,
} from "../extension/src/shared/handoff";

const wall = (over: Partial<AuthSignals> = {}): AuthSignals => ({
  url: "https://example.com/login",
  title: "Sign in",
  captcha: false,
  passwordField: true,
  ...over,
});

const passwordField: WallProbe = {
  tag: "input",
  type: "password",
  text: "",
  inForm: true,
};
const loginSubmit: WallProbe = {
  tag: "button",
  type: "submit",
  text: "Log in",
  inForm: true,
};
const promoButton: WallProbe = {
  tag: "button",
  type: "button",
  text: "Upgrade plan",
  inForm: false,
};

describe("handoffReason", () => {
  it("always hands off a CAPTCHA — no agent can honestly complete one", () => {
    const reason = handoffReason(
      wall({ captcha: true, url: "https://example.com/checkout" }),
      "buy the cheapest option",
      promoButton,
    );
    expect(reason).toContain("CAPTCHA");
  });

  it("hands off when the action target is part of an unexpected sign-in wall", () => {
    expect(handoffReason(wall(), "summarise my invoices", passwordField)).toContain("sign-in");
    expect(handoffReason(wall(), "summarise my invoices", loginSubmit)).toContain("sign-in");
  });

  it("does not block actions that merely happen to live on a login page", () => {
    expect(handoffReason(wall(), "use my store credit", promoButton)).toBeNull();
  });

  it("never hands off merely because a password field exists", () => {
    expect(
      handoffReason(
        wall({ url: "https://example.com/settings/profile", title: "Profile" }),
        "update my profile",
        passwordField,
      ),
    ).toBeNull();
  });

  it("never hands off when the task is itself about signing in", () => {
    expect(handoffReason(wall(), "log in to the dashboard with the saved password", passwordField)).toBeNull();
    expect(handoffReason(wall(), "enter the credentials from the note", loginSubmit)).toBeNull();
    expect(taskMentionsLogin("solve the captcha if it appears")).toBe(true);
    expect(taskMentionsLogin("summarise the front page")).toBe(false);
  });

  it("recognises 2FA / verification wording in the title as a wall page", () => {
    expect(
      handoffReason(
        wall({
          url: "https://example.com/verify",
          title: "Verification required",
          passwordField: false,
        }),
        "download the invoice",
        passwordField,
      ),
    ).toContain("sign-in");
  });

  it("needs both halves: a wall-looking page AND a wall control", () => {
    expect(isWallControl(passwordField)).toBe(true);
    expect(isWallControl(loginSubmit)).toBe(true);
    expect(isWallControl(promoButton)).toBe(false);
    expect(isWallControl(null)).toBe(false);
  });
});

describe("handoffMessage", () => {
  it("tells the model what happened and what to do next, in both outcomes", () => {
    const handled = handoffMessage("a CAPTCHA is on the page", true);
    const skipped = handoffMessage("a CAPTCHA is on the page", false);
    expect(handled).toContain("user took over");
    expect(handled).toContain("fresh snapshot");
    expect(skipped).toContain("let you try");
    expect(skipped).toContain("stop if the wall is still there");
  });
});
