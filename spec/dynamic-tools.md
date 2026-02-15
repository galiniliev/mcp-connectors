# Dynamic Tools Specification: OpenAPI-to-MCP Tool Generation

> Extend the ARM Connections MCP server to **dynamically register MCP tools** from
> the OpenAPI schemas of each **connected** API in the resource group. When a user
> has an `office365` connection, the server exposes `office365_send_email`,
> `office365_get_events`, etc. — all derived at startup from the connector's
> Swagger/OpenAPI definition fetched from ARM.

---

## 1. High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ Server Startup                                                     │
│                                                                    │
│  1. list_connections (ARM)  ──►  [office365, teams, ...]           │
│  2. For each connection:                                           │
│     a. GET managedApi schema  ──► OpenAPI 2.0 spec                 │
│     b. Parse paths → operations                                    │
│     c. Filter by x-ms-visibility (!= "internal")                  │
│     d. Convert each operation → MCP tool                           │
│     e. Register via server.tool(...)                               │
│                                                                    │
│  3. Expose meta-tools: list_connections, refresh_tools, etc.       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Tool Invocation (runtime)                                          │
│                                                                    │
│  User calls:  office365_send_email({ subject, body, to })          │
│                                                                    │
│  1. Resolve connectionName from tool prefix ("office365")          │
│  2. Acquire ARM token                                              │
│  3. POST dynamicInvoke to ARM proxy endpoint                       │
│     Body: { request: { method, path, body, queries, headers } }    │
│  4. Return response as MCP text content                            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Auto-Reload on New Connection                                      │
│                                                                    │
│ User calls:  put_connection({ apiName: "slack", ... })             │
│                                                                    │
│ 1. PUT connection to ARM (existing static tool logic)              │
│ 2. On success → detect apiName from the new connection             │
│ 3. Fetch OpenAPI schema: GET managedApis/{apiName}?export=true     │
│ 4. Parse → Filter → Register new MCP tools (incremental)           │
│ 5. Emit MCP tools/list_changed notification to client              │
│ 6. Return put_connection result + count of new tools registered    │
│                                                                    │
│ Note: Only registers tools for the NEW API. Existing tools         │
│ remain untouched. No server restart required.                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Schema Acquisition

### 2.1 Endpoint

Each managed API publishes its OpenAPI (Swagger 2.0) definition via ARM:

```
GET /subscriptions/{subscriptionId}/providers/Microsoft.Web/locations/{location}/managedApis/{apiName}?api-version=2016-06-01&export=true
```

The `&export=true` query parameter returns the full schema including `paths`,
`definitions`, and Microsoft extensions (`x-ms-*`).

### 2.2 Response Shape

```jsonc
{
  "properties": {
    "name": "office365",
    "apiDefinitionUrl": "https://...",       // alternative: fetch from here
    "apiDefinitions": {
      "originalSwaggerUrl": "https://...",
      "modifiedSwaggerUrl": "https://..."
    },
    "swagger": {                             // ← embedded OpenAPI 2.0
      "swagger": "2.0",
      "info": { "title": "Office 365 Outlook", "version": "1.0" },
      "host": "logic-apis-westus.azure-apim.net",
      "basePath": "/apim/office365",
      "paths": { ... },                      // 90+ operations
      "definitions": { ... }
    },
    "connectionParameters": { ... },
    "capabilities": ["actions", "triggers"],
    "runtimeUrls": ["https://logic-apis-westus.azure-apim.net/apim/office365"]
  }
}
```

### 2.3 Caching

- Cache schemas in memory keyed by `apiName`.
- TTL: session lifetime (schemas don't change within a session).
- A `refresh_tools` meta-tool forces re-fetch.

---

## 3. OpenAPI → MCP Tool Conversion

### 3.1 Schema Parser: `src/schema/openApiParser.ts`

```typescript
export interface ParsedOperation {
  operationId: string;          // e.g. "SendEmail"
  method: string;               // "get" | "post" | "put" | "patch" | "delete"
  path: string;                 // e.g. "/{connectionId}/Mail"
  summary: string;              // human-readable
  description: string;
  deprecated: boolean;
  visibility: string;           // from x-ms-visibility: "important" | "advanced" | "internal"
  isTrigger: boolean;           // x-ms-trigger present
  apiAnnotation?: {
    family: string;
    revision: number;
    status: string;
  };
  parameters: ParsedParameter[];
  requestBody?: ParsedRequestBody;
  responseSchema?: object;      // JSON Schema from 200/201 response
}

export interface ParsedParameter {
  name: string;
  in: "path" | "query" | "header" | "body";
  type: string;                 // "string" | "integer" | "boolean" | "array" | "object"
  format?: string;              // "date-time" | "email" | "int32" | "binary"
  required: boolean;
  description: string;
  default?: unknown;
  enum?: string[];
  dynamicValues?: {             // from x-ms-dynamic-values
    operationId: string;
    valueCollection: string;
    valuePath: string;
    valueTitle: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ParsedRequestBody {
  required: boolean;
  schema: object;               // resolved JSON Schema
  requiredFields: string[];     // from schema.required
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
```

### 3.2 Parsing Rules

```typescript
export function parseOpenApiSpec(
  swagger: SwaggerDoc,
  apiName: string
): ParsedOperation[] {
  const operations: ParsedOperation[] = [];

  for (const [pathTemplate, pathItem] of Object.entries(swagger.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = pathItem[method];
      if (!op) continue;

      operations.push({
        operationId: op.operationId,
        method,
        path: pathTemplate,
        summary: op.summary ?? "",
        description: op.description ?? "",
        deprecated: op.deprecated ?? false,
        visibility: op["x-ms-visibility"] ?? "none",
        isTrigger: !!op["x-ms-trigger"],
        apiAnnotation: op["x-ms-api-annotation"],
        parameters: parseParameters(op.parameters ?? [], swagger),
        requestBody: parseRequestBody(op.parameters ?? [], swagger),
        responseSchema: parseResponseSchema(op.responses, swagger),
      });
    }
  }

  return operations;
}
```

### 3.3 Filtering Rules

Not every OpenAPI operation should become an MCP tool. Apply these filters:

| Rule | Rationale |
|------|-----------|
| **Skip** `x-ms-visibility: "internal"` | Internal plumbing (metadata endpoints, dynamic-value providers) |
| **Skip** deprecated operations unless latest revision | Prefer v3 of an operation family over v1 |
| **Skip** triggers (`x-ms-trigger` present) | MCP is request/response, not event-driven |
| **Skip** subscription endpoints (`$subscriptions`) | Webhook management, not user-facing |
| **Skip** `connectionId` parameter | Injected automatically from connection context |
| **Keep** operations with visibility `"important"`, `"advanced"`, or unset | User-facing actions |

```typescript
export function filterOperations(ops: ParsedOperation[]): ParsedOperation[] {
  // 1. Remove internal-visibility ops
  let filtered = ops.filter(op => op.visibility !== "internal");

  // 2. Remove triggers
  filtered = filtered.filter(op => !op.isTrigger);

  // 3. Remove deprecated — keep only latest revision per family
  filtered = deduplicateByFamily(filtered);

  // 4. Remove subscription management endpoints
  filtered = filtered.filter(op => !op.path.includes("$subscriptions"));

  return filtered;
}

function deduplicateByFamily(ops: ParsedOperation[]): ParsedOperation[] {
  const families = new Map<string, ParsedOperation>();

  for (const op of ops) {
    const family = op.apiAnnotation?.family ?? op.operationId;
    const revision = op.apiAnnotation?.revision ?? 1;
    const existing = families.get(family);

    if (!existing || (existing.apiAnnotation?.revision ?? 1) < revision) {
      families.set(family, op);
    }
  }

  // Also include ops without family annotation that aren't deprecated
  for (const op of ops) {
    if (!op.apiAnnotation?.family && !op.deprecated) {
      families.set(op.operationId, op);
    }
  }

  return [...families.values()];
}
```

---

## 4. Zod Schema Generation from OpenAPI

### 4.1 `src/schema/zodGenerator.ts`

Convert each `ParsedOperation`'s parameters + request body into a Zod schema for
`server.tool()` registration.

**Key:** All parameter keys must be sanitized to match the MCP/Claude tool input
schema requirement: `^[a-zA-Z0-9_.-]{1,64}$`. OpenAPI specs contain `$filter`,
`$top`, etc. which must be transformed (e.g., `$filter` → `_filter`).

```typescript
import { z, ZodTypeAny } from "zod";

/**
 * Sanitize a parameter name for MCP tool schema compatibility.
 * Replaces invalid chars with underscores, collapses runs, truncates to 64.
 * Examples: "$filter" → "_filter", "$top" → "_top"
 */
export function sanitizeKey(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  safe = safe.replace(/^[.-]+/, "");
  safe = safe.replace(/_+/g, "_");
  safe = safe.slice(0, 64);
  return safe || "param";
}

export function generateZodSchema(
  op: ParsedOperation
): Record<string, ZodTypeAny> {
  const schema: Record<string, ZodTypeAny> = {};

  // 1. Path & query parameters (skip connectionId — injected at runtime)
  for (const param of op.parameters) {
    if (param.name === "connectionId") continue;
    schema[sanitizeKey(param.name)] = paramToZod(param);
  }

  // 2. Request body — flatten top-level properties into schema
  if (op.requestBody) {
    for (const [propName, prop] of Object.entries(op.requestBody.properties)) {
      const sanitized = sanitizeKey(propName);
      const key = schema[sanitized] ? `body_${sanitized}` : sanitized;
      schema[key] = bodyPropertyToZod(prop);
    }
  }

  return schema;
}

function paramToZod(param: ParsedParameter): ZodTypeAny {
  let zodType: ZodTypeAny;

  switch (param.type) {
    case "integer":
      zodType = z.number().int();
      if (param.default !== undefined) zodType = zodType.default(param.default);
      break;
    case "boolean":
      zodType = z.boolean();
      if (param.default !== undefined) zodType = zodType.default(param.default);
      break;
    case "array":
      zodType = z.array(z.string());
      break;
    default:
      zodType = z.string();
      if (param.enum) zodType = z.enum(param.enum as [string, ...string[]]);
      if (param.default !== undefined) zodType = zodType.default(param.default);
  }

  if (!param.required) zodType = zodType.optional();
  if (param.description) zodType = zodType.describe(param.description);

  return zodType;
}

function bodyPropertyToZod(prop: ParsedBodyProperty): ZodTypeAny {
  let zodType: ZodTypeAny;

  switch (prop.type) {
    case "integer":
    case "number":
      zodType = z.number();
      break;
    case "boolean":
      zodType = z.boolean();
      break;
    case "array":
      zodType = z.array(z.unknown());
      break;
    case "object":
      zodType = z.record(z.unknown());
      break;
    default:
      zodType = z.string();
      if (prop.enum) zodType = z.enum(prop.enum as [string, ...string[]]);
  }

  if (!prop.required) zodType = zodType.optional();
  if (prop.description) zodType = zodType.describe(prop.description);

  return zodType;
}
```

### 4.2 Nested Object Handling

For complex body schemas with nested objects (e.g., `CalendarEventBackend`
with `Attendees[]`, `Location`, `Body`):

```typescript
function resolveSchemaRef(
  ref: string,
  definitions: Record<string, object>
): object {
  // "#/definitions/CalendarEventBackend" → definitions["CalendarEventBackend"]
  const defName = ref.replace("#/definitions/", "");
  return definitions[defName] ?? {};
}

function bodySchemaToFlatProperties(
  schema: object,
  definitions: Record<string, object>,
  maxDepth: number = 2
): Record<string, ParsedBodyProperty> {
  // Resolve $ref if present
  if (schema["$ref"]) {
    schema = resolveSchemaRef(schema["$ref"], definitions);
  }

  const props: Record<string, ParsedBodyProperty> = {};
  const required = new Set(schema["required"] ?? []);

  for (const [name, propSchema] of Object.entries(schema["properties"] ?? {})) {
    const resolved = propSchema["$ref"]
      ? resolveSchemaRef(propSchema["$ref"], definitions)
      : propSchema;

    // For nested objects at depth < maxDepth, serialize as JSON string param
    if (resolved["type"] === "object" && maxDepth > 0) {
      props[name] = {
        name,
        type: "string",  // Accept as JSON string
        description: `${resolved["description"] ?? name} (JSON object)`,
        required: required.has(name),
        visibility: resolved["x-ms-visibility"] ?? "none",
      };
    } else {
      props[name] = {
        name,
        type: resolved["type"] ?? "string",
        format: resolved["format"],
        description: resolved["x-ms-summary"] ?? resolved["description"] ?? "",
        required: required.has(name),
        visibility: resolved["x-ms-visibility"] ?? "none",
        enum: resolved["enum"],
        default: resolved["default"],
      };
    }
  }

  return props;
}
```

---

## 5. Dynamic Tool Registration

### 5.1 `src/tools/dynamicTools.ts`

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArmContext, armRequest } from "../arm.js";
import { parseOpenApiSpec, filterOperations } from "../schema/openApiParser.js";
import { generateZodSchema } from "../schema/zodGenerator.js";
import { logger } from "../logger.js";

interface ConnectionInfo {
  name: string;                    // e.g. "office365"
  apiName: string;                 // e.g. "office365"
  displayName: string;             // e.g. "Office 365 Outlook"
  status: string;                  // "Connected" | "Error"
  apiId: string;                   // full ARM resource ID of managedApi
}

interface DynamicToolContext {
  connection: ConnectionInfo;
  operation: ParsedOperation;
}

// In-memory registry for runtime dispatch
const toolRegistry = new Map<string, DynamicToolContext>();

export async function registerDynamicTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): Promise<{ registered: number; skipped: number; errors: string[] }> {
  const stats = { registered: 0, skipped: 0, errors: [] as string[] };

  // Step 1: List connections in the resource group
  const token = await tokenProvider();
  const connectionsPath =
    `/subscriptions/${armContext.subscriptionId}` +
    `/resourceGroups/${armContext.resourceGroup}` +
    `/providers/Microsoft.Web/connections`;

  const connectionsResp = await armRequest<{ value: any[] }>(
    "GET", connectionsPath, token,
    { userAgent: userAgentProvider() }
  );

  const connections: ConnectionInfo[] = connectionsResp.value.map((c) => ({
    name: c.name,
    apiName: c.properties.api.name,
    displayName: c.properties.displayName,
    status: c.properties.overallStatus ?? "Unknown",
    apiId: c.properties.api.id,
  }));

  logger.info(`Found ${connections.length} connections`, {
    connections: connections.map(c => `${c.name} (${c.status})`),
  });

  // Step 2: For each connection, fetch schema and register tools
  for (const conn of connections) {
    try {
      // Only register tools for Connected connections
      // (Unauthenticated connections are still useful — user may consent later)
      const swagger = await fetchApiSchema(
        conn.apiName, armContext, token, userAgentProvider()
      );

      if (!swagger) {
        stats.errors.push(`${conn.apiName}: no swagger schema returned`);
        continue;
      }

      const allOps = parseOpenApiSpec(swagger, conn.apiName);
      const filteredOps = filterOperations(allOps);

      logger.info(`${conn.apiName}: ${allOps.length} total ops, ${filteredOps.length} after filtering`);

      for (const op of filteredOps) {
        const toolName = buildToolName(conn.apiName, op.operationId);
        const zodSchema = generateZodSchema(op);
        const description = buildToolDescription(conn, op);

        try {
          server.tool(toolName, description, zodSchema, async (params) => {
            return await invokeDynamicTool(
              conn, op, params, tokenProvider, armContext, userAgentProvider
            );
          });

          toolRegistry.set(toolName, { connection: conn, operation: op });
          stats.registered++;
        } catch (regError) {
          // Tool name collision or registration failure
          stats.errors.push(`${toolName}: ${regError}`);
          stats.skipped++;
        }
      }
    } catch (fetchError) {
      stats.errors.push(`${conn.apiName}: schema fetch failed — ${fetchError}`);
    }
  }

  logger.info("Dynamic tool registration complete", stats);
  return stats;
}
```

### 5.2 Incremental Registration for a Single Connection

When `put_connection` creates a new connection, call this function to register
tools for just the new API without touching existing tools. This avoids
re-fetching schemas for already-registered APIs.

```typescript
export async function registerToolsForConnection(
  server: McpServer,
  connectionResponse: any,             // ARM PUT response
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): Promise<{ registered: number; skipped: number; errors: string[] }> {
  const stats = { registered: 0, skipped: 0, errors: [] as string[] };

  // Extract connection info from the PUT response
  const conn: ConnectionInfo = {
    name: connectionResponse.name,
    apiName: connectionResponse.properties.api.name,
    displayName: connectionResponse.properties.displayName,
    status: connectionResponse.properties.overallStatus ?? "Unknown",
    apiId: connectionResponse.properties.api.id,
  };

  // Skip if this API's tools are already registered
  const prefix = `${conn.apiName}_`;
  const alreadyRegistered = Array.from(toolRegistry.keys()).some(k => k.startsWith(prefix));
  if (alreadyRegistered) {
    logger.info(`Tools for ${conn.apiName} already registered, skipping`);
    return stats;
  }

  // Fetch schema and register tools (same logic as startup)
  const token = await tokenProvider();
  try {
    const swagger = await fetchApiSchema(
      conn.apiName, armContext, token, userAgentProvider()
    );

    if (!swagger) {
      stats.errors.push(`${conn.apiName}: no swagger schema returned`);
      return stats;
    }

    const allOps = parseOpenApiSpec(swagger, conn.apiName);
    const filteredOps = filterOperations(allOps);

    logger.info(`${conn.apiName}: ${allOps.length} total ops, ${filteredOps.length} after filtering`);

    for (const op of filteredOps) {
      const toolName = buildToolName(conn.apiName, op.operationId);
      const zodSchema = generateZodSchema(op);
      const description = buildToolDescription(conn, op);

      try {
        server.tool(toolName, description, zodSchema, async (params) => {
          return await invokeDynamicTool(
            conn, op, params, tokenProvider, armContext, userAgentProvider
          );
        });

        toolRegistry.set(toolName, { connection: conn, operation: op });
        stats.registered++;
      } catch (regError) {
        stats.errors.push(`${toolName}: ${regError}`);
        stats.skipped++;
      }
    }
  } catch (fetchError) {
    stats.errors.push(`${conn.apiName}: schema fetch failed — ${fetchError}`);
  }

  // Notify MCP client that the tool list has changed
  if (stats.registered > 0) {
    await server.sendToolListChanged();
    logger.info(`Notified client: ${stats.registered} new tools for ${conn.apiName}`);
  }

  logger.info(`Incremental registration for ${conn.apiName} complete`, stats);
  return stats;
}
```

> **`server.sendToolListChanged()`** — The MCP SDK provides this method to emit
> a `notifications/tools/list_changed` notification. Clients that support dynamic
> tool lists (e.g., VS Code Copilot) will re-fetch the tool list automatically.
> The server must declare `capabilities: { tools: { listChanged: true } }` at
> initialization (see §9).

### 5.3 Schema Fetching

```typescript
const schemaCache = new Map<string, object>();

async function fetchApiSchema(
  apiName: string,
  armContext: ArmContext,
  token: string,
  userAgent: string,
): Promise<object | null> {
  if (schemaCache.has(apiName)) return schemaCache.get(apiName)!;

  const path =
    `/subscriptions/${armContext.subscriptionId}` +
    `/providers/Microsoft.Web/locations/${armContext.location}` +
    `/managedApis/${apiName}`;

  const result = await armRequest<any>("GET", path, token, {
    query: { export: "true" },
    userAgent,
  });

  const swagger = result.properties?.swagger ?? null;
  if (swagger) schemaCache.set(apiName, swagger);
  return swagger;
}
```

### 5.4 Tool Naming Convention

```typescript
function buildToolName(apiName: string, operationId: string): string {
  // Convert operationId to snake_case, prefix with API name
  // "SendEmail" → "office365_send_email"
  // "GetAllTeams" → "teams_get_all_teams"
  const snakeOp = operationId
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  return `${apiName}_${snakeOp}`;
}

function buildToolDescription(conn: ConnectionInfo, op: ParsedOperation): string {
  const status = conn.status === "Connected" ? "" : " ⚠️ Connection not authenticated";
  return `[${conn.displayName}] ${op.summary || op.description}${status}`;
}
```

### 5.5 Example: Generated Tools for Office 365

Given the Office 365 OpenAPI spec with ~90 operations, after filtering:

| Generated Tool Name | Source operationId | Summary |
|---------------------|-------------------|---------|
| `office365_send_email` | SendEmailV2 | Send an email (v2) |
| `office365_get_email` | GetEmailV2 | Get email by ID |
| `office365_get_emails` | GetEmailsV3 | Get emails with filters |
| `office365_reply_to_email` | ReplyToV3 | Reply to an email (v3) |
| `office365_move_email` | MoveV2 | Move an email |
| `office365_mark_as_read` | MarkAsReadV3 | Mark as read/unread |
| `office365_delete_email` | DeleteEmailV2 | Delete an email |
| `office365_export_email` | ExportEmailV2 | Export email as .eml |
| `office365_get_calendars` | CalendarGetTablesV2 | List calendars |
| `office365_create_event` | V4CalendarPostItem | Create calendar event |
| `office365_update_event` | V4CalendarPatchItem | Update calendar event |
| `office365_get_events` | CalendarGetItemsV3 | Get events from calendar |
| `office365_respond_to_event` | RespondToEventV2 | Accept/decline event |
| `office365_get_contacts` | GetContactsV2 | List contacts |
| `office365_create_contact` | ContactPostItemV2 | Create a contact |
| `office365_get_rooms` | FindRoomsV2 | Find meeting rooms |
| `office365_get_room_lists` | GetRoomListsV2 | Get room lists |
| `office365_set_auto_reply` | SetAutomaticRepliesSetting | Set automatic replies |
| `office365_send_approval_email` | SendApprovalEmail | Send actionable email |

### 5.6 Example: Generated Tools for Teams

| Generated Tool Name | Source operationId | Summary |
|---------------------|-------------------|---------|
| `teams_create_meeting` | CreateTeamsMeeting | Create a Teams meeting |
| `teams_list_joined_teams` | GetAllTeams | List joined teams |
| `teams_list_channels` | GetChannelsForGroup | List channels in a team |
| `teams_create_channel` | CreateChannel | Create a channel |
| `teams_get_channel` | GetChannel | Get channel details |
| `teams_post_message` | PostMessageToConversation | Post message to channel |
| `teams_post_reply` | PostReplyToConversation | Reply to a message |
| `teams_get_messages` | GetMessagesFromChannel | Get channel messages |
| `teams_get_message` | GetMessage | Get a specific message |
| `teams_create_chat` | CreateChat | Create a 1:1 or group chat |
| `teams_post_chat_message` | PostMessageToChat | Send chat message |
| `teams_list_chat_members` | GetMembersInChat | List members of a chat |
| `teams_list_members` | GetMembersOfATeam | List team members |
| `teams_create_team` | CreateATeam | Create a new team |
| `teams_get_team` | GetATeam | Get team details |
| `teams_list_tags` | ListTags | List team tags |
| `teams_get_shifts` | GetAllShifts | Get shift schedule |

---

## 6. Runtime Invocation via `dynamicInvoke`

When a dynamically registered tool is called, the server proxies the request
through ARM's `dynamicInvoke` endpoint — this is how Logic Apps / Power Automate
execute connector operations at runtime.

### 6.1 Endpoint

```
POST /subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}/providers/Microsoft.Web/connections/{connectionName}/dynamicInvoke?api-version=2016-06-01
```

### 6.2 Request Body

```jsonc
{
  "request": {
    "method": "GET",              // from operation's HTTP method
    "path": "/Mail",              // from operation's path (without connectionId prefix)
    "body": { ... },              // from request body params (if POST/PUT/PATCH)
    "queries": { ... },           // from query params
    "headers": {
      "Content-Type": "application/json"
    }
  }
}
```

### 6.3 Implementation

```typescript
async function invokeDynamicTool(
  conn: ConnectionInfo,
  op: ParsedOperation,
  params: Record<string, unknown>,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  try {
    const token = await tokenProvider();

    // 1. Build the invocation path — strip {connectionId} prefix
    let invocationPath = op.path.replace(/^\/{connectionId}/, "");

    // 2. Substitute path parameters (sanitized key for lookup, original for ARM)
    for (const param of op.parameters.filter(p => p.in === "path")) {
      if (param.name === "connectionId") continue;
      const value = params[sanitizeKey(param.name)];
      if (value !== undefined) {
        invocationPath = invocationPath.replace(`{${param.name}}`, String(value));
      }
    }

    // 3. Collect query parameters (sanitized key for lookup, original for ARM)
    const queries: Record<string, string> = {};
    for (const param of op.parameters.filter(p => p.in === "query")) {
      const val = params[sanitizeKey(param.name)];
      if (val !== undefined) {
        queries[param.name] = String(val);
      }
    }

    // 4. Build request body from remaining params
    let body: Record<string, unknown> | undefined;
    if (op.requestBody && ["post", "put", "patch"].includes(op.method)) {
      body = {};
      for (const [propName, prop] of Object.entries(op.requestBody.properties)) {
        const sanitized = sanitizeKey(propName);
        const paramKey = params[sanitized] !== undefined ? sanitized : `body_${sanitized}`;
        if (params[paramKey] !== undefined) {
          // Parse JSON strings for object-type params
          let value = params[paramKey];
          if (prop.type === "object" && typeof value === "string") {
            try { value = JSON.parse(value as string); } catch { /* keep as string */ }
          }
          body[propName] = value;
        }
      }
    }

    // 5. POST to dynamicInvoke
    const invokePath =
      `/subscriptions/${armContext.subscriptionId}` +
      `/resourceGroups/${armContext.resourceGroup}` +
      `/providers/Microsoft.Web/connections/${conn.name}` +
      `/dynamicInvoke`;

    const invokeBody = {
      request: {
        method: op.method.toUpperCase(),
        path: invocationPath,
        ...(body && Object.keys(body).length > 0 ? { body } : {}),
        ...(Object.keys(queries).length > 0 ? { queries } : {}),
        headers: { "Content-Type": "application/json" },
      },
    };

    const result = await armRequest<any>("POST", invokePath, token, {
      body: invokeBody,
      userAgent: userAgentProvider(),
    });

    // 6. Format response
    const responseBody = result.response?.body ?? result;
    const text = typeof responseBody === "string"
      ? responseBody
      : JSON.stringify(responseBody, null, 2);

    return { content: [{ type: "text", text }] };

  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text", text: `Error invoking ${conn.apiName}.${op.operationId}: ${msg}` }],
      isError: true,
    };
  }
}
```

---

## 7. Connection Status Handling

### 7.1 Status Matrix

| Connection Status | Tool Registration | Tool Invocation |
|-------------------|-------------------|-----------------|
| **Connected** | ✅ Register all tools | ✅ Works normally |
| **Error (Unauthenticated)** | ✅ Register all tools | ⚠️ Returns auth error with consent link hint |
| **Disabled** | ❌ Skip | — |

### 7.2 Unauthenticated Connection Handling

When a tool for an unauthenticated connection is invoked, the dynamicInvoke call
will fail. The handler should:

1. Catch the auth error
2. Auto-call `get_consent_link` for the connection
3. Return a helpful message with the consent URL

```typescript
// In invokeDynamicTool error handler:
if (isAuthError(error) && conn.status !== "Connected") {
  try {
    const consentUrl = await getConsentLinkForConnection(
      conn.name, tokenProvider, armContext, userAgentProvider
    );
    return {
      content: [{
        type: "text",
        text: `Connection "${conn.name}" is not authenticated.\n\n` +
              `Please open this URL to consent:\n${consentUrl}\n\n` +
              `After consenting, retry this tool call.`,
      }],
      isError: true,
    };
  } catch { /* fall through to generic error */ }
}
```

---

## 8. Updated Package Layout

```
mcp-connections/
├── src/
│   ├── index.ts                    # CLI entry-point
│   ├── auth.ts                     # MSAL/Azure-Identity auth
│   ├── arm.ts                      # ARM HTTP client
│   ├── logger.ts                   # Winston → stderr
│   ├── version.ts                  # Auto-generated
│   ├── useragent.ts                # User-Agent composer
│   ├── schema/
│   │   ├── openApiParser.ts        # OpenAPI 2.0 → ParsedOperation[]
│   │   └── zodGenerator.ts         # ParsedOperation → Zod schemas
│   └── tools/
│       ├── staticTools.ts          # list_connections, put_connection, etc.
│       ├── dynamicTools.ts         # registerDynamicTools + invokeDynamicTool
│       └── metaTools.ts            # refresh_tools, list_dynamic_tools
├── tests/
│   ├── schema/
│   │   ├── openApiParser.test.ts   # Parser unit tests
│   │   └── zodGenerator.test.ts    # Zod generation tests
│   ├── tools/
│   │   ├── dynamicTools.test.ts    # Dynamic registration tests
│   │   └── invocation.test.ts      # dynamicInvoke tests
│   └── fixtures/
│       ├── office365-schema.json   # Test fixture (from spec/ARM-Calls/)
│       └── teams-schema.json       # Test fixture
├── spec/                           # Specifications (this file)
├── docs/                           # Documentation
├── mcp.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## 9. Updated `src/index.ts` — Startup with Dynamic Tools

```typescript
async function main() {
  // ... (existing setup: yargs, auth, armContext) ...

  // Declare listChanged capability so clients know tools may change at runtime
  const server = new McpServer(
    { name: "mcp-connections", version },
    { capabilities: { tools: { listChanged: true } } }
  );

  // Register static tools — pass server reference so put_connection
  // can trigger incremental dynamic tool registration
  configureStaticTools(server, authenticator, armContext, () => userAgentComposer.userAgent);

  // Register dynamic tools from connected APIs
  try {
    const result = await registerDynamicTools(
      server, authenticator, armContext, () => userAgentComposer.userAgent
    );
    logger.info("Dynamic tools registered", result);
  } catch (error) {
    logger.warn("Dynamic tool registration failed, continuing with static tools only", { error });
  }

  // Register meta-tools (refresh_tools, list_dynamic_tools)
  configureMetaTools(server, authenticator, armContext, () => userAgentComposer.userAgent);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

---

## 10. Auto-Reload: `put_connection` Integration

When `put_connection` successfully creates a new connection, it automatically
triggers incremental tool registration for that API. This keeps the tool list
in sync without requiring manual `refresh_tools` calls or server restarts.

### 10.1 Updated `put_connection` Handler

In `src/tools/staticTools.ts`, the `put_connection` handler calls
`registerToolsForConnection` after a successful PUT:

```typescript
import { registerToolsForConnection } from "./dynamicTools.js";

server.tool(
  "put_connection",
  "Create or update an API connection in the resource group.",
  { /* ... existing Zod schema ... */ },
  async (params) => {
    try {
      const token = await tokenProvider();

      // 1. PUT connection to ARM (existing logic)
      const connectionPath =
        `/subscriptions/${armContext.subscriptionId}` +
        `/resourceGroups/${armContext.resourceGroup}` +
        `/providers/Microsoft.Web/connections/${params.connectionName}`;

      const putResult = await armRequest<any>("PUT", connectionPath, token, {
        body: params.body,
        userAgent: userAgentProvider(),
      });

      // 2. Auto-register dynamic tools for the new API
      let toolStats = { registered: 0, skipped: 0, errors: [] as string[] };
      try {
        toolStats = await registerToolsForConnection(
          server, putResult, tokenProvider, armContext, userAgentProvider
        );
      } catch (toolError) {
        logger.warn(`Auto-registration failed for ${params.connectionName}`, { toolError });
      }

      // 3. Return combined result
      const response: any = {
        connection: putResult,
      };

      if (toolStats.registered > 0) {
        response.dynamicTools = {
          message: `${toolStats.registered} new tools registered for ${putResult.properties.api.name}`,
          registered: toolStats.registered,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error}` }],
        isError: true,
      };
    }
  }
);
```

### 10.2 Flow: What Happens When a User Creates a Connection

```
AI/User               MCP Server              ARM
 │                        │                     │
 │  put_connection        │                     │
 │  { apiName: "slack" }  │                     │
 │───────────────────────>│                     │
 │                        │  PUT .../connections │
 │                        │    /slack            │
 │                        │────────────────────>│
 │                        │  { name: "slack",    │
 │                        │    properties: ... } │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  GET managedApis/    │
 │                        │  slack?export=true   │
 │                        │────────────────────>│
 │                        │  { swagger: {...} }  │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  Parse + Filter +    │
 │                        │  Register N tools    │
 │                        │                     │
 │                        │──► sendToolListChanged()
 │                        │    (notify client)   │
 │                        │                     │
 │  { connection: {...},  │                     │
 │    dynamicTools: {     │                     │
 │      registered: 15    │                     │
 │    }}                  │                     │
 │<───────────────────────│                     │
 │                        │                     │
 │  (client refreshes     │                     │
 │   tool list — new      │                     │
 │   slack_* tools now    │                     │
 │   available)           │                     │
```

### 10.3 Edge Cases

| Scenario | Behavior |
|----------|----------|
| **API tools already registered** | `registerToolsForConnection` detects existing prefix, skips. Returns `registered: 0`. |
| **Schema fetch fails** | Logs warning, returns connection result without `dynamicTools`. Tools can be added later via `refresh_tools`. |
| **Connection is unauthenticated** | Tools are still registered (with ⚠️ description). On invocation, consent link is returned. |
| **Multiple connections for same API** | Second `put_connection` for same API is a no-op for tools (prefix already exists). |
| **Client doesn't support `listChanged`** | `sendToolListChanged()` is still called but ignored by the client. User can use `list_dynamic_tools` to see new tools. |

---

## 11. Meta-Tools

### 11.1 `list_dynamic_tools`

Lists all dynamically registered tools and their source connections.

```typescript
server.tool(
  "list_dynamic_tools",
  "List all dynamically registered tools from connected APIs.",
  {},
  async () => {
    const tools = Array.from(toolRegistry.entries()).map(([name, ctx]) => ({
      tool: name,
      api: ctx.connection.apiName,
      displayName: ctx.connection.displayName,
      status: ctx.connection.status,
      operationId: ctx.operation.operationId,
      method: ctx.operation.method.toUpperCase(),
      summary: ctx.operation.summary,
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify(tools, null, 2),
      }],
    };
  }
);
```

### 11.2 `refresh_tools`

Force re-fetch schemas and re-register tools (e.g., after creating a new connection).

> **Note:** MCP SDK may not support unregistering tools at runtime. If not,
> this tool clears the schema cache and logs which new tools _would_ be registered,
> advising the user to restart the server.

```typescript
server.tool(
  "refresh_tools",
  "Refresh dynamic tools by re-scanning connections and their schemas. " +
  "May require server restart if new connections were added.",
  {},
  async () => {
    schemaCache.clear();
    // Re-scan connections
    const result = await registerDynamicTools(
      server, tokenProvider, armContext, userAgentProvider
    );
    return {
      content: [{
        type: "text",
        text: `Refresh complete. Registered: ${result.registered}, ` +
              `Skipped: ${result.skipped}, Errors: ${result.errors.length}\n` +
              (result.errors.length > 0 ? result.errors.join("\n") : ""),
      }],
    };
  }
);
```

---

## 12. Key Microsoft OpenAPI Extensions Reference

These extensions in the connector schemas drive tool generation behaviour:

| Extension | Location | Effect on Tool Generation |
|-----------|----------|---------------------------|
| `x-ms-visibility` | operation, parameter | `"internal"` → skip; `"important"` → priority; `"advanced"` → include |
| `x-ms-trigger` | operation | Skip — MCP is not event-driven |
| `x-ms-api-annotation` | operation | `{ family, revision }` → deduplicate deprecated versions |
| `x-ms-summary` | parameter, property | Use as Zod `.describe()` text |
| `x-ms-dynamic-values` | parameter | Indicates dropdown needs runtime fetch — note in description |
| `x-ms-dynamic-schema` | definition | Runtime schema — fall back to `z.record(z.unknown())` |
| `x-ms-pageable` | operation | Note `nextLinkName` — tool should handle pagination |
| `x-ms-no-generic-test` | operation | Informational only |
| `x-ms-url-encoding` | parameter | `"double"` → double-encode path segments |
| `x-ms-enum-values` | property | Map to `z.enum()` with display names in description |

---

## 13. Error Handling & Edge Cases

### 13.1 Schema Fetch Failures

```typescript
// If schema fetch fails for one connection, continue with others
// Log the error and skip that connection's tools
try {
  const swagger = await fetchApiSchema(conn.apiName, ...);
} catch (error) {
  logger.warn(`Failed to fetch schema for ${conn.apiName}, skipping`, { error });
  stats.errors.push(`${conn.apiName}: ${error.message}`);
  continue;
}
```

### 13.2 Tool Name Collisions

If two connections share the same `apiName` (unlikely but possible with custom
connectors), append connection name:

```typescript
function buildToolName(apiName: string, operationId: string, connName?: string): string {
  const snakeOp = operationId
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

  const prefix = connName && connName !== apiName
    ? `${apiName}_${connName}`
    : apiName;

  return `${prefix}_${snakeOp}`;
}
```

### 13.3 Large Schema Handling

Some connectors (e.g., `office365` with 90+ operations) produce many tools.
Strategies:

| Strategy | Implementation |
|----------|----------------|
| **Visibility filter** | Already handled — skip `"internal"` |
| **Max tools per API** | Optional CLI flag `--maxToolsPerApi 30` |
| **Lazy registration** | Register a `{api}_discover` meta-tool that lists operations; register individual tools on demand |
| **Category grouping** | Group by `tags[]` from OpenAPI; register one tool per tag with sub-operation parameter |

### 13.4 Binary/File Parameters

Operations with `format: "binary"` parameters (file uploads):

```typescript
// Skip binary parameters — MCP text protocol can't handle raw binary
if (param.format === "binary") {
  // Note in tool description that file upload is not supported
  continue;
}
```

---

## 14. Testing Strategy

### 14.1 Unit Tests (`tests/schema/`)

| Test | What It Validates |
|------|-------------------|
| `openApiParser.test.ts` | Parses office365 + teams fixtures correctly; counts ops; applies filters |
| `zodGenerator.test.ts` | Converts parsed operations to valid Zod schemas; handles enums, arrays, defaults |
| `filterOperations.test.ts` | Removes internal/trigger/deprecated/subscription ops correctly |
| `deduplicateByFamily.test.ts` | Keeps latest revision per family; handles missing annotations |

### 14.2 Integration Tests (`tests/tools/`)

| Test | What It Validates |
|------|-------------------|
| `dynamicTools.test.ts` | Mock ARM responses → tools registered with correct names/schemas |
| `invocation.test.ts` | Mock dynamicInvoke → correct request body built from params |
| `authError.test.ts` | Unauthenticated connection → consent link returned |
| `autoReload.test.ts` | put_connection → registerToolsForConnection called → new tools registered → sendToolListChanged emitted |

### 14.3 Test Fixtures

Copy from `spec/ARM-Calls/`:

```
tests/fixtures/
├── office365-schema.json         # From spec/ARM-Calls/
├── teams-schema.json             # From spec/ARM-Calls/
├── listConnections.json          # Mock connection list
└── managedApis-subset.json       # Mock managedApi with swagger
```

---

## 15. Sequence Diagrams

### 15.1 Startup — Dynamic Tool Registration

```
User                  MCP Server              ARM
 │                        │                     │
 │  start server          │                     │
 │───────────────────────>│                     │
 │                        │  GET connections     │
 │                        │────────────────────>│
 │                        │  [office365, teams]  │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  GET managedApis/    │
 │                        │  office365?export    │
 │                        │────────────────────>│
 │                        │  { swagger: {...} }  │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  GET managedApis/    │
 │                        │  teams?export        │
 │                        │────────────────────>│
 │                        │  { swagger: {...} }  │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  Parse + Filter +    │
 │                        │  Register tools      │
 │                        │                     │
 │  server ready          │                     │
 │  (40+ tools)           │                     │
 │<───────────────────────│                     │
```

### 15.2 Runtime — Dynamic Tool Invocation

```
AI/User               MCP Server              ARM (dynamicInvoke)
 │                        │                     │
 │  office365_send_email  │                     │
 │  { to, subject, body } │                     │
 │───────────────────────>│                     │
 │                        │  Acquire ARM token   │
 │                        │  Build invoke body   │
 │                        │                     │
 │                        │  POST .../office365/ │
 │                        │    dynamicInvoke     │
 │                        │  { request: {        │
 │                        │    method: "POST",   │
 │                        │    path: "/Mail",    │
 │                        │    body: {...}       │
 │                        │  }}                  │
 │                        │────────────────────>│
 │                        │                     │
 │                        │  { statusCode: 200,  │
 │                        │    body: {...} }     │
 │                        │<────────────────────│
 │                        │                     │
 │  { "id": "AAMk...",    │                     │
 │    "subject": "..." }  │                     │
 │<───────────────────────│                     │
```

### 15.3 Auto-Reload — `put_connection` Creates New API

```
AI/User               MCP Server              ARM
 │                        │                     │
 │  put_connection        │                     │
 │  { apiName: "slack" }  │                     │
 │───────────────────────>│                     │
 │                        │  PUT .../connections │
 │                        │    /slack            │
 │                        │────────────────────>│
 │                        │  201 Created         │
 │                        │  { name: "slack",    │
 │                        │    properties:... }  │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  (auto-reload)       │
 │                        │  GET managedApis/    │
 │                        │  slack?export=true   │
 │                        │────────────────────>│
 │                        │  { swagger: {...} }  │
 │                        │<────────────────────│
 │                        │                     │
 │                        │  Parse + Filter →    │
 │                        │  Register 15 tools   │
 │                        │                     │
 │                        │──► sendToolListChanged()
 │                        │                     │
 │  { connection: {...},  │                     │
 │    dynamicTools: {     │                     │
 │      registered: 15 }} │                     │
 │<───────────────────────│                     │
 │                        │                     │
 │  slack_post_message    │                     │
 │  { channel, text }     │  (new tool works    │
 │───────────────────────>│   immediately)      │
 │                        │────────────────────>│
 │                        │<────────────────────│
 │  { ok: true }          │                     │
 │<───────────────────────│                     │
```

---

## 16. Implementation Checklist

| # | File | Purpose |
|---|------|---------|
| 1 | `src/schema/openApiParser.ts` | Parse Swagger 2.0 → `ParsedOperation[]` |
| 2 | `src/schema/zodGenerator.ts` | `ParsedOperation` → Zod schemas for `server.tool()` |
| 3 | `src/tools/dynamicTools.ts` | `registerDynamicTools()` + `registerToolsForConnection()` + `invokeDynamicTool()` |
| 4 | `src/tools/metaTools.ts` | `list_dynamic_tools` + `refresh_tools` |
| 5 | `src/tools/staticTools.ts` | `put_connection` calls `registerToolsForConnection()` on success |
| 6 | `src/index.ts` | Declare `tools: { listChanged: true }` capability; call `registerDynamicTools()` at startup |
| 7 | `tests/schema/openApiParser.test.ts` | Parser unit tests against fixtures |
| 8 | `tests/schema/zodGenerator.test.ts` | Zod schema generation tests |
| 9 | `tests/tools/dynamicTools.test.ts` | Registration + invocation integration tests |
| 10 | `tests/tools/autoReload.test.ts` | put_connection → incremental registration → sendToolListChanged |
| 11 | `tests/fixtures/` | Copy schema files from `spec/ARM-Calls/` |
