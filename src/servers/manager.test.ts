import { beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/*  Mock node:fs/promises                                              */
/* ------------------------------------------------------------------ */

const mockReaddir = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => mockReaddir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

/* ------------------------------------------------------------------ */
/*  Mock MCP SDK                                                       */
/* ------------------------------------------------------------------ */

const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class Client {
    connect = mockConnect;
    listTools = mockListTools;
    callTool = mockCallTool;
    close = mockClose;
  }
  return { Client };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  class StdioClientTransport {
    params: unknown;
    constructor(params: unknown) {
      this.params = params;
    }
  }
  return { StdioClientTransport };
});

/* ------------------------------------------------------------------ */
/*  Import under test (after mocks)                                    */
/* ------------------------------------------------------------------ */

import { listServerConfigs, createMcpManager } from "./manager.ts";

/* ================================================================== */
/*  listServerConfigs                                                  */
/* ================================================================== */

describe("listServerConfigs", () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    mockReadFile.mockReset();
  });

  it("reads .json files and returns ServerConfig objects", async () => {
    mockReaddir.mockResolvedValue(["weather.json", "calendar.json"]);
    mockReadFile
      .mockResolvedValueOnce(
        JSON.stringify({ command: "node", args: ["weather.js"], description: "Weather" }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ command: "python", args: ["cal.py"] }),
      );

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({
      name: "weather",
      command: "node",
      args: ["weather.js"],
      description: "Weather",
    });
    expect(configs[1]).toEqual({
      name: "calendar",
      command: "python",
      args: ["cal.py"],
    });
  });

  it("skips non-.json files", async () => {
    mockReaddir.mockResolvedValue(["readme.md", "notes.txt", "good.json"]);
    mockReadFile.mockResolvedValue(JSON.stringify({ command: "echo" }));

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("good");
    // readFile should only be called once (for good.json)
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it("returns [] when directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));

    const configs = await listServerConfigs("/nonexistent");

    expect(configs).toEqual([]);
  });

  it("skips files with invalid JSON", async () => {
    mockReaddir.mockResolvedValue(["bad.json", "good.json"]);
    mockReadFile
      .mockResolvedValueOnce("not json {{{")
      .mockResolvedValueOnce(JSON.stringify({ command: "echo" }));

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("good");
  });

  it("skips files missing the command field", async () => {
    mockReaddir.mockResolvedValue(["nocommand.json", "hascommand.json"]);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ description: "no command here" }))
      .mockResolvedValueOnce(JSON.stringify({ command: "ls" }));

    const configs = await listServerConfigs("/servers");

    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe("hascommand");
  });
});

/* ================================================================== */
/*  createMcpManager                                                   */
/* ================================================================== */

describe("createMcpManager", () => {
  beforeEach(() => {
    mockReaddir.mockReset();
    mockReadFile.mockReset();
    mockConnect.mockReset();
    mockListTools.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
  });

  function setupOneServer() {
    mockReaddir.mockResolvedValue(["weather.json"]);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ command: "node", args: ["weather.js"], description: "Weather API" }),
    );
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "get_forecast",
          description: "Get weather forecast",
          inputSchema: {
            type: "object" as const,
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
        {
          name: "get_alerts",
          description: "Get weather alerts",
          inputSchema: {
            type: "object" as const,
            properties: {},
          },
        },
      ],
    });
  }

  it("discovers and namespaces tools from servers", async () => {
    setupOneServer();
    const mgr = createMcpManager();

    await mgr.start("/servers", {});

    const defs = mgr.definitions();
    expect(defs).toHaveLength(2);
    expect(defs[0].name).toBe("mcp_weather_get_forecast");
    expect(defs[0].description).toBe("Get weather forecast");
    expect(defs[1].name).toBe("mcp_weather_get_alerts");
  });

  it("routes execute calls to the correct server", async () => {
    setupOneServer();
    mockCallTool.mockResolvedValue({
      content: [{ type: "text", text: "Sunny, 72F" }],
    });

    const mgr = createMcpManager();
    await mgr.start("/servers", {});

    const result = await mgr.execute("mcp_weather_get_forecast", { city: "SF" });

    expect(result).toBe("Sunny, 72F");
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "get_forecast",
      arguments: { city: "SF" },
    });
  });

  it("concatenates multiple text content blocks", async () => {
    setupOneServer();
    mockCallTool.mockResolvedValue({
      content: [
        { type: "text", text: "Line 1" },
        { type: "image", data: "..." },
        { type: "text", text: "Line 2" },
      ],
    });

    const mgr = createMcpManager();
    await mgr.start("/servers", {});

    const result = await mgr.execute("mcp_weather_get_forecast", {});
    expect(result).toBe("Line 1\nLine 2");
  });

  it("returns error string for unknown tool", async () => {
    const mgr = createMcpManager();

    const result = await mgr.execute("mcp_nonexistent_tool", {});

    expect(result).toContain("unknown MCP tool");
    expect(result).toContain("mcp_nonexistent_tool");
  });

  it("returns error string when callTool throws", async () => {
    setupOneServer();
    mockCallTool.mockRejectedValue(new Error("connection lost"));

    const mgr = createMcpManager();
    await mgr.start("/servers", {});

    const result = await mgr.execute("mcp_weather_get_forecast", {});
    expect(result).toContain("Error from MCP server");
    expect(result).toContain("weather");
    expect(result).toContain("connection lost");
  });

  it("skips servers that fail to connect", async () => {
    mockReaddir.mockResolvedValue(["broken.json", "good.json"]);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ command: "broken-cmd" }))
      .mockResolvedValueOnce(JSON.stringify({ command: "good-cmd" }));

    // First server connect fails, second succeeds
    mockConnect
      .mockRejectedValueOnce(new Error("spawn failed"))
      .mockResolvedValueOnce(undefined);
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "do_thing",
          description: "Does a thing",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });

    const mgr = createMcpManager();
    await mgr.start("/servers", {});

    const defs = mgr.definitions();
    // Only tools from the good server
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("mcp_good_do_thing");
  });

  it("returns server summaries", async () => {
    setupOneServer();
    const mgr = createMcpManager();
    await mgr.start("/servers", {});

    const summaries = mgr.serverSummaries();
    expect(summaries).toEqual([
      { name: "weather", description: "Weather API" },
    ]);
  });

  it("returns server summaries without description when not set", async () => {
    mockReaddir.mockResolvedValue(["plain.json"]);
    mockReadFile.mockResolvedValue(JSON.stringify({ command: "echo" }));
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });

    const mgr = createMcpManager();
    await mgr.start("/servers", {});

    const summaries = mgr.serverSummaries();
    expect(summaries).toEqual([{ name: "plain" }]);
    expect(summaries[0]).not.toHaveProperty("description");
  });

  it("stop closes all clients and clears state", async () => {
    setupOneServer();
    mockClose.mockResolvedValue(undefined);

    const mgr = createMcpManager();
    await mgr.start("/servers", {});
    expect(mgr.definitions()).toHaveLength(2);

    await mgr.stop();

    expect(mockClose).toHaveBeenCalled();
    expect(mgr.definitions()).toEqual([]);
    expect(mgr.serverSummaries()).toEqual([]);
  });

  it("reload re-discovers tools using stored args", async () => {
    setupOneServer();
    mockClose.mockResolvedValue(undefined);

    const mgr = createMcpManager();
    await mgr.start("/servers", { KEY: "val" });
    expect(mgr.definitions()).toHaveLength(2);

    // Change what listTools returns to verify reload actually re-runs start
    mockListTools.mockResolvedValue({
      tools: [
        {
          name: "new_tool",
          description: "A new tool",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    });

    await mgr.reload();

    const defs = mgr.definitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("mcp_weather_new_tool");
    expect(mockClose).toHaveBeenCalled();
  });

  it("reload throws if called before start", async () => {
    const mgr = createMcpManager();
    await expect(mgr.reload()).rejects.toThrow("before start()");
  });

  it("start is idempotent — clears previous state", async () => {
    setupOneServer();
    mockClose.mockResolvedValue(undefined);

    const mgr = createMcpManager();
    await mgr.start("/servers", {});
    expect(mgr.definitions()).toHaveLength(2);

    // Start again — should close previous and rediscover
    await mgr.start("/servers", {});
    expect(mgr.definitions()).toHaveLength(2);
    // close was called during restart
    expect(mockClose).toHaveBeenCalled();
  });
});
