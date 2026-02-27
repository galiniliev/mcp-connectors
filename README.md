# ARM Connections MCP Server

An MCP (Model Context Protocol) server for managing Azure API connections via Azure Resource Manager (ARM).

[Azure connectors](https://learn.microsoft.com/en-us/connectors/) provide a way to access data, services, and actions across hundreds of Microsoft and third-party applications — including Office 365, Teams, SQL Server, and more. This server exposes those connector management capabilities as MCP tools, enabling AI assistants to create, configure, and authenticate API connections on your behalf.

## Features

- **List Managed APIs** — Enumerate available API connectors (Office 365, Teams, SQL, etc.) for a region
- **Create/Update Connections** — Provision API connection resources in your resource group
- **List Connections** — View all API connections in a resource group
- **Get Consent Links** — Generate OAuth consent URLs for connections requiring user authentication

## Prerequisites

- Node.js 18+
- An Azure subscription with a resource group
- Appropriate RBAC permissions (Contributor on the resource group)

## Installation

```bash
npm install
npm run build
```

## Usage

### Direct execution

```bash
node dist/index.js --subscriptionId <sub-id> --resourceGroup <rg-name>
```

### Via npx (after `npm link`)

```bash
npm link
npx mcp-connections --subscriptionId <sub-id> --resourceGroup <rg-name>
```

### CLI Options

| Option | Alias | Required | Default | Description |
|--------|-------|----------|---------|-------------|
| `--subscriptionId` | `-s` | Yes | — | Azure subscription ID |
| `--resourceGroup` | `-g` | Yes | — | Azure resource group name |
| `--location` | `-l` | No | `westus` | Azure region |
| `--authentication` | `-a` | No | `interactive` | Auth mode: `interactive`, `azcli`, `env`, `envvar` |
| `--tenant` | `-t` | No | — | Entra ID tenant ID |

### Authentication Modes

| Mode | Description |
|------|-------------|
| `interactive` | Browser-based MSAL OAuth login (default) |
| `azcli` | Azure CLI credential (auto-detected in Codespaces) |
| `env` | `DefaultAzureCredential` (respects env vars) |
| `envvar` | Raw token from `ARM_MCP_AUTH_TOKEN` env var |

## VS Code MCP Configuration

Add to your project's `mcp.json`:

```json
{
  "inputs": [
    { "id": "azure_subscription", "type": "promptString", "description": "Azure subscription ID" },
    { "id": "azure_rg", "type": "promptString", "description": "Azure resource group name" }
  ],
  "servers": {
    "armConnections": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@galin.iliev/mcp-connections", "--subscriptionId", "${input:azure_subscription}", "--resourceGroup", "${input:azure_rg}"],
      "env": { "LOG_LEVEL": "debug" }
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_managed_apis` | List available managed API connectors for a region |
| `put_connection` | Create or update an API connection resource |
| `list_connections` | List all API connections in the resource group |
| `get_consent_link` | Get an OAuth consent link for a connection |

## Development

```bash
npm run dev          # Run with tsx (no build needed)
npm run build        # Compile TypeScript
npm run watch        # Incremental compilation
npm test             # Run tests with coverage
npm run inspect      # Launch MCP Inspector
```

## License

MIT
