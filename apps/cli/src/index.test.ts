import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("@devlog/cli loads", () => {
  expect(packageName).toBe("@devlog/cli");
});
