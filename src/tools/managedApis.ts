import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armRequest, ArmContext } from "../arm.js";

export function configureManagedApiTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
) {
  server.tool(
    "list_managed_apis",
    "List available managed API connectors (e.g. Office 365, Teams, SQL) for the configured Azure region.",
    {
      location: z.string().optional().describe("Azure region override (defaults to server's --location value)."),
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
          content: [{ type: "text" as const, text: JSON.stringify(result.value, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text" as const, text: `Error listing managed APIs: ${msg}` }], isError: true as const };
      }
    }
  );
}
