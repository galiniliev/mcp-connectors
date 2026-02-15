import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArmContext } from "./arm.js";
import { configureManagedApiTools } from "./tools/managedApis.js";
import { configureConnectionTools } from "./tools/connections.js";

export function configureAllTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
): void {
  configureManagedApiTools(server, tokenProvider, armContext, userAgentProvider);
  configureConnectionTools(server, tokenProvider, armContext, userAgentProvider);
}
