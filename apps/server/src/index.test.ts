import { expect, test } from "vitest";
import { packageName } from "./index.js";

test("@devlog/server loads", () => {
  expect(packageName).toBe("@devlog/server");
});
