import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("@devlog/core loads", () => {
  expect(packageName).toBe("@devlog/core");
});
