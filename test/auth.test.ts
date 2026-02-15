// Mock dependencies before importing the module under test
const mockAcquireTokenSilent = jest.fn();
const mockAcquireTokenInteractive = jest.fn();
const MockPublicClientApplication = jest.fn().mockImplementation(() => ({
  acquireTokenSilent: mockAcquireTokenSilent,
  acquireTokenInteractive: mockAcquireTokenInteractive,
}));

jest.mock("@azure/msal-node", () => ({
  PublicClientApplication: MockPublicClientApplication,
}));

const mockChainedGetToken = jest.fn();
const MockChainedTokenCredential = jest.fn().mockImplementation(() => ({
  getToken: mockChainedGetToken,
}));
const mockDefaultGetToken = jest.fn();
const MockDefaultAzureCredential = jest.fn().mockImplementation(() => ({
  getToken: mockDefaultGetToken,
}));
const MockAzureCliCredential = jest.fn();

jest.mock("@azure/identity", () => ({
  ChainedTokenCredential: MockChainedTokenCredential,
  DefaultAzureCredential: MockDefaultAzureCredential,
  AzureCliCredential: MockAzureCliCredential,
}));

jest.mock("open", () => jest.fn());

jest.mock("../src/logger.js", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { createAuthenticator } from "../src/auth.js";

describe("createAuthenticator", () => {
  let savedArmToken: string | undefined;
  let savedAzureTokenCreds: string | undefined;

  beforeEach(() => {
    savedArmToken = process.env.ARM_MCP_AUTH_TOKEN;
    savedAzureTokenCreds = process.env.AZURE_TOKEN_CREDENTIALS;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (savedArmToken === undefined) {
      delete process.env.ARM_MCP_AUTH_TOKEN;
    } else {
      process.env.ARM_MCP_AUTH_TOKEN = savedArmToken;
    }
    if (savedAzureTokenCreds === undefined) {
      delete process.env.AZURE_TOKEN_CREDENTIALS;
    } else {
      process.env.AZURE_TOKEN_CREDENTIALS = savedAzureTokenCreds;
    }
  });

  // 1. envvar — returns token from env var when set
  it("envvar: returns token from environment variable", async () => {
    process.env.ARM_MCP_AUTH_TOKEN = "test-token-123";
    const getToken = createAuthenticator("envvar");
    const token = await getToken();
    expect(token).toBe("test-token-123");
  });

  // 2. envvar — throws when env var not set
  it("envvar: throws when ARM_MCP_AUTH_TOKEN is not set", async () => {
    delete process.env.ARM_MCP_AUTH_TOKEN;
    const getToken = createAuthenticator("envvar");
    await expect(getToken()).rejects.toThrow("ARM_MCP_AUTH_TOKEN environment variable is not set");
  });

  // 3. unknown type — throws
  it("throws for unknown auth type", () => {
    expect(() => createAuthenticator("unknown")).toThrow("Unknown authentication type: unknown");
  });

  // 4. interactive — returns a function
  it("interactive: returns a function", () => {
    const getToken = createAuthenticator("interactive");
    expect(typeof getToken).toBe("function");
  });

  // 5. azcli — sets env var and returns a function
  it("azcli: sets AZURE_TOKEN_CREDENTIALS to 'dev' and returns a function", () => {
    delete process.env.AZURE_TOKEN_CREDENTIALS;
    const getToken = createAuthenticator("azcli");
    expect(process.env.AZURE_TOKEN_CREDENTIALS).toBe("dev");
    expect(typeof getToken).toBe("function");
  });

  // 6. env — returns a function
  it("env: returns a function", () => {
    const getToken = createAuthenticator("env");
    expect(typeof getToken).toBe("function");
  });

  // 7. azcli token acquisition — mock getToken returns token
  it("azcli: acquires token via ChainedTokenCredential", async () => {
    mockChainedGetToken.mockResolvedValue({ token: "azcli-token" });
    const getToken = createAuthenticator("azcli");
    const token = await getToken();
    expect(token).toBe("azcli-token");
    expect(mockChainedGetToken).toHaveBeenCalledWith("https://management.azure.com/.default");
  });

  // 8. azcli null token — throws
  it("azcli: throws when getToken returns null", async () => {
    mockChainedGetToken.mockResolvedValue(null);
    const getToken = createAuthenticator("azcli");
    await expect(getToken()).rejects.toThrow("Failed to acquire token via Azure CLI");
  });

  // 9. env token acquisition — mock getToken returns token
  it("env: acquires token via DefaultAzureCredential", async () => {
    mockDefaultGetToken.mockResolvedValue({ token: "env-token" });
    const getToken = createAuthenticator("env");
    const token = await getToken();
    expect(token).toBe("env-token");
    expect(mockDefaultGetToken).toHaveBeenCalledWith("https://management.azure.com/.default");
  });

  // 10. env null token — throws
  it("env: throws when getToken returns null", async () => {
    mockDefaultGetToken.mockResolvedValue(null);
    const getToken = createAuthenticator("env");
    await expect(getToken()).rejects.toThrow("Failed to acquire token via DefaultAzureCredential");
  });

  // 11. interactive flow — acquireTokenInteractive called, returns token
  it("interactive: acquires token interactively", async () => {
    mockAcquireTokenInteractive.mockResolvedValue({
      accessToken: "interactive-token",
      account: { homeAccountId: "id1" },
    });
    const getToken = createAuthenticator("interactive");
    const token = await getToken();
    expect(token).toBe("interactive-token");
    expect(mockAcquireTokenInteractive).toHaveBeenCalled();
  });

  // 12. interactive with tenantId — custom authority
  it("interactive: uses custom authority with tenantId", () => {
    createAuthenticator("interactive", "my-tenant-id");
    expect(MockPublicClientApplication).toHaveBeenCalledWith({
      auth: {
        clientId: "0d50963b-7bb9-4fe7-94c7-a99af00b5136",
        authority: "https://login.microsoftonline.com/my-tenant-id",
      },
    });
  });

  // 13. interactive with zero-GUID tenantId — default authority
  it("interactive: uses default authority with zero-GUID tenantId", () => {
    createAuthenticator("interactive", "00000000-0000-0000-0000-000000000000");
    expect(MockPublicClientApplication).toHaveBeenCalledWith({
      auth: {
        clientId: "0d50963b-7bb9-4fe7-94c7-a99af00b5136",
        authority: "https://login.microsoftonline.com/common",
      },
    });
  });

  // 14. interactive silent flow — second call uses acquireTokenSilent
  it("interactive: tries silent acquisition on second call", async () => {
    const mockAccount = { homeAccountId: "id1" } as any;
    mockAcquireTokenInteractive.mockResolvedValue({
      accessToken: "first-token",
      account: mockAccount,
    });
    mockAcquireTokenSilent.mockResolvedValue({
      accessToken: "silent-token",
    });

    const getToken = createAuthenticator("interactive");

    // First call: interactive
    const token1 = await getToken();
    expect(token1).toBe("first-token");
    expect(mockAcquireTokenInteractive).toHaveBeenCalledTimes(1);
    expect(mockAcquireTokenSilent).not.toHaveBeenCalled();

    // Second call: silent
    const token2 = await getToken();
    expect(token2).toBe("silent-token");
    expect(mockAcquireTokenSilent).toHaveBeenCalledTimes(1);
    expect(mockAcquireTokenSilent).toHaveBeenCalledWith({
      scopes: ["https://management.azure.com/.default"],
      account: mockAccount,
    });
  });

  // 15. interactive returns null — throws
  it("interactive: throws when acquireTokenInteractive returns null", async () => {
    mockAcquireTokenInteractive.mockResolvedValue(null);
    const getToken = createAuthenticator("interactive");
    await expect(getToken()).rejects.toThrow("Failed to acquire token interactively");
  });
});
