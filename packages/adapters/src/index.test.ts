import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("@devlog/adapters loads", () => {
  expect(packageName).toBe("@devlog/adapters");
});
