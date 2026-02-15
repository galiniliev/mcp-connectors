# MCP Server Specification: ARM Connections

> Scaffold an `npx`-runnable MCP server (Node/TypeScript) that mirrors the structure, auth patterns, and conventions of [microsoft/azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp) — targeting **Azure Resource Manager** (ARM) instead of Azure DevOps.

---

## 1. Project Initialisation

### 1.1 Create the project

```bash
mkdir arm-connections-mcp && cd arm-connections-mcp
npm init -y
```

### 1.2 Install dependencies

| Category | Packages |
|----------|----------|
| Runtime | `@modelcontextprotocol/sdk` `zod` `@azure/identity` `@azure/msal-node` `open` `winston` `yargs` |
| Dev | `typescript` `tsx` `@types/node` `shx` `prettier` `eslint` `typescript-eslint` `eslint-config-prettier` `jest` `ts-jest` `@types/jest` `husky` `lint-staged` |

```bash
npm i @modelcontextprotocol/sdk zod @azure/identity @azure/msal-node open winston yargs
npm i -D typescript tsx @types/node shx prettier eslint typescript-eslint eslint-config-prettier jest ts-jest @types/jest husky lint-staged
```

---

## 2. Package Layout

```
arm-connections-mcp/
├── src/
│   ├── index.ts              # CLI entry-point (yargs + McpServer + stdio)
│   ├── auth.ts               # MSAL/Azure-Identity auth (mirrors ADO MCP)
│   ├── arm.ts                # Thin ARM HTTP client (fetch + retry + error shaping)
│   ├── logger.ts             # Winston → stderr
│   ├── version.ts            # Auto-generated at prebuild
│   ├── useragent.ts          # User-Agent composer
│   └── tools/
│       ├── managedApis.ts    # listManagedApis tool
│       └── connections.ts    # putConnection / listConnections tools
├── mcp.json                  # VS Code MCP client config example
├── package.json
├── tsconfig.json
├── .prettierrc.json
├── eslint.config.mjs
├── jest.config.cjs
└── README.md
```

---

## 3. `package.json`

Follow the ADO MCP conventions exactly:

```jsonc
{
  "name": "@galini-mcp/arm-connections",
  "version": "0.1.0",
  "description": "MCP server for managing Azure API connections via ARM",
  "license": "MIT",
  "type": "module",
  "bin": {
    "arm-connections-mcp": "dist/index.js"
  },
  "files": ["dist"],
  "publishConfig": { "access": "public" },
  "scripts": {
    "prebuild": "node -p \"'export const packageVersion = ' + JSON.stringify(require('./package.json').version) + ';\\n'\" > src/version.ts && prettier --write src/version.ts",
    "build": "tsc && shx chmod +x dist/*.js",
    "watch": "tsc --watch",
    "dev": "tsx src/index.ts",
    "inspect": "ALLOWED_ORIGINS=http://127.0.0.1:6274 npx @modelcontextprotocol/inspector node dist/index.js",
    "start": "node dist/index.js",
    "eslint": "eslint",
    "format": "prettier --write .",
    "format-check": "prettier --check .",
    "test": "jest",
    "clean": "shx rm -rf dist"
  }
}
```

Key points:
- `"type": "module"` — ESM throughout.
- `"bin"` — enables `npx arm-connections-mcp`.
- `prebuild` — auto-generates `src/version.ts` from `package.json` version (same as ADO MCP).

---

## 4. `tsconfig.json`

```json
{
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "baseUrl": "src",
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["./src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 5. `src/index.ts` — Entry Point

Mirrors ADO MCP's `index.ts`. Uses yargs for CLI, creates `McpServer`, wires auth + tools, connects stdio transport.

### 5.1 CLI Arguments

| Argument | Alias | Type | Required | Default | Description |
|----------|-------|------|----------|---------|-------------|
| `--subscriptionId` | `-s` | string | **yes** | — | Azure subscription ID |
| `--resourceGroup` | `-g` | string | **yes** | — | Azure resource group name |
| `--location` | `-l` | string | no | `"westus"` | Azure region for managed APIs |
| `--authentication` | `-a` | string | no | `"interactive"` (or `"azcli"` in Codespace) | Auth mode: `interactive \| azcli \| env \| envvar` |
| `--tenant` | `-t` | string | no | — | Entra ID tenant override |

### 5.2 Pseudocode

```typescript
#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { configureAllTools } from "./tools.js";   // NEW — registers ARM tools
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

const argv = yargs(hideBin(process.argv))
  .scriptName("arm-connections-mcp")
  .usage("Usage: $0 --subscriptionId <sub> --resourceGroup <rg> [options]")
  .version(packageVersion)
  .option("subscriptionId", {
    alias: "s",
    describe: "Azure subscription ID",
    type: "string",
    demandOption: true,
  })
  .option("resourceGroup", {
    alias: "g",
    describe: "Azure resource group name",
    type: "string",
    demandOption: true,
  })
  .option("location", {
    alias: "l",
    describe: "Azure region (e.g. westus, eastus)",
    type: "string",
    default: "westus",
  })
  .option("authentication", {
    alias: "a",
    describe: "Authentication mode",
    type: "string",
    choices: ["interactive", "azcli", "env", "envvar"] as const,
    default: defaultAuthType,
  })
  .option("tenant", {
    alias: "t",
    describe: "Entra ID tenant ID (optional)",
    type: "string",
  })
  .help()
  .parseSync();

async function main() {
  logger.info("Starting ARM Connections MCP Server", {
    subscriptionId: argv.subscriptionId,
    resourceGroup: argv.resourceGroup,
    location: argv.location,
    authentication: argv.authentication,
    tenant: argv.tenant,
    version: packageVersion,
  });

  const server = new McpServer({
    name: "ARM Connections MCP Server",
    version: packageVersion,
  });

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  const authenticator = createAuthenticator(argv.authentication, argv.tenant);

  // Pass subscription/rg/location as context so tools don't re-ask for them
  const armContext = {
    subscriptionId: argv.subscriptionId,
    resourceGroup: argv.resourceGroup,
    location: argv.location,
  };

  configureAllTools(server, authenticator, armContext, () => userAgentComposer.userAgent);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
```

---

## 6. `src/auth.ts` — Authentication

**Copy the ADO MCP auth module almost verbatim.** The only change: swap the scope from the ADO resource to the ARM resource.

### 6.1 Scope Change

```typescript
// ADO MCP uses:
//   const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/.default"];
// ARM scope:
const scopes = ["https://management.azure.com/.default"];
```

### 6.2 Shared Constants

```typescript
const clientId  = "0d50963b-7bb9-4fe7-94c7-a99af00b5136";  // same as ADO MCP
const defaultAuthority = "https://login.microsoftonline.com/common";
```

> **Risk note:** Reusing the ADO MCP clientId for ARM tokens depends on the app registration's resource permissions. If ARM calls return `401`/`403`, register a new Entra app or fall back to `DefaultAzureCredential` (`azcli` mode).

### 6.3 OAuthAuthenticator Class

Identical to ADO MCP's `OAuthAuthenticator`:

```typescript
class OAuthAuthenticator {
  private accountId: AccountInfo | null = null;
  private publicClientApp: PublicClientApplication;

  constructor(tenantId?: string) {
    const authority = tenantId && tenantId !== "00000000-0000-0000-0000-000000000000"
      ? `https://login.microsoftonline.com/${tenantId}`
      : defaultAuthority;

    this.publicClientApp = new PublicClientApplication({
      auth: { clientId, authority },
    });
  }

  async getToken(): Promise<string> {
    // 1. Try silent acquisition with cached account
    // 2. Fall back to interactive (opens browser via `open` package)
    // 3. Cache the account for next silent attempt
    // 4. Return accessToken
  }
}
```

### 6.4 `createAuthenticator` Factory

```typescript
export type AuthType = "interactive" | "azcli" | "env" | "envvar";

export function createAuthenticator(type: string, tenantId?: string): () => Promise<string>;
```

| Mode | Implementation |
|------|----------------|
| `interactive` | `OAuthAuthenticator` — browser-based MSAL login, silent renewal |
| `azcli` | `ChainedTokenCredential(AzureCliCredential, DefaultAzureCredential)`, sets `AZURE_TOKEN_CREDENTIALS=dev` |
| `env` | `DefaultAzureCredential` (respects env vars) |
| `envvar` | Reads raw token from `ARM_MCP_AUTH_TOKEN` env var |

All modes return `() => Promise<string>` (a token-provider function).

---

## 7. `src/arm.ts` — ARM HTTP Client

A thin `fetch`-based wrapper for Azure Resource Manager calls. **This replaces the ADO `WebApi` client.**

### 7.1 Interface

```typescript
export interface ArmContext {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
}

export interface ArmError {
  code: string;
  message: string;
  statusCode: number;
}

export async function armRequest<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  token: string,
  options?: {
    apiVersion?: string;       // default "2016-06-01"
    query?: Record<string, string>;
    body?: unknown;
    userAgent?: string;
  }
): Promise<T>;
```

### 7.2 Behaviour

- **Base URL:** `https://management.azure.com`
- **Default api-version:** `2016-06-01` (the version used by `Microsoft.Web/connections` and `managedApis`)
- **Headers:**
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - `User-Agent: <composed>`
  - `x-ms-correlation-request-id: <uuid>` (optional, for tracing)
- **Retry logic:** Exponential backoff + jitter for `429` and `5xx` (max 3 retries)
- **Timeout:** 30s client-side per request
- **Error shaping:** Parse ARM error envelope (`{ error: { code, message } }`) into typed `ArmError`

### 7.3 Common Error Handling

| Status | ARM Code | Guidance |
|--------|----------|----------|
| 403 | `AuthorizationFailed` | Missing RBAC — tell user to assign Contributor on the resource group |
| 409 | `MissingSubscriptionRegistration` | Run `az provider register -n Microsoft.Web` |
| 400 | varies | Return ARM error.message verbatim to the caller |
| 429 | — | Retry with `Retry-After` header or exponential backoff |

---

## 8. `src/logger.ts` — Structured Logging

Identical to ADO MCP. Winston logs **to stderr** so stdout remains clean for MCP stdio protocol.

```typescript
import winston from "winston";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Stream({ stream: process.stderr }),
  ],
  exitOnError: false,
});
```

---

## 9. `src/version.ts` — Auto-Generated

Generated by the `prebuild` script from `package.json` version:

```typescript
export const packageVersion = "0.1.0";
```

---

## 10. `src/useragent.ts` — User-Agent Composer

Mirrors ADO MCP. Composes a user-agent string and optionally appends MCP client info.

```typescript
class UserAgentComposer {
  private _userAgent: string;
  private _mcpClientInfoAppended = false;

  constructor(packageVersion: string) {
    this._userAgent = `ARMConnections.MCP/${packageVersion} (local)`;
  }

  get userAgent(): string { return this._userAgent; }

  appendMcpClientInfo(info: { name: string; version: string } | undefined): void {
    if (!this._mcpClientInfoAppended && info?.name && info?.version) {
      this._userAgent += ` ${info.name}/${info.version}`;
      this._mcpClientInfoAppended = true;
    }
  }
}

export { UserAgentComposer };
```

---

## 11. Tool Registration

### 11.1 `src/tools.ts` (tool wiring — simplified, no domain gating needed)

Unlike ADO MCP's 9 domains, this server has a single domain (ARM connections). A simple `configureAllTools` function wires all tools:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArmContext } from "./arm.js";
import { configureManagedApiTools } from "./tools/managedApis.js";
import { configureConnectionTools } from "./tools/connections.js";

export function configureAllTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
): void {
  configureManagedApiTools(server, tokenProvider, armContext, userAgentProvider);
  configureConnectionTools(server, tokenProvider, armContext, userAgentProvider);
}
```

### 11.2 Tool: `listManagedApis` (`src/tools/managedApis.ts`)

**Purpose:** Enumerate supported connectors for a region.

**ARM Call:**
```
GET /subscriptions/{subscriptionId}/providers/Microsoft.Web/locations/{location}/managedApis?api-version=2016-06-01
```

**Implementation:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armRequest, ArmContext } from "../arm.js";

export function configureManagedApiTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
) {
  server.tool(
    "list_managed_apis",
    "List available managed API connectors (e.g. Office 365, Teams, SQL) for the configured Azure region.",
    {
      location: z.string().optional().describe(
        "Azure region override (defaults to server's --location value)."
      ),
    },
    async ({ location }) => {
      try {
        const loc = location ?? armContext.location;
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/providers/Microsoft.Web/locations/${loc}/managedApis`;

        const result = await armRequest<{ value: unknown[] }>("GET", path, token, {
          userAgent: userAgentProvider(),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text", text: `Error listing managed APIs: ${msg}` }], isError: true };
      }
    }
  );
}
```

### 11.3 Tool: `putConnection` (`src/tools/connections.ts`)

**Purpose:** Create or update an API connection resource.

**ARM Call:**
```
PUT /subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}/providers/Microsoft.Web/connections/{connectionName}?api-version=2016-06-01
```

**Implementation:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armRequest, ArmContext } from "../arm.js";

export function configureConnectionTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string,
) {
  server.tool(
    "put_connection",
    "Create or update an Azure API connection (e.g. Office 365, Teams). Returns the connection resource.",
    {
      connectionName: z.string().describe("Name of the connection resource to create/update."),
      managedApiName: z.string().describe(
        "Managed API name from list_managed_apis (e.g. 'office365', 'teams', 'sql')."
      ),
      displayName: z.string().describe("Human-readable display name for the connection."),
      parameterValues: z.record(z.unknown()).optional().describe(
        "Connector-specific parameter values (varies per API). Pass {} for OAuth-based connectors."
      ),
      location: z.string().optional().describe(
        "Azure region override (defaults to server's --location value)."
      ),
    },
    async ({ connectionName, managedApiName, displayName, parameterValues, location }) => {
      try {
        const loc = location ?? armContext.location;
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections/${connectionName}`;

        const managedApiId = `/subscriptions/${armContext.subscriptionId}/providers/Microsoft.Web/locations/${loc}/managedApis/${managedApiName}`;

        const body = {
          location: loc,
          properties: {
            displayName,
            api: { id: managedApiId },
            parameterValues: parameterValues ?? {},
          },
        };

        const result = await armRequest<unknown>("PUT", path, token, {
          body,
          userAgent: userAgentProvider(),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text", text: `Error creating connection: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "list_connections",
    "List all API connections in the configured resource group.",
    {},
    async () => {
      try {
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections`;

        const result = await armRequest<{ value: unknown[] }>("GET", path, token, {
          userAgent: userAgentProvider(),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text", text: `Error listing connections: ${msg}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_consent_link",
    "Get an OAuth consent link for an existing connection that requires user authentication (status: Unauthenticated).",
    {
      connectionName: z.string().describe("Name of the connection to get a consent link for."),
      objectId: z.string().describe("Azure AD object ID of the user who will consent."),
      tenantId: z.string().optional().describe("Entra ID tenant ID (defaults to common)."),
    },
    async ({ connectionName, objectId, tenantId }) => {
      try {
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections/${connectionName}/listConsentLinks`;

        const body = {
          parameters: [
            {
              objectId,
              parameterName: "token",
              redirectUrl: "http://localhost:8080",
              tenantId: tenantId ?? "common",
            },
          ],
        };

        const result = await armRequest<unknown>("POST", path, token, {
          apiVersion: "2018-07-01-preview",
          body,
          userAgent: userAgentProvider(),
        });

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text", text: `Error getting consent link: ${msg}` }], isError: true };
      }
    }
  );
}
```

---

## 12. `mcp.json` — VS Code Client Configuration

```json
{
  "inputs": [
    {
      "id": "azure_subscription",
      "type": "promptString",
      "description": "Azure subscription ID"
    },
    {
      "id": "azure_rg",
      "type": "promptString",
      "description": "Azure resource group name"
    }
  ],
  "servers": {
    "armConnections": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y", "arm-connections-mcp",
        "--subscriptionId", "${input:azure_subscription}",
        "--resourceGroup", "${input:azure_rg}",
        "--location", "westus"
      ],
      "env": {
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

---

## 13. Config Files

### `.prettierrc.json`

```json
{
  "semi": true,
  "trailingComma": "es5",
  "singleQuote": false,
  "printWidth": 200,
  "tabWidth": 2,
  "useTabs": false,
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### `eslint.config.mjs`

Follow ADO MCP's pattern: `typescript-eslint` recommended + prettier integration.

### `jest.config.cjs`

```js
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
};
```

---

## 14. Structural Comparison: ADO MCP → ARM Connections MCP

| Aspect | ADO MCP | ARM Connections MCP |
|--------|---------|---------------------|
| **CLI required arg** | `<organization>` (positional) | `--subscriptionId`, `--resourceGroup` (options) |
| **CLI default option** | `--domains all` | `--location westus` |
| **Auth scopes** | `499b84ac-.../.default` (ADO) | `https://management.azure.com/.default` (ARM) |
| **Auth clientId** | `0d50963b-...` | Same (shared public client) |
| **Auth env var** | `ADO_MCP_AUTH_TOKEN` | `ARM_MCP_AUTH_TOKEN` |
| **API client** | `azure-devops-node-api` (`WebApi`) | Custom `arm.ts` (thin `fetch` wrapper) |
| **Base URL** | `https://dev.azure.com/{org}` | `https://management.azure.com` |
| **Tool domains** | 9 domains, gated by `DomainsManager` | Single domain, no gating needed |
| **Tool pattern** | `server.tool(name, desc, zodSchema, handler)` | Same pattern exactly |
| **Transport** | stdio | stdio |
| **Logging** | Winston → stderr | Winston → stderr |
| **User-Agent** | `AzureDevOps.MCP/{v}` | `ARMConnections.MCP/{v}` |
| **bin name** | `mcp-server-azuredevops` | `arm-connections-mcp` |

---

## 15. File-by-File Implementation Checklist

| # | File | Source/Approach |
|---|------|-----------------|
| 1 | `package.json` | New — follow §3 above |
| 2 | `tsconfig.json` | Copy ADO MCP — follow §4 |
| 3 | `.prettierrc.json` | Copy ADO MCP — follow §13 |
| 4 | `eslint.config.mjs` | Copy ADO MCP, remove custom tool-name rule |
| 5 | `jest.config.cjs` | Copy ADO MCP — follow §13 |
| 6 | `src/version.ts` | Auto-generated by `prebuild` — follow §9 |
| 7 | `src/logger.ts` | Copy ADO MCP verbatim — follow §8 |
| 8 | `src/useragent.ts` | Copy ADO MCP, change product name — follow §10 |
| 9 | `src/auth.ts` | Copy ADO MCP, swap scope to ARM — follow §6 |
| 10 | `src/arm.ts` | **New** — ARM fetch client — follow §7 |
| 11 | `src/tools.ts` | New (simplified) — follow §11.1 |
| 12 | `src/tools/managedApis.ts` | **New** — follow §11.2 |
| 13 | `src/tools/connections.ts` | **New** — follow §11.3 |
| 14 | `src/index.ts` | Adapt ADO MCP — follow §5 |
| 15 | `mcp.json` | New — follow §12 |
| 16 | `README.md` | New — usage docs, examples, `mcp.json` sample |

---

## 16. Validation Workflow

1. **Token test** — Run `arm-connections-mcp --subscriptionId <sub> --resourceGroup <rg> --authentication interactive` and verify an ARM token is acquired.
2. **List APIs** — Call `list_managed_apis`; verify response contains known connectors (office365, teams, sql, etc.).
3. **Create connection** — Call `put_connection` with `managedApiName: "office365"`, verify resource appears in Azure Portal.
4. **List connections** — Call `list_connections`; verify the created connection appears.
5. **Consent link** — Call `get_consent_link` for an unauthenticated connection; verify a consent URL is returned.
