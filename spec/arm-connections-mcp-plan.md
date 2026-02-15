# Plan: Scaffold an `npx` MCP server with ADO MCP–style auth and ARM tools

## Objective

Create a local MCP server (Node/TS, runnable via `npx`) that:

1. Uses **the same MSAL public-client auth pattern** as the official Azure DevOps MCP server, including the **same clientId** `0d50963b-7bb9-4fe7-94c7-a99af00b5136`.  
2. Acquires **ARM** tokens and calls Azure Resource Manager with `Authorization: Bearer <token>`.
3. Exposes MCP **tools** that:
   - `listManagedApis` → enumerates supported connectors via `Microsoft.Web/locations/managedApis`
   - `putConnection` → `PUT Microsoft.Web/connections/{connectionName}`

> Sources (for reference while implementing):  
> - ADO MCP auth implementation + clientId: `src/auth.ts` in microsoft/azure-devops-mcp  
> - Managed APIs list endpoint: `GET .../providers/Microsoft.Web/locations/{location}/managedApis?api-version=2016-06-01`  
> - Connections create/update: `PUT .../providers/Microsoft.Web/connections/{connectionName}?api-version=2016-06-01`  
> - ARM resource schema for `Microsoft.Web/connections` (apiVersion `2016-06-01`)

---

## Repo scaffold

### 1) Initialize project

```bash
mkdir arm-connections-mcp
cd arm-connections-mcp
npm init -y
npm i @modelcontextprotocol/sdk zod
npm i @azure/identity @azure/msal-node open
npm i -D typescript tsx @types/node eslint prettier
```

### 2) Package layout

```
arm-connections-mcp/
  src/
    index.ts                 # MCP server entrypoint (stdio)
    auth.ts                  # ADO-style auth wrapper (MSAL + Azure Identity modes)
    arm.ts                   # ARM HTTP client (fetch wrapper, retries, correlation)
    tools/
      managedApis.ts         # listManagedApis tool
      connections.ts         # putConnection tool
    logger.ts                # structured logger
    version.ts               # package version helper
  mcp.json                   # example client config (VS Code)
  package.json
  tsconfig.json
  README.md
```

### 3) `package.json` essentials

- Set `"type": "module"`
- Add `"bin"` so `npx` can run it
- Use `tsx` for dev and `tsc` for build

Example:

```json
{
  "name": "@your-scope/arm-connections-mcp",
  "type": "module",
  "bin": {
    "arm-connections-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/index.ts",
    "lint": "eslint ."
  }
}
```

---

## Authentication (mirror ADO MCP)

### Target behavior

- **Default**: interactive browser login (MSAL) and then silent renewal in-process.
- Optional modes:
  - `azcli` / `env`: `DefaultAzureCredential` (+ optional tenant-specific AzureCliCredential chaining)
  - `envvar`: raw token via env var (escape hatch)

### Key differences vs ADO MCP

- Scope changes from ADO resource to ARM resource:

```ts
// ADO MCP uses: ["499b84ac-1321-427f-aa17-267ca6975798/.default"]
const scopes = ["https://management.azure.com/.default"];
```

### `src/auth.ts` (implementation guidance)

Copy the structure from ADO MCP:

- Keep `clientId = "0d50963b-7bb9-4fe7-94c7-a99af00b5136"`
- Keep `authority = https://login.microsoftonline.com/common` default, with optional tenant override
- Implement:

```ts
export type AuthType = "interactive" | "azcli" | "env" | "envvar";

export function createAuthenticator(type: AuthType, tenantId?: string): () => Promise<string>;
```

**Important risk to validate early**
- Reusing that clientId for ARM is only viable if the app registration allows ARM resource tokens for your tenant policies. If interactive auth succeeds but ARM calls fail with `401/403`, you’ll need a **fallback plan**:
  - (Preferred) register your own Entra app + use that clientId
  - (Still okay for local dev) use `DefaultAzureCredential` and rely on `az login`

---

## ARM client

### `src/arm.ts`

Build a thin HTTP client:

- Base URL: `https://management.azure.com`
- Always append `api-version`
- Add:
  - retry for `429`, `5xx` (exponential backoff + jitter)
  - correlation header `x-ms-correlation-request-id` (optional)
  - structured error surface (status, error.code, error.message)

Pseudo:

```ts
export async function armRequest<T>(
  method: "GET" | "PUT",
  path: string,
  token: string,
  query: Record<string,string>,
  body?: unknown
): Promise<T>
```

---

## MCP server wiring

### `src/index.ts`

Use stdio transport and register tools.

- Parse CLI args via `yargs` (like ADO MCP):
  - `--subscription`
  - `--resourceGroup`
  - `--location`
  - `--authentication` (`interactive|azcli|env|envvar`)
  - `--tenant` (optional)

Register tools via `server.tool(name, schema, handler)` (SDK pattern).

Also: expose `server` metadata (name/version/icons).

---

## Tools

### Tool 1: `listManagedApis`

**Purpose:** show which connectors are supported in a region (`managedApis`).

**ARM call:**  
`GET /subscriptions/{subscriptionId}/providers/Microsoft.Web/locations/{location}/managedApis?api-version=2016-06-01`

Returned payload includes managed API entries (name/type/id/properties), which you’ll return as-is (or lightly shaped) to the client.

**Implementation:**
- Inputs: `{ subscriptionId, location }`
- Output: list of `{ name, id, location, properties }` (or raw)

### Tool 2: `putConnection`

**Purpose:** create/update an API connection resource.

**ARM call:**  
`PUT /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/{connectionName}?api-version=2016-06-01`

**Inputs (minimum viable):**
- `subscriptionId`
- `resourceGroupName`
- `connectionName`
- `location`
- `managedApiId` (resource ID from `listManagedApis`, typically includes `/locations/{loc}/managedApis/{apiName}`)
- `displayName`
- `parameterValues` (object; varies by connector)

**Body shape (baseline):**
```json
{
  "location": "westus",
  "properties": {
    "displayName": "my-conn",
    "api": {
      "id": "/subscriptions/.../providers/Microsoft.Web/locations/westus/managedApis/office365"
    },
    "parameterValues": {
      "...": "..."
    }
  }
}
```

**Trade-off: parameter schema**
- ARM does **not** give you a strongly typed schema per connector at compile-time.
- Decision: return errors verbatim and require the caller (human/agent) to provide correct `parameterValues` based on the connector.

---

## Validation workflow (smoke tests)

1. **Token acquisition**
   - `arm-connections-mcp --authentication interactive --tenant <optional>`
   - Confirm token is minted for `https://management.azure.com`

2. **List managed APIs**
   - call `listManagedApis` for `westus` (or chosen region)
   - verify results contain expected APIs

3. **Create connection**
   - choose a managed API and create a connection with known-good `parameterValues`
   - validate resource exists in Azure Portal / ARM `GET`

---

## Operational hardening (minimum bar)

- Don’t log tokens; redact headers in logs.
- Concurrency limits: cap inflight ARM requests (simple semaphore).
- Backoff + retry for 429/5xx.
- Timeouts (client-side) and cancellation support where possible.
- Clear error messages for:
  - missing RBAC (`403`)
  - missing provider registration (`409`/`MissingSubscriptionRegistration`)
  - bad connector parameters (`400`)

---

## Deliverables checklist

- [ ] TypeScript project scaffolding + `bin` entry for `npx`
- [ ] `auth.ts` copied/adapted from ADO MCP (same clientId)
- [ ] `arm.ts` ARM client (retry/timeout/error shaping)
- [ ] MCP server entrypoint + stdio transport
- [ ] Tool: `listManagedApis`
- [ ] Tool: `putConnection`
- [ ] README with sample `mcp.json` + example tool calls

---

## Example `mcp.json` (VS Code)

```json
{
  "servers": {
    "armConnections": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@your-scope/arm-connections-mcp", "--subscription", "<sub>", "--resourceGroup", "<rg>", "--location", "westus"]
    }
  }
}
```
