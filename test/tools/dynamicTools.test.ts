/* eslint-disable @typescript-eslint/no-explicit-any */

const mockArmRequest = jest.fn();

jest.mock("../../src/arm", () => ({
  armRequest: mockArmRequest,
}));

jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  buildToolName,
  buildToolDescription,
  fetchApiSchema,
  clearSchemaCache,
  getToolRegistry,
  clearToolRegistry,
  registerDynamicTools,
  registerToolsForConnection,
  invokeDynamicTool,
  ConnectionInfo,
} from "../../src/tools/dynamicTools";

import type { ParsedOperation } from "../../src/schema/openApiParser";

// ── Test fixtures ────────────────────────────────────────────────────────

const toolHandlers: Record<string, Function> = {};
const mockServer = {
  tool: jest.fn((...args: any[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as Function;
    toolHandlers[name] = handler;
  }),
  server: {
    sendNotification: jest.fn(),
  },
};

const armContext = {
  subscriptionId: "sub-123",
  resourceGroup: "rg-test",
  location: "westus",
};
const tokenProvider = jest.fn().mockResolvedValue("test-token");
const userAgentProvider = jest.fn().mockReturnValue("TestAgent/1.0");

function makeConnection(overrides?: Partial<ConnectionInfo>): ConnectionInfo {
  return {
    name: "office365",
    apiName: "office365",
    displayName: "Office 365 Outlook",
    status: "Connected",
    apiId: "/subscriptions/sub-123/providers/Microsoft.Web/locations/westus/managedApis/office365",
    ...overrides,
  };
}

function makeOperation(overrides?: Partial<ParsedOperation>): ParsedOperation {
  return {
    operationId: "SendEmail",
    method: "post",
    path: "/{connectionId}/v2/Mail",
    summary: "Send an email",
    description: "Sends an email message",
    deprecated: false,
    visibility: "none",
    isTrigger: false,
    parameters: [
      { name: "connectionId", in: "path", type: "string", required: true, description: "" },
    ],
    ...overrides,
  };
}

function makeSwagger(ops?: Record<string, any>) {
  return {
    swagger: "2.0",
    info: { title: "Test", version: "1.0" },
    host: "api.test.com",
    paths: ops ?? {
      "/{connectionId}/v2/Mail": {
        post: {
          operationId: "SendEmail",
          summary: "Send an email",
          description: "Sends an email message",
          parameters: [
            { name: "connectionId", in: "path", type: "string", required: true },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
      "/{connectionId}/v2/Mail/{messageId}": {
        get: {
          operationId: "GetMessage",
          summary: "Get a message",
          description: "Gets a message by ID",
          parameters: [
            { name: "connectionId", in: "path", type: "string", required: true },
            { name: "messageId", in: "path", type: "string", required: true },
          ],
          responses: { "200": { description: "OK" } },
        },
      },
    },
  };
}

function makeArmConnectionResponse(name: string, apiName: string) {
  return {
    name,
    properties: {
      displayName: `${apiName} Connection`,
      overallStatus: "Connected",
      api: {
        name: apiName,
        id: `/subscriptions/sub-123/providers/Microsoft.Web/locations/westus/managedApis/${apiName}`,
      },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("buildToolName", () => {
  it("converts SendEmail", () => {
    expect(buildToolName("testapi", "SendEmail")).toBe("testapi_send_email");
  });

  it("converts GetAllTeams", () => {
    expect(buildToolName("testapi", "GetAllTeams")).toBe("testapi_get_all_teams");
  });

  it("converts V4CalendarPostItem", () => {
    expect(buildToolName("testapi", "V4CalendarPostItem")).toBe("testapi_v4_calendar_post_item");
  });

  it("converts GetMessage", () => {
    expect(buildToolName("testapi", "GetMessage")).toBe("testapi_get_message");
  });
});

describe("buildToolDescription", () => {
  it("returns description without warning when Connected", () => {
    const conn = makeConnection({ status: "Connected" });
    const op = makeOperation({ summary: "Send an email" });
    const desc = buildToolDescription(conn, op);
    expect(desc).toBe("[Office 365 Outlook] Send an email");
    expect(desc).not.toContain("⚠️");
  });

  it("appends warning when not Connected", () => {
    const conn = makeConnection({ status: "Unauthenticated" });
    const op = makeOperation({ summary: "Send an email" });
    const desc = buildToolDescription(conn, op);
    expect(desc).toContain("[Office 365 Outlook] Send an email");
    expect(desc).toContain("⚠️ Connection not authenticated");
  });

  it("falls back to description when no summary", () => {
    const conn = makeConnection();
    const op = makeOperation({ summary: "", description: "Sends a message" });
    const desc = buildToolDescription(conn, op);
    expect(desc).toBe("[Office 365 Outlook] Sends a message");
  });
});

describe("fetchApiSchema", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSchemaCache();
  });

  it("returns swagger from result.properties.swagger", async () => {
    const swagger = makeSwagger();
    const armResponse = { properties: { swagger } };
    mockArmRequest.mockResolvedValue(armResponse);

    const result = await fetchApiSchema("office365", armContext, "test-token", "TestAgent/1.0");
    expect(result).toEqual(armResponse);
    expect(mockArmRequest).toHaveBeenCalledWith(
      "GET",
      "/subscriptions/sub-123/providers/Microsoft.Web/locations/westus/managedApis/office365",
      "test-token",
      { query: { export: "true" }, userAgent: "TestAgent/1.0" },
    );
  });

  it("caches on second call", async () => {
    const swagger = makeSwagger();
    const armResponse = { properties: { swagger } };
    mockArmRequest.mockResolvedValue(armResponse);

    await fetchApiSchema("office365", armContext, "test-token", "TestAgent/1.0");
    const result2 = await fetchApiSchema("office365", armContext, "test-token", "TestAgent/1.0");

    expect(result2).toEqual(armResponse);
    expect(mockArmRequest).toHaveBeenCalledTimes(1);
  });

  it("returns null if no swagger", async () => {
    mockArmRequest.mockResolvedValue(null);

    const result = await fetchApiSchema("noschema", armContext, "test-token", "TestAgent/1.0");
    expect(result).toBeNull();
  });
});

describe("registerDynamicTools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSchemaCache();
    clearToolRegistry();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
  });

  it("registers tools from connections", async () => {
    const swagger = makeSwagger();
    mockArmRequest
      .mockResolvedValueOnce({
        value: [
          makeArmConnectionResponse("office365", "office365"),
          makeArmConnectionResponse("teams-conn", "teams"),
        ],
      })
      // schema fetch for office365
      .mockResolvedValueOnce(swagger)
      // schema fetch for teams
      .mockResolvedValueOnce(swagger);

    const stats = await registerDynamicTools(
      mockServer as any,
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(stats.registered).toBe(4); // 2 ops x 2 connections
    expect(stats.errors).toBe(0);
    expect(getToolRegistry().size).toBe(4);
    expect(toolHandlers["office365_send_email"]).toBeDefined();
    expect(toolHandlers["office365_get_message"]).toBeDefined();
    expect(toolHandlers["teams_send_email"]).toBeDefined();
    expect(toolHandlers["teams_get_message"]).toBeDefined();
  });

  it("returns 0 registered for empty connections", async () => {
    mockArmRequest.mockResolvedValueOnce({ value: [] });

    const stats = await registerDynamicTools(
      mockServer as any,
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(stats.registered).toBe(0);
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("logs error and continues on schema fetch failure", async () => {
    mockArmRequest
      .mockResolvedValueOnce({
        value: [
          makeArmConnectionResponse("conn1", "badapi"),
          makeArmConnectionResponse("conn2", "goodapi"),
        ],
      })
      // schema fetch for badapi fails
      .mockRejectedValueOnce(new Error("schema fetch failed"))
      // schema fetch for goodapi succeeds
      .mockResolvedValueOnce(makeSwagger());

    const stats = await registerDynamicTools(
      mockServer as any,
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(stats.errors).toBe(1);
    expect(stats.registered).toBe(2); // 2 ops from goodapi
  });
});

describe("invokeDynamicTool", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("builds correct dynamicInvoke body for GET", async () => {
    const conn = makeConnection();
    const op = makeOperation({
      operationId: "GetMessage",
      method: "get",
      path: "/{connectionId}/v2/Mail/{messageId}",
      parameters: [
        { name: "connectionId", in: "path", type: "string", required: true, description: "" },
        { name: "messageId", in: "path", type: "string", required: true, description: "" },
      ],
    });

    mockArmRequest.mockResolvedValue({ response: { body: { id: "msg-1" } } });

    const result = await invokeDynamicTool(
      conn,
      op,
      { messageId: "msg-1" },
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(mockArmRequest).toHaveBeenCalledWith(
      "POST",
      "/subscriptions/sub-123/resourceGroups/rg-test/providers/Microsoft.Web/connections/office365/dynamicInvoke",
      "test-token",
      {
        body: {
          request: {
            method: "GET",
            path: "/v2/Mail/msg-1",
          },
        },
        userAgent: "TestAgent/1.0",
      },
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ id: "msg-1" });
    expect(result.isError).toBeUndefined();
  });

  it("includes body for POST operations", async () => {
    const conn = makeConnection();
    const op = makeOperation({
      operationId: "SendEmail",
      method: "post",
      path: "/{connectionId}/v2/Mail",
      parameters: [
        { name: "connectionId", in: "path", type: "string", required: true, description: "" },
      ],
      requestBody: {
        required: true,
        schema: {},
        requiredFields: ["Subject"],
        properties: {
          Subject: { name: "Subject", type: "string", description: "Email subject", required: true, visibility: "none" },
          Body: { name: "Body", type: "string", description: "Email body", required: false, visibility: "none" },
        },
      },
    });

    mockArmRequest.mockResolvedValue({ response: { body: { status: "sent" } } });

    const result = await invokeDynamicTool(
      conn,
      op,
      { Subject: "Hello", Body: "World" },
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    const callArgs = mockArmRequest.mock.calls[0];
    expect(callArgs[3].body.request.body).toEqual({ Subject: "Hello", Body: "World" });
    expect(result.isError).toBeUndefined();
  });

  it("collects query parameters", async () => {
    const conn = makeConnection();
    const op = makeOperation({
      operationId: "SearchMail",
      method: "get",
      path: "/{connectionId}/v2/Mail",
      parameters: [
        { name: "connectionId", in: "path", type: "string", required: true, description: "" },
        { name: "$filter", in: "query", type: "string", required: false, description: "" },
        { name: "$top", in: "query", type: "string", required: false, description: "" },
      ],
    });

    mockArmRequest.mockResolvedValue({ response: { body: [] } });

    await invokeDynamicTool(
      conn,
      op,
      { _filter: "isRead eq false", _top: "10" },
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    const callArgs = mockArmRequest.mock.calls[0];
    expect(callArgs[3].body.request.queries).toEqual({
      $filter: "isRead eq false",
      $top: "10",
    });
  });

  it("returns isError on failure", async () => {
    const conn = makeConnection();
    const op = makeOperation();

    mockArmRequest.mockRejectedValue(new Error("invoke failed"));

    const result = await invokeDynamicTool(
      conn,
      op,
      {},
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Error invoking");
    expect(result.content[0].text).toContain("invoke failed");
  });

  it("substitutes path parameters correctly", async () => {
    const conn = makeConnection();
    const op = makeOperation({
      operationId: "GetEvent",
      method: "get",
      path: "/{connectionId}/calendars/{calendarId}/events/{eventId}",
      parameters: [
        { name: "connectionId", in: "path", type: "string", required: true, description: "" },
        { name: "calendarId", in: "path", type: "string", required: true, description: "" },
        { name: "eventId", in: "path", type: "string", required: true, description: "" },
      ],
    });

    mockArmRequest.mockResolvedValue({ response: { body: {} } });

    await invokeDynamicTool(
      conn,
      op,
      { calendarId: "cal-1", eventId: "evt-2" },
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    const callArgs = mockArmRequest.mock.calls[0];
    expect(callArgs[3].body.request.path).toBe("/calendars/cal-1/events/evt-2");
  });
});

describe("registerToolsForConnection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSchemaCache();
    clearToolRegistry();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
  });

  it("registers tools for a new connection", async () => {
    const connResponse = makeArmConnectionResponse("office365", "office365");
    mockArmRequest.mockResolvedValueOnce(makeSwagger());

    const stats = await registerToolsForConnection(
      mockServer as any,
      connResponse,
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(stats.registered).toBe(2);
    expect(stats.errors).toBe(0);
    expect(toolHandlers["office365_send_email"]).toBeDefined();
    expect(toolHandlers["office365_get_message"]).toBeDefined();
    expect(mockServer.server.sendNotification).toHaveBeenCalledWith("notifications/tools/list_changed");
  });

  it("skips if API tools already registered", async () => {
    // Pre-populate registry with an existing tool for this apiName
    const conn = makeConnection();
    const op = makeOperation();
    getToolRegistry().set("office365_send_email", { connection: conn, operation: op });

    const connResponse = makeArmConnectionResponse("office365", "office365");

    const stats = await registerToolsForConnection(
      mockServer as any,
      connResponse,
      tokenProvider,
      armContext,
      userAgentProvider,
    );

    expect(stats.registered).toBe(0);
    expect(mockArmRequest).not.toHaveBeenCalled();
    expect(mockServer.server.sendNotification).not.toHaveBeenCalled();
  });
});
