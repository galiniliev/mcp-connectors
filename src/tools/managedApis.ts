import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armRequest, ArmContext } from "../arm.js";

interface ManagedApiEntry {
  name: string;
  properties?: {
    connectionParameters?: {
      token?: {
        oAuthSettings?: {
          properties?: {
            IsFirstParty?: string;
          };
        };
      };
    };
  };
}

/** Returns true if the managed API entry is a Microsoft first-party connector. */
function isMicrosoftApi(api: ManagedApiEntry): boolean {
  return api.properties?.connectionParameters?.token?.oAuthSettings?.properties?.IsFirstParty === "True";
}

export function configureManagedApiTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
) {
  server.tool(
    "list_managed_apis",
    "List available managed API connector names for the configured Azure region. By default returns only Microsoft first-party connectors; set microsoftOnly to false to include all.",
    {
      location: z.string().optional().describe("Azure region override (defaults to server's --location value)."),
      microsoftOnly: z.boolean().optional().describe("When true (default), return only Microsoft first-party connectors."),
    },
    async ({ location, microsoftOnly }) => {
      try {
        const loc = location ?? armContext.location;
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/providers/Microsoft.Web/locations/${loc}/managedApis`;

        const result = await armRequest<{ value: ManagedApiEntry[] }>("GET", path, token, {
          userAgent: userAgentProvider(),
        });

        const filterMicrosoft = microsoftOnly !== false;
        const apis = filterMicrosoft ? result.value.filter(isMicrosoftApi) : result.value;
        const names = apis.map((api) => api.name);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(names, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text" as const, text: `Error listing managed APIs: ${msg}` }], isError: true as const };
      }
    }
  );
}
