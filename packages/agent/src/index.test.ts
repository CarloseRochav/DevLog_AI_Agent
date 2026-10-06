import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("@devlog/agent loads", () => {
  expect(packageName).toBe("@devlog/agent");
});
