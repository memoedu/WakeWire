import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandLock } from "./remnote-command-lock.js";

describe("command writer lock", () => {
  it("serializes independent writers and releases for a later run", () => {
    const base =
      process.platform === "win32"
        ? "D:/Artifacts/UnifiedCommandInbox/lock-tests"
        : path.join(os.tmpdir(), "wakewire-command-lock-tests");
    fs.mkdirSync(base, { recursive: true });
    const folder = fs.mkdtempSync(path.join(base, "case-"));
    const config = path.join(folder, "config.json");
    const release = commandLock(config);
    try {
      expect(() => commandLock(config)).toThrow("command-run-busy");
    } finally {
      release();
    }
    const next = commandLock(config);
    next();
    expect(fs.existsSync(path.join(folder, "command-run.lock"))).toBe(false);
  });
});
