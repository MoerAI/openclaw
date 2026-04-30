import { describe, expect, it } from "vitest";
import { appendCronStyleCurrentTimeLine } from "./current-time.js";

const CFG = {
  agents: {
    defaults: {
      userTimezone: "UTC",
    },
  },
};

describe("appendCronStyleCurrentTimeLine", () => {
  it("returns the empty input unchanged", () => {
    expect(appendCronStyleCurrentTimeLine("", CFG, Date.now())).toBe("");
  });

  it("appends a Current time line when none is present", () => {
    const out = appendCronStyleCurrentTimeLine(
      "Heartbeat tick",
      CFG,
      Date.parse("2026-04-30T10:00:00Z"),
    );
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
  });

  it("refreshes an existing Current time line on subsequent calls (#44993)", () => {
    const oldNow = Date.parse("2026-04-30T08:00:00Z");
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const firstPass = appendCronStyleCurrentTimeLine("Heartbeat tick", CFG, oldNow);
    expect(firstPass).toMatch(/Current time:.*2026-04-30 08:00 UTC/);

    const secondPass = appendCronStyleCurrentTimeLine(firstPass, CFG, newNow);
    // Regression: previously this returned firstPass unchanged because of the
    // `base.includes("Current time:")` early-return guard, leaking a stale
    // 08:00 UTC timestamp into every subsequent heartbeat. After the fix the
    // existing line must be replaced with the fresh nowMs.
    expect(secondPass).toContain("Heartbeat tick");
    expect(secondPass).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
    expect(secondPass).not.toMatch(/2026-04-30 08:00 UTC/);
    expect(secondPass.match(/Current time:/g)?.length).toBe(1);
  });

  it("collapses multiple Current time lines into a single fresh entry", () => {
    const stale =
      "Heartbeat tick\nCurrent time: 2025-01-01 00:00 UTC\nCurrent time: 2025-01-02 00:00 UTC";
    const newNow = Date.parse("2026-04-30T10:00:00Z");
    const out = appendCronStyleCurrentTimeLine(stale, CFG, newNow);
    expect(out).toContain("Heartbeat tick");
    expect(out).toMatch(/Current time:.*2026-04-30 10:00 UTC/);
    expect(out).not.toMatch(/2025-01-01/);
    expect(out).not.toMatch(/2025-01-02/);
    expect(out.match(/Current time:/g)?.length).toBe(1);
  });
});
