import { z } from "zod";
import { generateZodSchema } from "../../src/schema/zodGenerator";
import type { ParsedOperation } from "../../src/schema/openApiParser";

function makeOp(overrides: Partial<ParsedOperation> = {}): ParsedOperation {
  return {
    operationId: "TestOp",
    method: "get",
    path: "/test",
    summary: "",
    description: "",
    deprecated: false,
    visibility: "none",
    isTrigger: false,
    parameters: [],
    ...overrides,
  };
}

describe("generateZodSchema", () => {
  it("handles GET with query params: int with default, string, enum", () => {
    const op = makeOp({
      parameters: [
        { name: "top", in: "query", type: "integer", required: false, description: "", default: 10 },
        { name: "filter", in: "query", type: "string", required: true, description: "OData filter" },
        { name: "status", in: "query", type: "string", required: false, description: "", enum: ["active", "inactive"] },
      ],
    });

    const schema = generateZodSchema(op);

    expect(Object.keys(schema)).toEqual(["top", "filter", "status"]);

    // int with default
    const topParsed = z.object({ top: schema["top"] }).parse({});
    expect(topParsed.top).toBe(10);

    // required string
    expect(() => z.object({ filter: schema["filter"] }).parse({})).toThrow();
    expect(z.object({ filter: schema["filter"] }).parse({ filter: "x" })).toEqual({ filter: "x" });

    // enum optional
    expect(z.object({ status: schema["status"] }).parse({})).toEqual({});
    expect(z.object({ status: schema["status"] }).parse({ status: "active" })).toEqual({ status: "active" });
    expect(() => z.object({ status: schema["status"] }).parse({ status: "bad" })).toThrow();
  });

  it("handles POST with body properties: required/optional string, enum with default, array, object", () => {
    const op = makeOp({
      method: "post",
      requestBody: {
        required: true,
        schema: {},
        requiredFields: ["to", "subject"],
        properties: {
          to: { name: "to", type: "string", description: "Recipient", required: true, visibility: "none" },
          body: { name: "body", type: "string", description: "", required: false, visibility: "none" },
          importance: {
            name: "importance",
            type: "string",
            description: "",
            required: false,
            visibility: "none",
            enum: ["Low", "Normal", "High"],
            default: "Normal",
          },
          attachments: { name: "attachments", type: "array", description: "", required: false, visibility: "none" },
          options: { name: "options", type: "object", description: "", required: false, visibility: "none" },
        },
      },
    });

    const schema = generateZodSchema(op);

    // required string
    expect(() => z.object({ to: schema["to"] }).parse({})).toThrow();

    // optional string
    expect(z.object({ body: schema["body"] }).parse({})).toEqual({});

    // enum with default
    const impParsed = z.object({ importance: schema["importance"] }).parse({});
    expect(impParsed.importance).toBe("Normal");
    expect(() => z.object({ importance: schema["importance"] }).parse({ importance: "Bad" })).toThrow();

    // array
    expect(z.object({ attachments: schema["attachments"] }).parse({ attachments: [1, "x"] })).toEqual({
      attachments: [1, "x"],
    });

    // object → record
    expect(z.object({ options: schema["options"] }).parse({ options: { a: 1 } })).toEqual({ options: { a: 1 } });
  });

  it("skips connectionId parameter", () => {
    const op = makeOp({
      parameters: [
        { name: "connectionId", in: "path", type: "string", required: true, description: "" },
        { name: "id", in: "path", type: "string", required: true, description: "" },
      ],
    });

    const schema = generateZodSchema(op);
    expect(Object.keys(schema)).toEqual(["id"]);
  });

  it("skips binary format body properties", () => {
    const op = makeOp({
      requestBody: {
        required: true,
        schema: {},
        requiredFields: ["content"],
        properties: {
          content: { name: "content", type: "string", format: "binary", description: "", required: true, visibility: "none" },
          name: { name: "name", type: "string", description: "", required: false, visibility: "none" },
        },
      },
    });

    const schema = generateZodSchema(op);
    expect(Object.keys(schema)).toEqual(["name"]);
  });

  it("prefixes body prop with body_ on name collision with param", () => {
    const op = makeOp({
      parameters: [
        { name: "filter", in: "query", type: "string", required: false, description: "" },
      ],
      requestBody: {
        required: true,
        schema: {},
        requiredFields: [],
        properties: {
          filter: { name: "filter", type: "string", description: "", required: false, visibility: "none" },
        },
      },
    });

    const schema = generateZodSchema(op);
    expect(Object.keys(schema).sort()).toEqual(["body_filter", "filter"]);
  });

  it("carries through descriptions on params and body props", () => {
    const op = makeOp({
      parameters: [
        { name: "top", in: "query", type: "integer", required: false, description: "Max items" },
      ],
      requestBody: {
        required: true,
        schema: {},
        requiredFields: [],
        properties: {
          to: { name: "to", type: "string", description: "Recipient email", required: true, visibility: "none" },
        },
      },
    });

    const schema = generateZodSchema(op);
    expect(schema["top"].description).toBe("Max items");
    expect(schema["to"].description).toBe("Recipient email");
  });

  it("returns empty schema for operation with no params and no body", () => {
    const op = makeOp();
    const schema = generateZodSchema(op);
    expect(schema).toEqual({});
  });

  it("handles boolean param with default", () => {
    const op = makeOp({
      parameters: [
        { name: "includeDeleted", in: "query", type: "boolean", required: false, description: "", default: false },
      ],
    });

    const schema = generateZodSchema(op);
    const parsed = z.object({ includeDeleted: schema["includeDeleted"] }).parse({});
    expect(parsed.includeDeleted).toBe(false);
  });

  it("handles array param", () => {
    const op = makeOp({
      parameters: [
        { name: "tags", in: "query", type: "array", required: false, description: "" },
      ],
    });

    const schema = generateZodSchema(op);
    expect(z.object({ tags: schema["tags"] }).parse({ tags: ["a", "b"] })).toEqual({ tags: ["a", "b"] });
  });

  it("handles string (JSON) body property as record", () => {
    const op = makeOp({
      requestBody: {
        required: true,
        schema: {},
        requiredFields: [],
        properties: {
          metadata: { name: "metadata", type: "string (JSON)", description: "", required: false, visibility: "none" },
        },
      },
    });

    const schema = generateZodSchema(op);
    expect(z.object({ metadata: schema["metadata"] }).parse({ metadata: { key: "val" } })).toEqual({
      metadata: { key: "val" },
    });
  });

  it("handles number body property", () => {
    const op = makeOp({
      requestBody: {
        required: true,
        schema: {},
        requiredFields: ["count"],
        properties: {
          count: { name: "count", type: "number", description: "", required: true, visibility: "none" },
        },
      },
    });

    const schema = generateZodSchema(op);
    expect(z.object({ count: schema["count"] }).parse({ count: 42 })).toEqual({ count: 42 });
    expect(() => z.object({ count: schema["count"] }).parse({ count: "nope" })).toThrow();
  });
});
