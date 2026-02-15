# Plan: Scaffold an `npx` MCP server with ADO MCP–style auth and ARM tools

## Objective

Create a local MCP server (Node/TS, runnable via `npx`) that:

1. Uses **the same MSAL public-client auth pattern** as the official Azure DevOps MCP server, including the **same clientId** `0d50963b-7bb9-4fe7-94c7-a99af00b5136`.  
2. Acquires **ARM** tokens and calls Azure Resource Manager with `Authorization: Bearer <token>`.
3. Exposes MCP **tools** that:
   - `list_managed_apis` → enumerates supported connector names via `Microsoft.Web/locations/managedApis` (Microsoft first-party only by default)
   - `getConnectorSchema` → retrieves the OpenAPI/Swagger 2.0 schema for a specific connector (via `export=true`)
   - `putConnection` → `PUT Microsoft.Web/connections/{connectionName}` — creates/updates a connection resource
   - `listConsentLinks` → `POST .../connections/{connectionName}/listConsentLinks` — returns OAuth login URLs to authenticate a connection
   - `confirmConsentCode` → `POST .../connections/{connectionName}/confirmConsentCode` — completes the OAuth flow after user login
   - `listConnections` → `GET .../connections/` — lists all connections in a resource group with their status
   - `getConnection` → `GET .../connections/{connectionName}` — gets a specific connection's status and details

> Sources (for reference while implementing):  
> - ADO MCP auth implementation + clientId: `src/auth.ts` in microsoft/azure-devops-mcp  
> - Managed APIs list endpoint: `GET .../providers/Microsoft.Web/locations/{location}/managedApis?api-version=2016-06-01`  
> - Connector OpenAPI schema: `GET .../providers/Microsoft.Web/locations/{location}/managedApis/{apiName}?api-version=2016-06-01&export=true`  
> - Connections create/update: `PUT .../providers/Microsoft.Web/connections/{connectionName}?api-version=2016-06-01`  
> - Consent links: `POST .../connections/{connectionName}/listConsentLinks?api-version=2018-07-01-preview`  
> - Confirm consent: `POST .../connections/{connectionName}/confirmConsentCode?api-version=2016-06-01`  
> - List connections: `GET .../resourceGroups/{rg}/providers/Microsoft.Web/connections/?api-version=2016-06-01`  
> - ARM resource schema for `Microsoft.Web/connections` (apiVersion `2016-06-01`)  
> - Sample ARM responses available in `spec/ARM-Calls/` (managedApis-subset.json, office365-conn.json, teams-connection-response.json, listConnections.json)

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
      managedApis.ts         # list_managed_apis + getConnectorSchema tools
      connections.ts         # putConnection, listConnections, getConnection tools
      consent.ts             # listConsentLinks + confirmConsentCode tools
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
  method: "GET" | "PUT" | "POST",
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

### Tool 1: `list_managed_apis`

**Purpose:** show which connectors are supported in a region (`managedApis`).

**ARM call:**  
`GET /subscriptions/{subscriptionId}/providers/Microsoft.Web/locations/{location}/managedApis?api-version=2016-06-01`

Returns only connector **names** (string array), filtered to Microsoft first-party connectors by default.

**Implementation:**
- Inputs: `{ location?, microsoftOnly? }`
  - `location` — Azure region override (defaults to server's `--location` value)
  - `microsoftOnly` — boolean, defaults to `true`; set to `false` to include all connectors
- Output: JSON string array of connector names, e.g. `["office365", "teams", "sharepointonline", ...]`
- **Filtering:** uses `properties.connectionParameters.token.oAuthSettings.properties.IsFirstParty === "True"` from the ARM response to identify Microsoft first-party connectors (~120 out of ~570+ total)
- Rationale: the full managed API list includes hundreds of third-party connectors that add noise; starting with Microsoft-only keeps the output focused and useful for common scenarios (Teams, Office 365, SharePoint, Outlook, OneDrive, etc.)

### Tool 2: `getConnectorSchema`

**Purpose:** retrieve the full OpenAPI/Swagger 2.0 specification for a specific connector, which describes all available actions, triggers, parameters, and response models.

**ARM call:**  
`GET /subscriptions/{subscriptionId}/providers/Microsoft.Web/locations/{location}/managedApis/{apiName}?api-version=2016-06-01&export=true`

**Implementation:**
- Inputs: `{ subscriptionId, location, apiName }`
- Output: raw Swagger 2.0 JSON (can be large, e.g. 338 KB for Teams, 672 KB for Office365)
- Note: The `export=true` query parameter is what triggers the OpenAPI schema to be included in the response (without it, only metadata is returned)

### Tool 3: `putConnection`

**Purpose:** create or update an API connection resource. After creation the connection will be in `Unauthenticated` state — use `listConsentLinks` + `confirmConsentCode` to complete OAuth authentication.

**ARM call:**  
`PUT /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/{connectionName}?api-version=2016-06-01`

**Inputs (minimum viable):**
- `subscriptionId`
- `resourceGroupName`
- `connectionName`
- `location`
- `managedApiName` — the connector name (e.g. `office365`, `teams`); the tool will construct the full managedApiId: `/subscriptions/{sub}/providers/Microsoft.Web/locations/{loc}/managedApis/{apiName}`
- `displayName` (optional; defaults to `connectionName`)
- `parameterValues` (object; varies by connector — only needed for connectors that don't use OAuth, e.g. SQL Server connection strings)

**Body shape (baseline — for OAuth connectors like Teams/Office365):**
```json
{
  "location": "westus",
  "properties": {
    "displayName": "my-conn",
    "api": {
      "id": "/subscriptions/.../providers/Microsoft.Web/locations/westus/managedApis/office365"
    }
  }
}
```

**Expected response:** connection resource with `overallStatus: "Error"` and `statuses[].error.code: "Unauthenticated"` (for OAuth connectors). See `spec/ARM-Calls/office365-conn.json` for full example.

**Trade-off: parameter schema**
- ARM does **not** give you a strongly typed schema per connector at compile-time.
- The `connectionParameters` structure in the managedApi response (see `managedApis-subset.json`) describes what parameters each connector needs and whether they use `oauthSetting` or direct values.
- Decision: return errors verbatim and require the caller (human/agent) to provide correct `parameterValues` based on the connector.

### Tool 4: `listConsentLinks`

**Purpose:** after creating a connection, get the OAuth consent URL(s) that the user must visit to authenticate the connection. This is the critical step that transitions a connection from `Unauthenticated` to `Connected`.

**ARM call:**  
`POST /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/{connectionName}/listConsentLinks?api-version=2018-07-01-preview`

> **Note:** This endpoint uses `api-version=2018-07-01-preview`, **not** `2016-06-01`.

**Request body:**
```json
{
  "parameters": [
    {
      "objectId": "<user-or-service-principal-object-id>",
      "parameterName": "token",
      "redirectUrl": "http://localhost:8080",
      "tenantId": "<azure-ad-tenant-id>"
    }
  ]
}
```

**Parameter details:**
- `objectId` — the Azure AD object ID of the user who will own the connection (can be obtained from `az ad signed-in-user show --query id -o tsv`)
- `parameterName` — must match a `connectionParameters` key of type `oauthSetting` from the managedApi definition (typically `"token"`)
- `redirectUrl` — where the OAuth flow will redirect after consent; use `http://localhost:8080` for local dev, or the Azure portal redirect URL for portal-based auth
- `tenantId` — the Azure AD tenant ID

**Response shape:**
```json
{
  "value": [
    {
      "link": "https://logic-apis-westus.consent.azure-apim.net/login?data=...",
      "firstPartyLoginUri": "https://logic-apis-westus.consent.azure-apim.net/firstPartyLogin?data=...",
      "displayName": null,
      "status": "Unauthenticated"
    }
  ]
}
```

**Implementation:**
- Inputs: `{ subscriptionId, resourceGroupName, connectionName, objectId, tenantId, redirectUrl? }`
- Output: the consent link(s) — the `link` field is the URL the user must open in a browser
- The consent link has a short TTL (~10 minutes) — surface this to the user
- After the user authenticates, the redirect URL will receive a `code` query parameter needed for `confirmConsentCode`

### Tool 5: `confirmConsentCode`

**Purpose:** complete the OAuth authentication flow by confirming the consent code received after the user authenticates via the consent link.

**ARM call:**  
`POST /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/{connectionName}/confirmConsentCode?api-version=2016-06-01`

**Request body:**
```json
{
  "objectId": "<user-object-id>",
  "tenantId": "<azure-ad-tenant-id>",
  "code": "<code-from-redirect>"
}
```

**Implementation:**
- Inputs: `{ subscriptionId, resourceGroupName, connectionName, objectId, tenantId, code }`
- Output: confirmation status
- After success, the connection's `overallStatus` changes from `Error` to `Connected`

### Tool 6: `listConnections`

**Purpose:** list all API connections in a resource group with their current status (Connected, Error/Unauthenticated, etc.).

**ARM call:**  
`GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/?api-version=2016-06-01`

**Implementation:**
- Inputs: `{ subscriptionId, resourceGroupName }`
- Output: list of connections with `name`, `overallStatus`, `authenticatedUser`, `api.displayName`, and `connectionState`
- See `spec/ARM-Calls/listConnections.json` for a full example showing both a `Connected` (office365) and `Error` (teams) connection

### Tool 7: `getConnection`

**Purpose:** get details for a specific connection, including authentication status and test endpoints.

**ARM call:**  
`GET /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/{connectionName}?api-version=2016-06-01`

**Implementation:**
- Inputs: `{ subscriptionId, resourceGroupName, connectionName }`
- Output: full connection resource including `overallStatus`, `statuses[]`, `authenticatedUser`, `testLinks[]`, `testRequests[]`

---

## Connection lifecycle (end-to-end flow)

The full flow for creating and authenticating a connection:

1. **Discover connectors** → `list_managed_apis` — find the connector you want (e.g. `office365`); returns names only, Microsoft first-party by default
2. **Inspect schema** → `getConnectorSchema` — (optional) get the OpenAPI spec to understand available operations
3. **Create connection** → `putConnection` — creates the connection resource (starts in `Unauthenticated` state for OAuth connectors)
4. **Get consent URL** → `listConsentLinks` — returns a login URL the user must open in a browser
5. **User authenticates** → user opens the consent link, signs in, and is redirected with a `code` parameter
6. **Confirm consent** → `confirmConsentCode` — exchanges the consent code to complete authentication
7. **Verify** → `getConnection` or `listConnections` — confirm `overallStatus` is `Connected`

> **Note:** For OAuth-based connectors (Teams, Office365, etc.), the `connectionParameters` in the managedApi response will have a parameter of `type: "oauthSetting"` — these always require the consent flow. The `oAuthSettings` object contains the `identityProvider`, `clientId`, `scopes`, and `redirectUrl` that the consent service uses internally.

---

## Validation workflow (smoke tests)

1. **Token acquisition**
   - `arm-connections-mcp --authentication interactive --tenant <optional>`
   - Confirm token is minted for `https://management.azure.com`

2. **List managed APIs**
   - call `list_managed_apis` for `westus` (or chosen region)
   - verify results contain expected APIs

3. **Create connection + authenticate**
   - `putConnection` for `office365` → verify response has `overallStatus: "Error"` (Unauthenticated)
   - `listConsentLinks` → verify consent URL is returned
   - Open consent link in browser, authenticate, capture redirect code
   - `confirmConsentCode` → verify success
   - `getConnection` → verify `overallStatus: "Connected"`

4. **List connections**
   - `listConnections` → verify both Connected and Unauthenticated connections are listed correctly
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
- [ ] `arm.ts` ARM client (retry/timeout/error shaping, supports GET/PUT/POST)
- [ ] MCP server entrypoint + stdio transport
- [ ] Tool: `list_managed_apis`
- [ ] Tool: `getConnectorSchema`
- [ ] Tool: `putConnection`
- [ ] Tool: `listConsentLinks`
- [ ] Tool: `confirmConsentCode`
- [ ] Tool: `listConnections`
- [ ] Tool: `getConnection`
- [ ] README with sample `mcp.json` + example tool calls + connection lifecycle walkthrough

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
