# Copilot Instructions for mcp-connectors

## What This Repo Is

An MCP (Model Context Protocol) server for managing Azure API connections via ARM (Azure Resource Manager). It mirrors the architecture and auth patterns of [microsoft/azure-devops-mcp](https://github.com/microsoft/azure-devops-mcp) but targets ARM endpoints instead of Azure DevOps.

## Folder Structure

- `src/` — All source code
- `tests/` — All test files
- `spec/` — Specifications and reference ARM response samples (`spec/ARM-Calls/`)
- `docs/` — Documentation

## Architecture

- **Transport:** stdio (MCP protocol on stdout, logging on stderr via Winston)
- **Auth (`src/auth.ts`):** Reuses the ADO MCP public clientId (`0d50963b-7bb9-4fe7-94c7-a99af00b5136`) with scope `https://management.azure.com/.default`. Four modes: `interactive` (MSAL browser OAuth), `azcli` (AzureCliCredential), `env` (DefaultAzureCredential), `envvar` (raw token from `ARM_MCP_AUTH_TOKEN`)
- **ARM client (`src/arm.ts`):** Thin `fetch` wrapper against `https://management.azure.com` with retry (429/5xx), error shaping, default api-version `2016-06-01`
- **CLI (`src/index.ts`):** yargs-based. Required: `--subscriptionId`, `--resourceGroup`. Default: `--location westus`
- **Tools (`src/tools/`):** Each file exports a `configure*Tools(server, tokenProvider, armContext, userAgentProvider)` function that registers tools via `server.tool(name, description, zodSchema, handler)`
- **`ArmContext`:** `{ subscriptionId, resourceGroup, location }` — parsed from CLI args, threaded to all tools so they don't re-ask for these values

## Key Conventions

- **ESM throughout:** `"type": "module"` in package.json, `.js` extensions in all imports
- **Tool naming:** snake_case (e.g. `list_managed_apis`, `put_connection`, `list_connections`)
- **Tool handler pattern:** Always wrap in try/catch, return `{ content: [{ type: "text", text: JSON.stringify(...) }] }` on success, add `isError: true` on failure
- **Token provider pattern:** Auth returns `() => Promise<string>`, threaded through all tool configurators — never store tokens, always call the provider fresh
- **version.ts is auto-generated:** The `prebuild` script creates it from `package.json` version. Never edit manually
- **Logging goes to stderr only** — stdout is reserved for the MCP stdio protocol

## ARM API Reference

All calls use `api-version=2016-06-01` unless noted:

| Tool | Method | ARM Path |
|------|--------|----------|
| `list_managed_apis` | GET | `/subscriptions/{sub}/providers/Microsoft.Web/locations/{loc}/managedApis` |
| `put_connection` | PUT | `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/connections/{name}` |
| `list_connections` | GET | `/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Web/connections` |
| `get_consent_link` | POST | `.../connections/{name}/listConsentLinks` (api-version `2018-07-01-preview`) |

## Build & Run

```bash
npm run build          # tsc + chmod
npm run dev            # tsx src/index.ts (dev mode)
npm run watch          # tsc --watch
npm test               # jest
npm run inspect        # MCP Inspector on localhost:6274
```

Run a single test:
```bash
npx jest tests/arm.test.ts
npx jest --testNamePattern "should retry on 429"
```
