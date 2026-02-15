import { z, ZodTypeAny } from "zod";
import type { ParsedOperation, ParsedParameter, ParsedBodyProperty } from "../schema/openApiParser.js";

/**
 * Sanitize a parameter name to match the MCP/Claude tool input schema
 * requirement: ^[a-zA-Z0-9_.-]{1,64}$
 *
 * Common offenders from connector OpenAPI specs:
 *   $filter → _filter, $top → _top, $orderby → _orderby
 *   x-ms-foo → x_ms_foo (hyphens are allowed by the pattern but kept consistent)
 */
export function sanitizeKey(name: string): string {
  // Replace characters not matching [a-zA-Z0-9_.-] with underscores
  let safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  // Strip leading dots/hyphens (must start with alnum or underscore)
  safe = safe.replace(/^[.-]+/, "");
  // Collapse consecutive underscores
  safe = safe.replace(/_+/g, "_");
  // Truncate to 64 characters
  safe = safe.slice(0, 64);
  // Fallback if empty after sanitization
  if (!safe) safe = "param";
  return safe;
}

function zodForParam(param: ParsedParameter): ZodTypeAny {
  let schema: ZodTypeAny;

  switch (param.type) {
    case "integer":
      schema = z.number().int();
      if (param.default !== undefined) schema = (schema as ReturnType<typeof z.number>).default(param.default as number);
      break;
    case "boolean":
      schema = z.boolean();
      if (param.default !== undefined) schema = (schema as ReturnType<typeof z.boolean>).default(param.default as boolean);
      break;
    case "array":
      schema = z.array(z.string());
      break;
    default:
      if (param.enum && param.enum.length > 0) {
        schema = z.enum(param.enum as [string, ...string[]]);
      } else {
        schema = z.string();
      }
      if (param.default !== undefined) schema = (schema as any).default(param.default);
      break;
  }

  if (!param.required) schema = schema.optional();
  if (param.description) schema = schema.describe(param.description);

  return schema;
}

function zodForBodyProp(prop: ParsedBodyProperty): ZodTypeAny {
  let schema: ZodTypeAny;

  switch (prop.type) {
    case "integer":
    case "number":
      schema = z.number();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "array":
      schema = z.array(z.unknown());
      break;
    case "object":
    case "string (JSON)":
      schema = z.record(z.string(), z.unknown());
      break;
    default:
      if (prop.enum && prop.enum.length > 0) {
        schema = z.enum(prop.enum as [string, ...string[]]);
        if (prop.default !== undefined) schema = (schema as any).default(prop.default);
      } else {
        schema = z.string();
        if (prop.default !== undefined) schema = (schema as any).default(prop.default);
      }
      break;
  }

  if (!prop.required) schema = schema.optional();
  if (prop.description) schema = schema.describe(prop.description);

  return schema;
}

export function generateZodSchema(op: ParsedOperation): Record<string, ZodTypeAny> {
  const result: Record<string, ZodTypeAny> = {};

  // Path & query parameters (skip connectionId)
  for (const param of op.parameters) {
    if (param.name === "connectionId") continue;
    const key = sanitizeKey(param.name);
    result[key] = zodForParam(param);
  }

  // Request body — flatten top-level properties
  if (op.requestBody) {
    for (const [name, prop] of Object.entries(op.requestBody.properties)) {
      if (prop.format === "binary") continue;
      const sanitized = sanitizeKey(name);
      const key = sanitized in result ? `body_${sanitized}` : sanitized;
      result[key] = zodForBodyProp(prop);
    }
  }

  return result;
}
