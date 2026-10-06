import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("@devlog/config loads", () => {
  expect(packageName).toBe("@devlog/config");
});
