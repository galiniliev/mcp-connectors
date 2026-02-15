# Dynamic Tools Implementation Plan

## Problem Statement

Extend the ARM Connections MCP server to dynamically register MCP tools from the OpenAPI schemas of connected APIs. When a user has an `office365` connection, the server should expose `office365_send_email`, `office365_get_events`, etc. — all derived at startup from the connector's Swagger/OpenAPI definition fetched from ARM.

## Approach

Implement bottom-up: pure functions first (parser, zod generator), then orchestration (dynamic tools registration, invocation), then integration (index.ts, put_connection auto-reload, meta-tools). Tests first (TDD), then implementation for each module.

## Implementation Phases

### Phase 1: OpenAPI Parser (`src/schema/openApiParser.ts`)
- Parse Swagger 2.0 `paths` into `ParsedOperation[]`
- Implement `filterOperations()`: skip internal, triggers, deprecated (keep latest revision per family), subscription endpoints
- Implement `deduplicateByFamily()` for `x-ms-api-annotation` family/revision
- Handle `$ref` resolution against `definitions`
- Parse parameters (path, query, header, body) and request body into flat properties
- Parse response schemas from 200/201 responses

### Phase 2: Zod Schema Generator (`src/schema/zodGenerator.ts`)
- Convert `ParsedOperation` params + body → `Record<string, ZodTypeAny>`
- Skip `connectionId` parameter (injected at runtime)
- Handle types: string, integer, boolean, array, object, enums, defaults
- Flatten body properties; prefix with `body_` on name collision
- Handle nested objects → accept as JSON strings

### Phase 3: Dynamic Tools Registration & Invocation (`src/tools/dynamicTools.ts`)
- `fetchApiSchema()` with in-memory cache
- `buildToolName()` — snake_case conversion, API prefix
- `buildToolDescription()` — display name + summary + auth warning
- `registerDynamicTools()` — list connections → fetch schemas → parse → filter → register
- `registerToolsForConnection()` — incremental for single new connection + `sendToolListChanged`
- `invokeDynamicTool()` — build `dynamicInvoke` POST body from params, path substitution, query params, body
- Tool registry (`Map<string, DynamicToolContext>`)
- Schema cache with `clearSchemaCache()`

### Phase 4: Meta-Tools (`src/tools/metaTools.ts`)
- `list_dynamic_tools` — enumerate registry
- `refresh_tools` — clear cache, re-scan connections, re-register

### Phase 5: Integration
- Rename existing `src/tools/connections.ts` + `managedApis.ts` to static tools pattern
- Update `src/tools.ts` → call `registerDynamicTools()` and `configureMetaTools()`
- Update `src/index.ts` — add `tools: { listChanged: true }` capability
- Update `put_connection` to call `registerToolsForConnection()` on success

### Phase 6: Test Fixtures
- Copy `spec/ARM-Calls/office365-schema.json` and `teams-schema.json` to `test/fixtures/`

## File Map

| # | File | Purpose |
|---|------|---------|
| 1 | `src/schema/openApiParser.ts` | Parse Swagger 2.0 → `ParsedOperation[]` |
| 2 | `src/schema/zodGenerator.ts` | `ParsedOperation` → Zod schemas |
| 3 | `src/tools/dynamicTools.ts` | Registration + invocation engine |
| 4 | `src/tools/metaTools.ts` | `list_dynamic_tools` + `refresh_tools` |
| 5 | `src/tools.ts` | Updated orchestrator |
| 6 | `src/index.ts` | Startup with dynamic tools + listChanged capability |
| 7 | `test/schema/openApiParser.test.ts` | Parser unit tests |
| 8 | `test/schema/zodGenerator.test.ts` | Zod generation tests |
| 9 | `test/tools/dynamicTools.test.ts` | Registration + invocation tests |
| 10 | `test/fixtures/` | Schema fixtures |

## Notes
- Test-first approach: write tests before implementation for each phase
- Use existing mock patterns from `test/tools.test.ts`
- Keep existing static tools working — no breaking changes
- All new files use ESM with `.js` extensions in imports
