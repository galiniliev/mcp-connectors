/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock("../../src/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from "fs";
import * as path from "path";
import {
  parseOpenApiSpec,
  filterOperations,
  deduplicateByFamily,
  SwaggerDoc,
  ParsedOperation,
} from "../../src/schema/openApiParser";

const fixtureFile = path.resolve(__dirname, "..", "fixtures", "test-api-schema.json");
const swagger: SwaggerDoc = JSON.parse(fs.readFileSync(fixtureFile, "utf-8"));

describe("parseOpenApiSpec", () => {
  let ops: ParsedOperation[];

  beforeAll(() => {
    ops = parseOpenApiSpec(swagger, "testapi");
  });

  it("parses correct number of operations", () => {
    // 9 operations total in fixture: GetMessages, SendMessage, GetMessage, DeleteMessage,
    // DeleteMessageV2, GetMetadata, OnNewMessage, CreateSubscription, GetContacts, UploadFile
    expect(ops.length).toBe(10);
  });

  it("parses operationId, method, path, summary, and visibility for GetMessages", () => {
    const op = ops.find((o) => o.operationId === "GetMessages")!;
    expect(op).toBeDefined();
    expect(op.method).toBe("get");
    expect(op.path).toBe("/{connectionId}/messages");
    expect(op.summary).toBe("Get messages");
    expect(op.visibility).toBe("important");
  });

  it("parses SendMessage as post with important visibility", () => {
    const op = ops.find((o) => o.operationId === "SendMessage")!;
    expect(op).toBeDefined();
    expect(op.method).toBe("post");
    expect(op.visibility).toBe("important");
  });

  it("parses GetMessage with no visibility defaulting to 'none'", () => {
    const op = ops.find((o) => o.operationId === "GetMessage")!;
    expect(op).toBeDefined();
    expect(op.visibility).toBe("none");
  });

  it("parses GetContacts with advanced visibility", () => {
    const op = ops.find((o) => o.operationId === "GetContacts")!;
    expect(op).toBeDefined();
    expect(op.visibility).toBe("advanced");
  });

  it("marks DeleteMessage as deprecated", () => {
    const op = ops.find((o) => o.operationId === "DeleteMessage")!;
    expect(op.deprecated).toBe(true);
  });

  it("marks OnNewMessage as a trigger", () => {
    const op = ops.find((o) => o.operationId === "OnNewMessage")!;
    expect(op.isTrigger).toBe(true);
  });

  it("parses apiAnnotation for GetMessages", () => {
    const op = ops.find((o) => o.operationId === "GetMessages")!;
    expect(op.apiAnnotation).toEqual({ family: "GetMessages", revision: 1, status: "Production" });
  });

  // Parameter tests
  describe("parameters", () => {
    it("parses GetMessages parameters correctly", () => {
      const op = ops.find((o) => o.operationId === "GetMessages")!;
      expect(op.parameters.length).toBe(4);

      const connParam = op.parameters.find((p) => p.name === "connectionId")!;
      expect(connParam.in).toBe("path");
      expect(connParam.required).toBe(true);
      expect(connParam.type).toBe("string");

      const topParam = op.parameters.find((p) => p.name === "top")!;
      expect(topParam.in).toBe("query");
      expect(topParam.type).toBe("integer");
      expect(topParam.required).toBe(false);
      expect(topParam.default).toBe(10);

      const filterParam = op.parameters.find((p) => p.name === "filter")!;
      expect(filterParam.in).toBe("query");
      expect(filterParam.description).toBe("OData filter");
    });

    it("resolves $ref parameters from top-level parameters section", () => {
      const op = ops.find((o) => o.operationId === "GetMessages")!;
      const orderbyParam = op.parameters.find((p) => p.name === "$orderby")!;
      expect(orderbyParam).toBeDefined();
      expect(orderbyParam.in).toBe("query");
      expect(orderbyParam.type).toBe("string");
      expect(orderbyParam.required).toBe(false);
      expect(orderbyParam.description).toBe("OData order by expression");
    });

    it("parses enum values for GetContacts status parameter", () => {
      const op = ops.find((o) => o.operationId === "GetContacts")!;
      const statusParam = op.parameters.find((p) => p.name === "status")!;
      expect(statusParam.enum).toEqual(["active", "inactive", "all"]);
    });
  });

  // Request body tests
  describe("request body parsing", () => {
    it("parses SendMessage request body with resolved $ref", () => {
      const op = ops.find((o) => o.operationId === "SendMessage")!;
      expect(op.requestBody).toBeDefined();
      expect(op.requestBody!.required).toBe(true);
      expect(op.requestBody!.requiredFields).toEqual(["to", "subject"]);
    });

    it("parses body properties: to, subject, body, importance, attachments, options", () => {
      const op = ops.find((o) => o.operationId === "SendMessage")!;
      const props = op.requestBody!.properties;

      expect(props["to"]).toBeDefined();
      expect(props["to"].type).toBe("string");
      expect(props["to"].required).toBe(true);

      expect(props["subject"]).toBeDefined();
      expect(props["subject"].required).toBe(true);

      expect(props["body"]).toBeDefined();
      expect(props["body"].type).toBe("string");
      expect(props["body"].required).toBe(false);

      expect(props["importance"]).toBeDefined();
      expect(props["importance"].enum).toEqual(["Low", "Normal", "High"]);
      expect(props["importance"].default).toBe("Normal");

      expect(props["attachments"]).toBeDefined();
      expect(props["attachments"].type).toBe("array");

      expect(props["options"]).toBeDefined();
      // options is a nested object with properties → serialized as "string (JSON)"
      expect(props["options"].type).toBe("string (JSON)");
    });

    it("parses UploadFile request body", () => {
      const op = ops.find((o) => o.operationId === "UploadFile")!;
      expect(op.requestBody).toBeDefined();
      expect(op.requestBody!.requiredFields).toEqual(["content"]);
      expect(op.requestBody!.properties["content"].format).toBe("binary");
    });
  });

  // Response schema tests
  describe("response schema resolution", () => {
    it("resolves $ref response schema for GetMessages", () => {
      const op = ops.find((o) => o.operationId === "GetMessages")!;
      expect(op.responseSchema).toBeDefined();
      const schema = op.responseSchema as any;
      expect(schema.type).toBe("object");
      expect(schema.properties.value.type).toBe("array");
    });

    it("resolves $ref response schema for SendMessage (201)", () => {
      const op = ops.find((o) => o.operationId === "SendMessage")!;
      expect(op.responseSchema).toBeDefined();
      const schema = op.responseSchema as any;
      expect(schema.type).toBe("object");
      expect(schema.properties.id.type).toBe("string");
      expect(schema.properties.subject.type).toBe("string");
    });

    it("has no response schema for DeleteMessage (204)", () => {
      const op = ops.find((o) => o.operationId === "DeleteMessage")!;
      expect(op.responseSchema).toBeUndefined();
    });
  });
});

describe("filterOperations", () => {
  let allOps: ParsedOperation[];
  let filtered: ParsedOperation[];

  beforeAll(() => {
    allOps = parseOpenApiSpec(swagger, "testapi");
    filtered = filterOperations(allOps);
  });

  it("removes internal visibility operations (GetMetadata)", () => {
    expect(filtered.find((o) => o.operationId === "GetMetadata")).toBeUndefined();
  });

  it("removes trigger operations (OnNewMessage)", () => {
    expect(filtered.find((o) => o.operationId === "OnNewMessage")).toBeUndefined();
  });

  it("removes subscription endpoints (CreateSubscription)", () => {
    expect(filtered.find((o) => o.operationId === "CreateSubscription")).toBeUndefined();
  });

  it("keeps advanced visibility operations (GetContacts)", () => {
    expect(filtered.find((o) => o.operationId === "GetContacts")).toBeDefined();
  });

  it("keeps non-deprecated operations without family (GetMessage)", () => {
    expect(filtered.find((o) => o.operationId === "GetMessage")).toBeDefined();
  });

  it("keeps important operations (GetMessages, SendMessage)", () => {
    expect(filtered.find((o) => o.operationId === "GetMessages")).toBeDefined();
    expect(filtered.find((o) => o.operationId === "SendMessage")).toBeDefined();
  });
});

describe("deduplicateByFamily", () => {
  let allOps: ParsedOperation[];

  beforeAll(() => {
    allOps = parseOpenApiSpec(swagger, "testapi");
  });

  it("keeps revision 2 of DeleteMessage over revision 1", () => {
    const deduped = deduplicateByFamily(allOps);
    expect(deduped.find((o) => o.operationId === "DeleteMessageV2")).toBeDefined();
    expect(deduped.find((o) => o.operationId === "DeleteMessage")).toBeUndefined();
  });

  it("keeps SendMessage revision 2 (only revision)", () => {
    const deduped = deduplicateByFamily(allOps);
    expect(deduped.find((o) => o.operationId === "SendMessage")).toBeDefined();
  });

  it("keeps ops without family annotation that are not deprecated", () => {
    const deduped = deduplicateByFamily(allOps);
    expect(deduped.find((o) => o.operationId === "GetMessage")).toBeDefined();
    expect(deduped.find((o) => o.operationId === "GetContacts")).toBeDefined();
  });
});
