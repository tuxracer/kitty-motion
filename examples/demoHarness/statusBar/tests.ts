import { describe, expect, it } from "vitest";
import { formatStatusBar } from "./index.ts";

describe("formatStatusBar", () => {
  it("joins name, fps, mode, effect, and shortcut hints", () => {
    const text = formatStatusBar(
      { demoName: "plasma", fps: 58, paused: false, modeLabel: "kitty", effectName: "none" },
      120,
    );
    expect(text).toBe("plasma  58 fps  kitty  fx: none  [m]ode [g]lyph [e]ffect [p]ause [q]uit");
  });

  it("renders paused in place of the fps field while paused", () => {
    const text = formatStatusBar(
      { demoName: "plasma", fps: 58, paused: true, modeLabel: "kitty", effectName: "none" },
      120,
    );
    expect(text).toBe("plasma  paused  kitty  fx: none  [m]ode [g]lyph [e]ffect [p]ause [q]uit");
  });

  it("truncates to the given width so the line never wraps", () => {
    const text = formatStatusBar(
      { demoName: "plasma", fps: 58, paused: false, modeLabel: "cell truecolor", effectName: "scanlines" },
      20,
    );
    expect(text).toHaveLength(20);
    expect(text.startsWith("plasma  58 fps")).toBe(true);
  });

  it("renders mode labels and effect names verbatim", () => {
    const text = formatStatusBar(
      { demoName: "green-hill", fps: 0, paused: false, modeLabel: "cell (auto)", effectName: "crt" },
      120,
    );
    expect(text).toContain("cell (auto)");
    expect(text).toContain("fx: crt");
  });
});
