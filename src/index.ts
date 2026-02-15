#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createAuthenticator } from "./auth.js";
import { logger } from "./logger.js";
import { configureAllTools } from "./tools.js";
import { UserAgentComposer } from "./useragent.js";
import { packageVersion } from "./version.js";

function isGitHubCodespaceEnv(): boolean {
  return process.env.CODESPACES === "true" && !!process.env.CODESPACE_NAME;
}

const defaultAuthType = isGitHubCodespaceEnv() ? "azcli" : "interactive";

const argv = yargs(hideBin(process.argv))
  .scriptName("mcp-connections")
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

  const server = new McpServer(
    { name: "ARM Connections MCP Server", version: packageVersion },
    { capabilities: { tools: { listChanged: true } } }
  );

  const userAgentComposer = new UserAgentComposer(packageVersion);
  server.server.oninitialized = () => {
    userAgentComposer.appendMcpClientInfo(server.server.getClientVersion());
  };

  const authenticator = createAuthenticator(argv.authentication, argv.tenant);

  const armContext = {
    subscriptionId: argv.subscriptionId,
    resourceGroup: argv.resourceGroup,
    location: argv.location,
  };

  await configureAllTools(server, authenticator, armContext, () => userAgentComposer.userAgent);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  logger.error("Fatal error in main():", error);
  process.exit(1);
});
