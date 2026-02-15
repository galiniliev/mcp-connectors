import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { armRequest, ArmContext } from "../arm.js";
import { parseOpenApiSpec, filterOperations, ParsedOperation } from "../schema/openApiParser.js";
import { generateZodSchema, sanitizeKey } from "../schema/zodGenerator.js";
import { logger } from "../logger.js";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface ConnectionInfo {
  name: string;
  apiName: string;
  displayName: string;
  status: string;
  apiId: string;
}

interface DynamicToolContext {
  connection: ConnectionInfo;
  operation: ParsedOperation;
}

// ── Module-level state ──────────────────────────────────────────────────

const schemaCache = new Map<string, object>();
const toolRegistry = new Map<string, DynamicToolContext>();

export function clearSchemaCache(): void {
  schemaCache.clear();
}

export function getToolRegistry(): Map<string, DynamicToolContext> {
  return toolRegistry;
}

export function clearToolRegistry(): void {
  toolRegistry.clear();
}

// ── Helpers ─────────────────────────────────────────────────────────────

export function buildToolName(apiName: string, operationId: string): string {
  const snake = operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  return `${apiName}_${snake}`;
}

export function buildToolDescription(conn: ConnectionInfo, op: ParsedOperation): string {
  const text = op.summary || op.description;
  let desc = `[${conn.displayName}] ${text}`;
  if (conn.status !== "Connected") {
    desc += " ⚠️ Connection not authenticated";
  }
  return desc;
}

// ── Schema fetching ─────────────────────────────────────────────────────

export async function fetchApiSchema(
  apiName: string,
  armContext: ArmContext,
  token: string,
  userAgent: string,
): Promise<object | null> {
  if (schemaCache.has(apiName)) {
    return schemaCache.get(apiName)!;
  }

  const path = `/subscriptions/${armContext.subscriptionId}/providers/Microsoft.Web/locations/${armContext.location}/managedApis/${apiName}`;
  logger.debug(`Fetching API schema: GET ${path}?api-version=2016-06-01&export=true`);
  const result = await armRequest<any>("GET", path, token, {
    query: { export: "true" },
    userAgent,
  });

  const swagger = result ?? null;
  if (swagger) {
    schemaCache.set(apiName, swagger);
  } else {
    logger.warn(`No embedded swagger in response for ${apiName}`, {
      hasProperties: !!result?.properties,
      hasApiDefinitions: !!result?.properties?.apiDefinitions,
      apiDefinitionUrl: result?.properties?.apiDefinitionUrl ?? null,
    });
  }
  return swagger;
}

// ── Extract ConnectionInfo from ARM response ────────────────────────────

function extractConnectionInfo(c: any): ConnectionInfo {
  return {
    name: c.name,
    apiName: c.properties.api.name,
    displayName: c.properties.displayName,
    status: c.properties.overallStatus ?? "Unknown",
    apiId: c.properties.api.id,
  };
}

// ── Register tools for a set of operations ──────────────────────────────

function registerOps(
  server: McpServer,
  conn: ConnectionInfo,
  ops: ParsedOperation[],
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): { registered: number; skipped: number } {
  let registered = 0;
  let skipped = 0;

  for (const op of ops) {
    const toolName = buildToolName(conn.apiName, op.operationId);
    if (toolRegistry.has(toolName)) {
      skipped++;
      continue;
    }

    const description = buildToolDescription(conn, op);
    const zodSchema = generateZodSchema(op);

    server.tool(toolName, description, zodSchema, async (params: Record<string, unknown>) => {
      return invokeDynamicTool(conn, op, params, tokenProvider, armContext, userAgentProvider);
    });

    toolRegistry.set(toolName, { connection: conn, operation: op });
    registered++;
  }

  return { registered, skipped };
}

// ── Startup registration ────────────────────────────────────────────────

export async function registerDynamicTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): Promise<{ registered: number; skipped: number; errors: number }> {
  let registered = 0;
  let skipped = 0;
  let errors = 0;

  const token = await tokenProvider();
  const connPath = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections`;
  const connResult = await armRequest<{ value: any[] }>("GET", connPath, token, {
    userAgent: userAgentProvider(),
  });

  const connections = connResult.value ?? [];

  for (const c of connections) {
    try {
      const conn = extractConnectionInfo(c);
      const swagger = await fetchApiSchema(conn.apiName, armContext, token, userAgentProvider());
      if (!swagger) {
        logger.warn(`No swagger for ${conn.apiName}, skipping`);
        continue;
      }

      const allOps = parseOpenApiSpec(swagger as any, conn.apiName);
      const ops = filterOperations(allOps);
      const stats = registerOps(server, conn, ops, tokenProvider, armContext, userAgentProvider);
      registered += stats.registered;
      skipped += stats.skipped;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Error registering tools for connection ${c.name}: ${msg}`);
      errors++;
    }
  }

  logger.info(`Dynamic tools: ${registered} registered, ${skipped} skipped, ${errors} errors`);
  return { registered, skipped, errors };
}

// ── Incremental registration ────────────────────────────────────────────

export async function registerToolsForConnection(
  server: McpServer,
  connectionResponse: any,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): Promise<{ registered: number; skipped: number; errors: number }> {
  try {
    const conn = extractConnectionInfo(connectionResponse);

    // Check if tools for this API are already registered
    const prefix = `${conn.apiName}_`;
    for (const key of toolRegistry.keys()) {
      if (key.startsWith(prefix)) {
        logger.info(`Tools for ${conn.apiName} already registered, skipping`);
        return { registered: 0, skipped: 0, errors: 0 };
      }
    }

    const token = await tokenProvider();
    const swagger = await fetchApiSchema(conn.apiName, armContext, token, userAgentProvider());
    if (!swagger) {
      logger.warn(`No swagger for ${conn.apiName}`);
      return { registered: 0, skipped: 0, errors: 0 };
    }

    const allOps = parseOpenApiSpec(swagger as any, conn.apiName);
    const ops = filterOperations(allOps);
    const stats = registerOps(server, conn, ops, tokenProvider, armContext, userAgentProvider);

    if (stats.registered > 0) {
      (server as any).server.sendNotification("notifications/tools/list_changed");
    }

    return { registered: stats.registered, skipped: stats.skipped, errors: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Error registering tools for connection: ${msg}`);
    return { registered: 0, skipped: 0, errors: 1 };
  }
}

// ── Dynamic invocation ──────────────────────────────────────────────────

export async function invokeDynamicTool(
  conn: ConnectionInfo,
  op: ParsedOperation,
  params: Record<string, unknown>,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): Promise<{ content: { type: "text"; text: string }[]; isError?: true }> {
  try {
    // Build invocation path: strip /{connectionId} prefix, substitute path params
    let invokePath = op.path.replace(/^\/{connectionId}/, "");

    const queries: Record<string, string> = {};

    for (const param of op.parameters) {
      if (param.name === "connectionId") continue;
      const sanitized = sanitizeKey(param.name);
      const val = params[sanitized];
      if (val === undefined) continue;

      if (param.in === "path") {
        invokePath = invokePath.replace(`{${param.name}}`, String(val));
      } else if (param.in === "query") {
        queries[param.name] = String(val);
      }
    }

    // Build body from request body properties
    let body: Record<string, unknown> | undefined;
    if (op.requestBody) {
      body = {};
      for (const [name, prop] of Object.entries(op.requestBody.properties)) {
        const sanitized = sanitizeKey(name);
        const val = params[sanitized] ?? params[`body_${sanitized}`];
        if (val === undefined) continue;

        if ((prop.type === "object" || prop.type === "string (JSON)") && typeof val === "string") {
          try {
            body[name] = JSON.parse(val);
          } catch {
            body[name] = val;
          }
        } else {
          body[name] = val;
        }
      }
    }

    const token = await tokenProvider();
    const dynamicPath = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections/${conn.name}/dynamicInvoke`;

    const request: Record<string, unknown> = {
      method: op.method.toUpperCase(),
      path: invokePath,
    };
    if (body && Object.keys(body).length > 0) {
      request.headers = { "Content-Type": "application/json" };
      request.body = body;
    }
    if (Object.keys(queries).length > 0) {
      request.queries = queries;
    }

    const result = await armRequest<any>("POST", dynamicPath, token, {
      body: { request },
      userAgent: userAgentProvider(),
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result?.response?.body ?? result) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Error invoking ${conn.apiName}/${op.operationId}: ${msg}` }],
      isError: true as const,
    };
  }
}
