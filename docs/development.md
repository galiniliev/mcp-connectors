# Development Guide

## Prerequisites

- Node.js (v18+)
- npm
- TypeScript

## Setup

```bash
npm install
npm run build
```

## Running Locally as an npx Tool

The `"bin"` field in `package.json` registers the CLI entry-point:

```jsonc
"bin": {
  "mcp-connections": "dist/index.js"
}
```

Make sure `dist/index.js` starts with `#!/usr/bin/env node`.

### Option 1: `npm link` (recommended for local dev)

Symlinks the package globally so `npx` can resolve it by name:

```bash
npm run build
npm link
```

Then run from anywhere:

```bash
npx mcp-connections --subscriptionId <sub> --resourceGroup <rg>
```

To unlink later:

```bash
npm unlink -g @galini-mcp/mcp-connections
```

### Option 2: Direct `node` invocation

No symlink needed — just point at the built file:

```bash
node dist/index.js --subscriptionId <sub> --resourceGroup <rg>
```

### Option 3: Publish to npm

For production use, publish the package and consume via `npx`:

```bash
npm publish --access public
npx @galini-mcp/mcp-connections --subscriptionId <sub> --resourceGroup <rg>
```

## VS Code MCP Client Configuration

Place an `mcp.json` in your project root or VS Code settings folder to register the server:

### Using npx (after `npm link` or publish)

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
        "-y", "mcp-connections",
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

### Using a direct path (no link/publish)

```json
{
  "servers": {
    "armConnections": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/dist/index.js",
        "--subscriptionId", "${input:azure_subscription}",
        "--resourceGroup", "${input:azure_rg}"
      ]
    }
  }
}
```

## Summary

| Method | Command | When to use |
|--------|---------|-------------|
| `npm link` | `npx mcp-connections ...` | Local dev — works like a published package |
| Direct `node` | `node dist/index.js ...` | Quick test, no global symlink needed |
| `npm publish` | `npx @galini-mcp/mcp-connections ...` | Production — publishes to npm registry |

## Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript and set executable permissions |
| `npm run dev` | Run directly via `tsx` (no build needed) |
| `npm run watch` | Incremental TypeScript compilation |
| `npm test` | Run Jest tests |
| `npm run inspect` | Launch MCP Inspector on `localhost:6274` |
| `npm run clean` | Remove `dist/` directory |
