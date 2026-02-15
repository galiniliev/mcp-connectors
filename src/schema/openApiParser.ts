import { logger } from "../logger.js";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface SwaggerDoc {
  swagger: string;
  info: { title: string; version: string };
  host: string;
  basePath?: string;
  paths: Record<string, Record<string, any>>;
  definitions?: Record<string, any>;
}

export interface ParsedOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  deprecated: boolean;
  visibility: string;
  isTrigger: boolean;
  apiAnnotation?: {
    family: string;
    revision: number;
    status: string;
  };
  parameters: ParsedParameter[];
  requestBody?: ParsedRequestBody;
  responseSchema?: object;
}

export interface ParsedParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  type: string;
  format?: string;
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];
  dynamicValues?: {
    operationId: string;
    valueCollection: string;
    valuePath: string;
    valueTitle: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ParsedRequestBody {
  required: boolean;
  schema: object;
  requiredFields: string[];
  properties: Record<string, ParsedBodyProperty>;
}

export interface ParsedBodyProperty {
  name: string;
  type: string;
  format?: string;
  description: string;
  required: boolean;
  visibility: string;
  enum?: string[];
  default?: unknown;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MAX_DEPTH = 2;

function resolveRef(ref: string, definitions: Record<string, any> | undefined): any {
  if (!ref || !definitions) return undefined;
  const parts = ref.replace("#/definitions/", "").split("/");
  let resolved: any = definitions;
  for (const part of parts) {
    resolved = resolved?.[part];
  }
  return resolved ? JSON.parse(JSON.stringify(resolved)) : undefined;
}

function resolveSchema(schema: any, definitions: Record<string, any> | undefined): any {
  if (!schema) return undefined;
  if (schema.$ref) {
    return resolveRef(schema.$ref, definitions);
  }
  return JSON.parse(JSON.stringify(schema));
}

function flattenBodyProperties(
  schema: any,
  definitions: Record<string, any> | undefined,
  requiredFields: string[],
  depth = 0,
): Record<string, ParsedBodyProperty> {
  const props: Record<string, ParsedBodyProperty> = {};
  if (!schema?.properties) return props;

  for (const [name, raw] of Object.entries<any>(schema.properties)) {
    let propSchema = raw;
    if (propSchema.$ref) {
      propSchema = resolveRef(propSchema.$ref, definitions) ?? propSchema;
    }

    let type = propSchema.type ?? "object";
    const format = propSchema.format;

    // Nested objects below max depth → serialize as JSON string
    if (type === "object" && depth < MAX_DEPTH && propSchema.properties) {
      type = "string (JSON)";
    }

    const prop: ParsedBodyProperty = {
      name,
      type,
      description: propSchema.description ?? "",
      required: requiredFields.includes(name),
      visibility: propSchema["x-ms-visibility"] ?? "none",
    };
    if (format) prop.format = format;
    if (propSchema.enum) prop.enum = propSchema.enum;
    if (propSchema.default !== undefined) prop.default = propSchema.default;

    props[name] = prop;
  }
  return props;
}

// ── Main parsing ────────────────────────────────────────────────────────

export function parseOpenApiSpec(swagger: SwaggerDoc, apiName: string): ParsedOperation[] {
  const operations: ParsedOperation[] = [];

  for (const [path, pathItem] of Object.entries(swagger.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const operationId: string = op.operationId ?? `${method}_${path}`;
      const visibility: string = op["x-ms-visibility"] ?? "none";
      const isTrigger: boolean = !!op["x-ms-trigger"];
      const deprecated: boolean = !!op.deprecated;

      let apiAnnotation: ParsedOperation["apiAnnotation"];
      if (op["x-ms-api-annotation"]) {
        const ann = op["x-ms-api-annotation"];
        apiAnnotation = {
          family: ann.family,
          revision: ann.revision,
          status: ann.status,
        };
      }

      // Parameters (non-body)
      const parameters: ParsedParameter[] = [];
      let requestBody: ParsedRequestBody | undefined;

      for (const param of op.parameters ?? []) {
        if (param.in === "body") {
          const schema = resolveSchema(param.schema, swagger.definitions);
          const requiredFields: string[] = schema?.required ?? [];
          requestBody = {
            required: !!param.required,
            schema,
            requiredFields,
            properties: flattenBodyProperties(schema, swagger.definitions, requiredFields),
          };
        } else {
          const p: ParsedParameter = {
            name: param.name,
            in: param.in,
            type: param.type ?? "string",
            required: !!param.required,
            description: param.description ?? "",
          };
          if (param.format) p.format = param.format;
          if (param.default !== undefined) p.default = param.default;
          if (param.enum) p.enum = param.enum;
          if (param["x-ms-dynamic-values"]) {
            const dv = param["x-ms-dynamic-values"];
            p.dynamicValues = {
              operationId: dv.operationId,
              valueCollection: dv["value-collection"],
              valuePath: dv["value-path"],
              valueTitle: dv["value-title"],
              parameters: dv.parameters,
            };
          }
          parameters.push(p);
        }
      }

      // Response schema
      let responseSchema: object | undefined;
      const resp200 = op.responses?.["200"];
      const resp201 = op.responses?.["201"];
      const respSchema = resp200?.schema ?? resp201?.schema;
      if (respSchema) {
        responseSchema = resolveSchema(respSchema, swagger.definitions);
      }

      const parsed: ParsedOperation = {
        operationId,
        method,
        path,
        summary: op.summary ?? "",
        description: op.description ?? "",
        deprecated,
        visibility,
        isTrigger,
        parameters,
      };
      if (apiAnnotation) parsed.apiAnnotation = apiAnnotation;
      if (requestBody) parsed.requestBody = requestBody;
      if (responseSchema) parsed.responseSchema = responseSchema;

      operations.push(parsed);
    }
  }

  logger.info(`Parsed ${operations.length} operations from ${apiName}`);
  return operations;
}

// ── Deduplication ───────────────────────────────────────────────────────

export function deduplicateByFamily(ops: ParsedOperation[]): ParsedOperation[] {
  const familyMap = new Map<string, ParsedOperation>();

  for (const op of ops) {
    if (op.apiAnnotation?.family) {
      const existing = familyMap.get(op.apiAnnotation.family);
      if (!existing || op.apiAnnotation.revision > existing.apiAnnotation!.revision) {
        familyMap.set(op.apiAnnotation.family, op);
      }
    }
  }

  const result: ParsedOperation[] = [];
  const familyOps = new Set(familyMap.values());

  for (const op of ops) {
    if (op.apiAnnotation?.family) {
      if (familyOps.has(op)) {
        result.push(op);
      }
    } else if (!op.deprecated) {
      result.push(op);
    }
  }

  return result;
}

// ── Filtering ───────────────────────────────────────────────────────────

export function filterOperations(ops: ParsedOperation[]): ParsedOperation[] {
  const filtered = ops.filter((op) => {
    if (op.visibility === "internal") return false;
    if (op.isTrigger) return false;
    if (op.path.includes("$subscriptions")) return false;
    return true;
  });

  return deduplicateByFamily(filtered);
}
