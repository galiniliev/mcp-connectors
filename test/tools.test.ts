/* eslint-disable @typescript-eslint/no-explicit-any */

const mockArmRequest = jest.fn();

jest.mock("../src/arm", () => ({
  armRequest: mockArmRequest,
}));

jest.mock("../src/logger", () => ({
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

import { configureManagedApiTools } from "../src/tools/managedApis";
import { configureConnectionTools } from "../src/tools/connections";
import { configureAllTools } from "../src/tools";

const armContext = {
  subscriptionId: "sub-123",
  resourceGroup: "rg-test",
  location: "westus",
};
const tokenProvider = jest.fn().mockResolvedValue("test-token");
const userAgentProvider = jest.fn().mockReturnValue("TestAgent/1.0");

describe("configureAllTools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
  });

  it("registers tools by calling configureManagedApiTools and configureConnectionTools", () => {
    configureAllTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
    const registeredNames = mockServer.tool.mock.calls.map((c: any[]) => c[0]);
    expect(registeredNames).toContain("list_managed_apis");
    expect(registeredNames).toContain("put_connection");
    expect(registeredNames).toContain("list_connections");
    expect(registeredNames).toContain("get_consent_link");
  });
});

describe("list_managed_apis", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
    configureManagedApiTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
  });

  it("returns managed APIs on success", async () => {
    mockArmRequest.mockResolvedValue({ value: [{ name: "office365" }] });

    const result = await toolHandlers["list_managed_apis"]({});
    expect(mockArmRequest).toHaveBeenCalledWith(
      "GET",
      `/subscriptions/sub-123/providers/Microsoft.Web/locations/westus/managedApis`,
      "test-token",
      { userAgent: "TestAgent/1.0" }
    );
    expect(result.content[0].text).toContain("office365");
    expect(result.isError).toBeUndefined();
  });

  it("uses location override when provided", async () => {
    mockArmRequest.mockResolvedValue({ value: [] });

    await toolHandlers["list_managed_apis"]({ location: "eastus" });
    expect(mockArmRequest).toHaveBeenCalledWith(
      "GET",
      `/subscriptions/sub-123/providers/Microsoft.Web/locations/eastus/managedApis`,
      "test-token",
      { userAgent: "TestAgent/1.0" }
    );
  });

  it("returns isError on failure", async () => {
    mockArmRequest.mockRejectedValue(new Error("network down"));

    const result = await toolHandlers["list_managed_apis"]({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("network down");
  });
});

describe("put_connection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
    configureConnectionTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
  });

  it("creates a connection with PUT", async () => {
    const mockResult = { id: "conn-1", name: "myconn" };
    mockArmRequest.mockResolvedValue(mockResult);

    const result = await toolHandlers["put_connection"]({
      connectionName: "myconn",
      managedApiName: "office365",
      displayName: "My Office 365",
      parameterValues: {},
    });

    expect(mockArmRequest).toHaveBeenCalledWith(
      "PUT",
      `/subscriptions/sub-123/resourceGroups/rg-test/providers/Microsoft.Web/connections/myconn`,
      "test-token",
      {
        body: {
          location: "westus",
          properties: {
            displayName: "My Office 365",
            api: {
              id: `/subscriptions/sub-123/providers/Microsoft.Web/locations/westus/managedApis/office365`,
            },
            parameterValues: {},
          },
        },
        userAgent: "TestAgent/1.0",
      }
    );
    expect(result.content[0].text).toContain("myconn");
    expect(result.isError).toBeUndefined();
  });

  it("uses custom location override", async () => {
    mockArmRequest.mockResolvedValue({});

    await toolHandlers["put_connection"]({
      connectionName: "myconn",
      managedApiName: "teams",
      displayName: "Teams",
      location: "northeurope",
    });

    const callArgs = mockArmRequest.mock.calls[0];
    expect(callArgs[3].body.location).toBe("northeurope");
    expect(callArgs[3].body.properties.api.id).toContain("northeurope");
  });

  it("returns isError on failure", async () => {
    mockArmRequest.mockRejectedValue(new Error("forbidden"));

    const result = await toolHandlers["put_connection"]({
      connectionName: "myconn",
      managedApiName: "office365",
      displayName: "My Office 365",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("forbidden");
  });
});

describe("list_connections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
    configureConnectionTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
  });

  it("returns connections on success", async () => {
    mockArmRequest.mockResolvedValue({ value: [{ name: "conn-1" }] });

    const result = await toolHandlers["list_connections"]({});
    expect(mockArmRequest).toHaveBeenCalledWith(
      "GET",
      `/subscriptions/sub-123/resourceGroups/rg-test/providers/Microsoft.Web/connections`,
      "test-token",
      { userAgent: "TestAgent/1.0" }
    );
    expect(result.content[0].text).toContain("conn-1");
    expect(result.isError).toBeUndefined();
  });

  it("returns isError on failure", async () => {
    mockArmRequest.mockRejectedValue(new Error("timeout"));

    const result = await toolHandlers["list_connections"]({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timeout");
  });
});

describe("get_consent_link", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(toolHandlers)) delete toolHandlers[key];
    configureConnectionTools(mockServer as any, tokenProvider, armContext, userAgentProvider);
  });

  it("calls POST with correct apiVersion and body", async () => {
    mockArmRequest.mockResolvedValue({ value: [{ link: "https://consent" }] });

    const result = await toolHandlers["get_consent_link"]({
      connectionName: "myconn",
      objectId: "obj-123",
    });

    expect(mockArmRequest).toHaveBeenCalledWith(
      "POST",
      `/subscriptions/sub-123/resourceGroups/rg-test/providers/Microsoft.Web/connections/myconn/listConsentLinks`,
      "test-token",
      {
        apiVersion: "2018-07-01-preview",
        body: {
          parameters: [
            {
              objectId: "obj-123",
              parameterName: "token",
              redirectUrl: "http://localhost:8080",
              tenantId: "common",
            },
          ],
        },
        userAgent: "TestAgent/1.0",
      }
    );
    expect(result.isError).toBeUndefined();
  });

  it("uses custom tenantId when provided", async () => {
    mockArmRequest.mockResolvedValue({});

    await toolHandlers["get_consent_link"]({
      connectionName: "myconn",
      objectId: "obj-123",
      tenantId: "tenant-abc",
    });

    const callArgs = mockArmRequest.mock.calls[0];
    expect(callArgs[3].body.parameters[0].tenantId).toBe("tenant-abc");
  });

  it("defaults tenantId to common", async () => {
    mockArmRequest.mockResolvedValue({});

    await toolHandlers["get_consent_link"]({
      connectionName: "myconn",
      objectId: "obj-123",
    });

    const callArgs = mockArmRequest.mock.calls[0];
    expect(callArgs[3].body.parameters[0].tenantId).toBe("common");
  });

  it("returns isError on failure", async () => {
    mockArmRequest.mockRejectedValue(new Error("auth failed"));

    const result = await toolHandlers["get_consent_link"]({
      connectionName: "myconn",
      objectId: "obj-123",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("auth failed");
  });
});
