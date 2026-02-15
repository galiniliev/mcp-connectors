# MCP Server Implementation Plan

## Problem
Implement the ARM Connections MCP server as specified in `spec/mcp-server.md`. The server provides MCP tools for managing Azure API connections via ARM. Must achieve 90% test coverage.

## Approach
Implement all 16 files from the spec checklist, then write comprehensive tests for `arm.ts`, `auth.ts`, `useragent.ts`, `logger.ts`, `tools.ts`, `tools/managedApis.ts`, `tools/connections.ts`. Use subagents for parallel work.

## Todos

1. **config-files** — Create package.json, tsconfig.json, .prettierrc.json, eslint.config.mjs, jest.config.cjs
2. **core-modules** — Create src/version.ts, src/logger.ts, src/useragent.ts
3. **auth-module** — Create src/auth.ts (MSAL + Azure Identity, 4 auth modes)
4. **arm-client** — Create src/arm.ts (fetch wrapper with retry, error shaping)
5. **tools-wiring** — Create src/tools.ts, src/tools/managedApis.ts, src/tools/connections.ts
6. **entry-point** — Create src/index.ts (CLI + MCP server + stdio)
7. **mcp-json** — Create mcp.json (VS Code config example)
8. **readme** — Create README.md
9. **install-build** — npm install && npm run build (validate)
10. **tests-arm** — Tests for arm.ts (retry, error shaping, headers, query params)
11. **tests-auth** — Tests for auth.ts (all 4 modes, error cases)
12. **tests-useragent** — Tests for useragent.ts
13. **tests-tools** — Tests for tools (managedApis, connections — mock armRequest)
14. **tests-logger** — Tests for logger.ts
15. **coverage-check** — Run tests with coverage, ensure 90%+
