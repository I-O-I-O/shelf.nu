import { describe, expect, it } from "vitest";
import { assertImportApplyPhase, withImportPhase } from "./import-phase.server";

describe("inventory import phases", () => {
  it("fails closed outside Apply", () => {
    expect(assertImportApplyPhase).toThrow("explicit Apply");
  });
  it.each(["PREPARE", "REVIEW"] as const)(
    "cannot escalate %s into Apply across async helpers",
    async (phase) => {
      await withImportPhase(phase, async () => {
        await Promise.resolve();
        expect(assertImportApplyPhase).toThrow("explicit Apply");
        expect(() => withImportPhase("APPLY", assertImportApplyPhase)).toThrow(
          "explicit Apply"
        );
      });
    }
  );
  it("isolates concurrent analysis and Apply", async () => {
    await Promise.all([
      withImportPhase("PREPARE", async () => {
        await Promise.resolve();
        expect(assertImportApplyPhase).toThrow();
      }),
      withImportPhase("APPLY", async () => {
        await Promise.resolve();
        expect(assertImportApplyPhase).not.toThrow();
      }),
    ]);
    expect(assertImportApplyPhase).toThrow();
  });
});
