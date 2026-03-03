import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getScriptDescription, listScripts, runScript } from "./runner.ts";

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

  it("passes env vars to child process", async () => {
    const script = path.join(tmpDir, "env.sh");
    fs.writeFileSync(script, '#!/bin/bash\necho "$TOOL_API_KEY"', { mode: 0o755 });
    const result = await runScript(script, "{}", 5, { TOOL_API_KEY: "secret123" });
    expect(result.trim()).toBe("secret123");
  });

  it("inherits process.env when env is provided", async () => {
    const script = path.join(tmpDir, "path.sh");
    fs.writeFileSync(script, '#!/bin/bash\necho "$PATH" | head -c 1', { mode: 0o755 });
    const result = await runScript(script, "{}", 5, { TOOL_X: "y" });
    expect(result.trim()).toBe("/");
  });

  it("lists scripts", async () => {
    fs.writeFileSync(path.join(tmpDir, "foo.sh"), "#!/bin/bash\n", {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(tmpDir, "bar.py"), "#!/usr/bin/env python3\n", { mode: 0o755 });
    fs.writeFileSync(path.join(tmpDir, "readme.md"), "not a script");
    const scripts = await listScripts(tmpDir);
    expect(scripts).toHaveLength(2);
  });
});

describe("getScriptDescription", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "desc-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it("extracts bash comment header after shebang", async () => {
    const file = path.join(tmpDir, "test.sh");
    fs.writeFileSync(file, "#!/bin/bash\n# Search for flights\n# Input: JSON with origin, dest\nset -e\n");
    const desc = await getScriptDescription(file);
    expect(desc).toBe("Search for flights\nInput: JSON with origin, dest");
  });

  it("extracts python hash comments", async () => {
    const file = path.join(tmpDir, "test.py");
    fs.writeFileSync(file, "#!/usr/bin/env python3\n# Fetch weather data\nimport sys\n");
    const desc = await getScriptDescription(file);
    expect(desc).toBe("Fetch weather data");
  });

  it("extracts python single-line docstring", async () => {
    const file = path.join(tmpDir, "test.py");
    fs.writeFileSync(file, '#!/usr/bin/env python3\n"""Fetch weather data"""\nimport sys\n');
    const desc = await getScriptDescription(file);
    expect(desc).toBe("Fetch weather data");
  });

  it("extracts python multi-line docstring", async () => {
    const file = path.join(tmpDir, "test.py");
    fs.writeFileSync(
      file,
      '#!/usr/bin/env python3\n"""\nFetch weather data\nReturns JSON\n"""\nimport sys\n',
    );
    const desc = await getScriptDescription(file);
    expect(desc).toBe("Fetch weather data\nReturns JSON");
  });

  it("extracts JS/TS slash comments", async () => {
    const file = path.join(tmpDir, "test.ts");
    fs.writeFileSync(file, "// Calculate route distances\n// Input: {from, to}\nconst x = 1;\n");
    const desc = await getScriptDescription(file);
    expect(desc).toBe("Calculate route distances\nInput: {from, to}");
  });

  it("returns empty string when no comments", async () => {
    const file = path.join(tmpDir, "test.sh");
    fs.writeFileSync(file, "#!/bin/bash\necho hello\n");
    const desc = await getScriptDescription(file);
    expect(desc).toBe("");
  });

  it("returns empty string for missing file", async () => {
    const desc = await getScriptDescription(path.join(tmpDir, "nope.sh"));
    expect(desc).toBe("");
  });

  it("listScripts includes descriptions", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "search.sh"),
      "#!/bin/bash\n# Search flights\necho ok\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(tmpDir, "bare.sh"), "#!/bin/bash\necho ok\n", {
      mode: 0o755,
    });
    const scripts = await listScripts(tmpDir);
    const search = scripts.find((s) => s.name === "search");
    const bare = scripts.find((s) => s.name === "bare");
    expect(search?.description).toBe("Search flights");
    expect(bare?.description).toBeUndefined();
  });
});
