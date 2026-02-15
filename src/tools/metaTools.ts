import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArmContext } from "../arm.js";
import { getToolRegistry, clearSchemaCache, registerDynamicTools } from "./dynamicTools.js";
import { logger } from "../logger.js";

export function configureMetaTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
): void {
  // list_dynamic_tools — enumerate all dynamically registered tools
  server.tool(
    "list_dynamic_tools",
    "List all dynamically registered tools from connected APIs.",
    {},
    async () => {
      const registry = getToolRegistry();
      const tools = Array.from(registry.entries()).map(([name, ctx]) => ({
        tool: name,
        api: ctx.connection.apiName,
        displayName: ctx.connection.displayName,
        status: ctx.connection.status,
        operationId: ctx.operation.operationId,
        method: ctx.operation.method.toUpperCase(),
        summary: ctx.operation.summary,
      }));

      return {
        content: [{ type: "text" as const, text: JSON.stringify(tools, null, 2) }],
      };
    }
  );

  // refresh_tools — clear cache, re-scan connections, re-register
  server.tool(
    "refresh_tools",
    "Refresh dynamic tools by re-scanning connections and their API schemas. Registers new tools found.",
    {},
    async () => {
      try {
        clearSchemaCache();
        const result = await registerDynamicTools(server, tokenProvider, armContext, userAgentProvider);
        return {
          content: [{
            type: "text" as const,
            text: `Refresh complete. Registered: ${result.registered}, Skipped: ${result.skipped}, Errors: ${result.errors}`,
          }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        logger.error(`Error refreshing tools: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error refreshing tools: ${msg}` }],
          isError: true as const,
        };
      }
    }
  );
}
