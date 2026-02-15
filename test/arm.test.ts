jest.mock("../src/logger.js", () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { ArmError, armRequest } from "../src/arm";

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeResponse(status: number, body?: unknown, headers?: Record<string, string>): Response {
  const ok = status >= 200 && status < 300;
  const hdrs = new Headers(headers);
  const textValue = body !== undefined ? JSON.stringify(body) : "";
  return {
    ok,
    status,
    headers: hdrs,
    text: jest.fn().mockResolvedValue(textValue),
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function makeNonJsonResponse(status: number, rawText: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: jest.fn().mockResolvedValue(rawText),
    json: jest.fn().mockRejectedValue(new SyntaxError("Unexpected token")),
  } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

// ─── ArmError ────────────────────────────────────────────────────────────────

describe("ArmError", () => {
  it("should set code, message, statusCode, and name", () => {
    const err = new ArmError("ResourceNotFound", "The resource was not found", 404);
    expect(err.code).toBe("ResourceNotFound");
    expect(err.message).toBe("The resource was not found");
    expect(err.statusCode).toBe(404);
    expect(err.name).toBe("ArmError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── Successful requests ─────────────────────────────────────────────────────

describe("armRequest — success", () => {
  it("should return parsed JSON on successful GET", async () => {
    const payload = { value: [{ id: "1", name: "conn1" }] };
    mockFetch.mockResolvedValueOnce(makeResponse(200, payload));

    const result = await armRequest("GET", "/subscriptions/sub1/test", "tok123");
    expect(result).toEqual(payload);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("should send JSON body on PUT", async () => {
    const body = { location: "westus", properties: {} };
    mockFetch.mockResolvedValueOnce(makeResponse(200, { id: "new" }));

    await armRequest("PUT", "/subscriptions/sub1/resource", "tok123", { body });

    const callArgs = mockFetch.mock.calls[0];
    const fetchOpts = callArgs[1] as RequestInit;
    expect(fetchOpts.method).toBe("PUT");
    expect(fetchOpts.body).toBe(JSON.stringify(body));
  });

  it("should send JSON body on POST", async () => {
    const body = { action: "consent" };
    mockFetch.mockResolvedValueOnce(makeResponse(200, { link: "https://example.com" }));

    await armRequest("POST", "/subscriptions/sub1/action", "tok123", { body });

    const fetchOpts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(fetchOpts.body).toBe(JSON.stringify(body));
  });

  it("should return {} when response body is empty", async () => {
    const resp = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(""),
      json: jest.fn(),
    } as unknown as Response;
    mockFetch.mockResolvedValueOnce(resp);

    const result = await armRequest("GET", "/subscriptions/sub1/empty", "tok123");
    expect(result).toEqual({});
  });
});

// ─── URL construction ────────────────────────────────────────────────────────

describe("armRequest — URL & query params", () => {
  it("should use default api-version 2016-06-01", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok");

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("api-version=2016-06-01");
  });

  it("should use custom api-version when specified", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok", {
      apiVersion: "2018-07-01-preview",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("api-version=2018-07-01-preview");
    expect(calledUrl).not.toContain("2016-06-01");
  });

  it("should append custom query params", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok", {
      query: { "$filter": "name eq 'foo'", "$top": "10" },
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("%24filter=name");
    expect(calledUrl).toContain("%24top=10");
  });
});

// ─── Headers ─────────────────────────────────────────────────────────────────

describe("armRequest — headers", () => {
  it("should set Authorization Bearer header", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "my-secret-token");

    const fetchOpts = mockFetch.mock.calls[0][1] as RequestInit;
    const headers = fetchOpts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret-token");
  });

  it("should set User-Agent when provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok", {
      userAgent: "mcp-connectors/1.0",
    });

    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("mcp-connectors/1.0");
  });

  it("should not set User-Agent when not provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok");

    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toBeUndefined();
  });

  it("should set Content-Type and correlation id", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok");

    const headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-ms-correlation-request-id"]).toBeDefined();
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe("armRequest — error handling", () => {
  it("should throw ArmError with parsed code and message on 400", async () => {
    const errorEnvelope = {
      error: { code: "InvalidParameter", message: "The parameter is invalid" },
    };
    mockFetch.mockResolvedValueOnce(makeResponse(400, errorEnvelope));

    await expect(
      armRequest("GET", "/subscriptions/sub1/bad", "tok")
    ).rejects.toMatchObject({
      name: "ArmError",
      code: "InvalidParameter",
      message: "The parameter is invalid",
      statusCode: 400,
    });
  });

  it("should throw ArmError with defaults when error body is not JSON", async () => {
    mockFetch.mockResolvedValueOnce(makeNonJsonResponse(403, "Forbidden"));

    await expect(
      armRequest("GET", "/subscriptions/sub1/forbidden", "tok")
    ).rejects.toMatchObject({
      name: "ArmError",
      code: "UnknownError",
      statusCode: 403,
    });
  });

  it("should not retry on 400", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(400, { error: { code: "Bad", message: "bad" } })
    );

    await expect(
      armRequest("GET", "/subscriptions/sub1/bad", "tok")
    ).rejects.toBeInstanceOf(ArmError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── Retry behaviour ─────────────────────────────────────────────────────────

describe("armRequest — retries", () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Math, "random").mockReturnValue(0);
    setTimeoutSpy = jest
      .spyOn(global, "setTimeout")
      .mockImplementation((cb: any) => {
        cb();
        return 0 as any;
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("should retry on 429 and succeed", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(429, undefined, { "Retry-After": "1" }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const result = await armRequest("GET", "/subscriptions/sub1/test", "tok");
    expect(result).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should retry on 500 and succeed", async () => {
    mockFetch
      .mockResolvedValueOnce(makeResponse(500, undefined))
      .mockResolvedValueOnce(makeResponse(200, { recovered: true }));

    const result = await armRequest("GET", "/subscriptions/sub1/test", "tok");
    expect(result).toEqual({ recovered: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should throw ArmError after MAX_RETRIES+1 attempts on 500", async () => {
    // 4 calls total: attempt 0,1,2,3 — all return 500
    mockFetch.mockResolvedValue(
      makeResponse(500, { error: { code: "InternalError", message: "boom" } })
    );

    await expect(
      armRequest("GET", "/subscriptions/sub1/test", "tok")
    ).rejects.toMatchObject({
      name: "ArmError",
      code: "InternalError",
      statusCode: 500,
    });

    // MAX_RETRIES is 3, so total attempts = 4
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("should retry on network error then succeed", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(makeResponse(200, { data: "ok" }));

    const result = await armRequest("GET", "/subscriptions/sub1/test", "tok");
    expect(result).toEqual({ data: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should throw last error when all retries fail with network errors", async () => {
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));

    await expect(
      armRequest("GET", "/subscriptions/sub1/test", "tok")
    ).rejects.toThrow("ETIMEDOUT");

    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

// ─── Method-specific behaviour ───────────────────────────────────────────────

describe("armRequest — method behaviour", () => {
  it("should not send body for GET even if body option is provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("GET", "/subscriptions/sub1/test", "tok", {
      body: { shouldBeIgnored: true },
    });

    const fetchOpts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(fetchOpts.body).toBeUndefined();
  });

  it("should not send body for DELETE even if body option is provided", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse(200, {}));

    await armRequest("DELETE", "/subscriptions/sub1/resource", "tok", {
      body: { shouldBeIgnored: true },
    });

    const fetchOpts = mockFetch.mock.calls[0][1] as RequestInit;
    expect(fetchOpts.method).toBe("DELETE");
    expect(fetchOpts.body).toBeUndefined();
  });

  it("should handle DELETE successfully", async () => {
    const resp = {
      ok: true,
      status: 204,
      headers: new Headers(),
      text: jest.fn().mockResolvedValue(""),
      json: jest.fn(),
    } as unknown as Response;
    mockFetch.mockResolvedValueOnce(resp);

    const result = await armRequest("DELETE", "/subscriptions/sub1/resource", "tok");
    expect(result).toEqual({});
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
