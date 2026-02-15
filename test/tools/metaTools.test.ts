/* eslint-disable @typescript-eslint/no-explicit-any */

const mockGetToolRegistry = jest.fn();
const mockClearSchemaCache = jest.fn();
const mockRegisterDynamicTools = jest.fn();

jest.mock("../../src/tools/dynamicTools", () => ({
  getToolRegistry: mockGetToolRegistry,
  clearSchemaCache: mockClearSchemaCache,
  registerDynamicTools: mockRegisterDynamicTools,
}));

jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Capture tool registrations via a fake McpServer
const toolHandlers: Record<string, Function> = {};
const mockServer = {
  tool: jest.fn((...args: any[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as Function;
    toolHandlers[name] = handler;
  }),
};

import { configureMetaTools } from "../../src/tools/metaTools";

const armContext = {
  subscriptionId: "sub-123",
  resourceGroup: "rg-test",
  location: "westus",
};
const tokenProvider = jest.fn().mockResolvedValue("test-token");
const userAgentProvider = jest.fn().mockReturnValue("TestAgent/1.0");

describe("list_dynamic_tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
    configureMetaTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
  });

  it("returns empty array when registry is empty", async () => {
    mockGetToolRegistry.mockReturnValue(new Map());

    const result = await toolHandlers["list_dynamic_tools"]({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
    expect(result.isError).toBeUndefined();
  });

  it("returns correct entries when registry has tools", async () => {
    const registry = new Map([
      [
        "office365_send_email",
        {
          connection: {
            name: "office365-conn",
            apiName: "office365",
            displayName: "Office 365",
            status: "Connected",
            apiId: "/some/api/id",
          },
          operation: {
            operationId: "SendEmail",
            method: "post",
            summary: "Send an email",
            path: "/mail/send",
            description: "Send an email message",
            parameters: [],
          },
        },
      ],
      [
        "teams_post_message",
        {
          connection: {
            name: "teams-conn",
            apiName: "teams",
            displayName: "Microsoft Teams",
            status: "Unauthenticated",
            apiId: "/some/teams/id",
          },
          operation: {
            operationId: "PostMessage",
            method: "post",
            summary: "Post a message",
            path: "/messages",
            description: "Post a message to a channel",
            parameters: [],
          },
        },
      ],
    ]);
    mockGetToolRegistry.mockReturnValue(registry);

    const result = await toolHandlers["list_dynamic_tools"]({});
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      tool: "office365_send_email",
      api: "office365",
      displayName: "Office 365",
      status: "Connected",
      operationId: "SendEmail",
      method: "POST",
      summary: "Send an email",
    });
    expect(parsed[1]).toEqual({
      tool: "teams_post_message",
      api: "teams",
      displayName: "Microsoft Teams",
      status: "Unauthenticated",
      operationId: "PostMessage",
      method: "POST",
      summary: "Post a message",
    });
    expect(result.isError).toBeUndefined();
  });
});

describe("refresh_tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
    configureMetaTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
  });

  it("clears cache and returns registration stats", async () => {
    mockRegisterDynamicTools.mockResolvedValue({ registered: 5, skipped: 2, errors: 1 });

    const result = await toolHandlers["refresh_tools"]({});

    expect(mockClearSchemaCache).toHaveBeenCalledTimes(1);
    expect(mockRegisterDynamicTools).toHaveBeenCalledWith(
      mockServer,
      tokenProvider,
      armContext,
      userAgentProvider
    );
    expect(result.content[0].text).toBe(
      "Refresh complete. Registered: 5, Skipped: 2, Errors: 1"
    );
    expect(result.isError).toBeUndefined();
  });

  it("returns isError when registerDynamicTools throws", async () => {
    mockRegisterDynamicTools.mockRejectedValue(new Error("network down"));

    const result = await toolHandlers["refresh_tools"]({});

    expect(mockClearSchemaCache).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network down");
  });
});
