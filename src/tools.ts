import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArmContext } from "./arm.js";
import { configureManagedApiTools } from "./tools/managedApis.js";
import { configureConnectionTools } from "./tools/connections.js";
import { registerDynamicTools } from "./tools/dynamicTools.js";
import { configureMetaTools } from "./tools/metaTools.js";
import { logger } from "./logger.js";

export function configureStaticTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
): void {
  configureManagedApiTools(server, tokenProvider, armContext, userAgentProvider);
  configureConnectionTools(server, tokenProvider, armContext, userAgentProvider);
}

export async function configureAllTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
): Promise<void> {
  configureStaticTools(server, tokenProvider, armContext, userAgentProvider);

  // Register dynamic tools from connected APIs
  try {
    const result = await registerDynamicTools(
      server, tokenProvider, armContext, userAgentProvider
    );
    logger.info("Dynamic tools registered", result);
  } catch (error) {
    logger.warn("Dynamic tool registration failed, continuing with static tools only", { error });
  }

  // Register meta-tools (list_dynamic_tools, refresh_tools)
  configureMetaTools(server, tokenProvider, armContext, userAgentProvider);
}
