import { UserAgentComposer } from "../src/useragent";

describe("UserAgentComposer", () => {
  it("constructor sets correct initial userAgent string with version", () => {
    const composer = new UserAgentComposer("1.2.3");
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.2.3 (local)");
  });

  it("userAgent getter returns the string", () => {
    const composer = new UserAgentComposer("0.0.1");
    expect(typeof composer.userAgent).toBe("string");
    expect(composer.userAgent).toContain("0.0.1");
  });

  it("appendMcpClientInfo appends client info", () => {
    const composer = new UserAgentComposer("1.0.0");
    composer.appendMcpClientInfo({ name: "TestClient", version: "2.0.0" });
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.0.0 (local) TestClient/2.0.0");
  });

  it("appendMcpClientInfo only appends once (idempotent)", () => {
    const composer = new UserAgentComposer("1.0.0");
    composer.appendMcpClientInfo({ name: "TestClient", version: "2.0.0" });
    composer.appendMcpClientInfo({ name: "AnotherClient", version: "3.0.0" });
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.0.0 (local) TestClient/2.0.0");
  });

  it("appendMcpClientInfo with undefined does nothing", () => {
    const composer = new UserAgentComposer("1.0.0");
    composer.appendMcpClientInfo(undefined);
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.0.0 (local)");
  });

  it("appendMcpClientInfo with empty name does nothing", () => {
    const composer = new UserAgentComposer("1.0.0");
    composer.appendMcpClientInfo({ name: "", version: "2.0.0" });
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.0.0 (local)");
  });

  it("appendMcpClientInfo with empty version does nothing", () => {
    const composer = new UserAgentComposer("1.0.0");
    composer.appendMcpClientInfo({ name: "TestClient", version: "" });
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.0.0 (local)");
  });

  it("appendMcpClientInfo with missing name property does nothing", () => {
    const composer = new UserAgentComposer("1.0.0");
    composer.appendMcpClientInfo({ name: undefined as unknown as string, version: "2.0.0" });
    expect(composer.userAgent).toBe("ARMConnections.MCP/1.0.0 (local)");
  });
});
