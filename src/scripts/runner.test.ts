import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runScript, listTools } from "./runner.ts";

describe("script runner", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it("executes a bash script with stdin input", async () => {
    const script = path.join(tmpDir, "echo.sh");
    fs.writeFileSync(script, "#!/bin/bash\ncat", { mode: 0o755 });
    const result = await runScript(script, '{"text":"hello"}', 5);
    expect(result).toBe('{"text":"hello"}');
  });

  it("captures stdout", async () => {
    const script = path.join(tmpDir, "greet.sh");
    fs.writeFileSync(script, '#!/bin/bash\necho "hi there"', { mode: 0o755 });
    const result = await runScript(script, "{}", 5);
    expect(result.trim()).toBe("hi there");
  });

  it("throws on timeout", async () => {
    const script = path.join(tmpDir, "slow.sh");
    fs.writeFileSync(script, "#!/bin/bash\nsleep 10", { mode: 0o755 });
    await expect(runScript(script, "{}", 1)).rejects.toThrow();
  });

  it("lists tool scripts", async () => {
    fs.writeFileSync(path.join(tmpDir, "foo.sh"), "#!/bin/bash\n", {
      mode: 0o755,
    });
    fs.writeFileSync(
      path.join(tmpDir, "bar.py"),
      "#!/usr/bin/env python3\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "not a tool");
    const tools = await listTools(tmpDir);
    expect(tools).toHaveLength(2);
  });
});
