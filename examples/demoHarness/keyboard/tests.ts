import { describe, expect, it } from "vitest";
import { actionForKey, CTRL_C } from "./index.ts";

describe("actionForKey", () => {
  it("maps m to cycleMode and e to cycleEffect", () => {
    expect(actionForKey("m")).toBe("cycleMode");
    expect(actionForKey("e")).toBe("cycleEffect");
  });

  it("accepts uppercase input", () => {
    expect(actionForKey("M")).toBe("cycleMode");
    expect(actionForKey("E")).toBe("cycleEffect");
  });

  it("maps q and raw Ctrl-C to quit", () => {
    expect(actionForKey("q")).toBe("quit");
    expect(actionForKey(CTRL_C)).toBe("quit");
  });

  it("maps p to togglePause", () => {
    expect(actionForKey("p")).toBe("togglePause");
    expect(actionForKey("P")).toBe("togglePause");
  });

  it("returns undefined for unknown keys", () => {
    expect(actionForKey("x")).toBeUndefined();
    expect(actionForKey("\x1b[A")).toBeUndefined();
  });
});
