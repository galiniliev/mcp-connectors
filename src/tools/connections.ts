import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { armRequest, ArmContext } from "../arm.js";
import { registerToolsForConnection } from "./dynamicTools.js";
import { logger } from "../logger.js";

export function configureConnectionTools(
  server: McpServer,
  tokenProvider: () => Promise<string>,
  armContext: ArmContext,
  userAgentProvider: () => string
) {
  server.tool(
    "put_connection",
    "Create or update an Azure API connection (e.g. Office 365, Teams). Returns the connection resource.",
    {
      connectionName: z.string().describe("Name of the connection resource to create/update."),
      managedApiName: z.string().describe("Managed API name from list_managed_apis (e.g. 'office365', 'teams', 'sql')."),
      displayName: z.string().describe("Human-readable display name for the connection."),
      parameterValues: z.record(z.string(), z.unknown()).optional().describe("Connector-specific parameter values (varies per API). Pass {} for OAuth-based connectors."),
      location: z.string().optional().describe("Azure region override (defaults to server's --location value)."),
    },
    async ({ connectionName, managedApiName, displayName, parameterValues, location }) => {
      try {
        const loc = location ?? armContext.location;
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections/${connectionName}`;

        const managedApiId = `/subscriptions/${armContext.subscriptionId}/providers/Microsoft.Web/locations/${loc}/managedApis/${managedApiName}`;

        const body = {
          location: loc,
          properties: {
            displayName,
            api: { id: managedApiId },
            parameterValues: parameterValues ?? {},
          },
        };

        const result = await armRequest<unknown>("PUT", path, token, {
          body,
          userAgent: userAgentProvider(),
        });

        // Auto-register dynamic tools for the new API
        let toolStats = { registered: 0, skipped: 0, errors: 0 };
        try {
          toolStats = await registerToolsForConnection(
            server, result, tokenProvider, armContext, userAgentProvider
          );
        } catch (toolError) {
          logger.warn(`Auto-registration failed for ${connectionName}`, { toolError });
        }

        const response: Record<string, unknown> = {
          connection: result,
        };
        if (toolStats.registered > 0) {
          response.dynamicTools = {
            message: `${toolStats.registered} new tools registered for ${managedApiName}`,
            registered: toolStats.registered,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text" as const, text: `Error creating connection: ${msg}` }], isError: true as const };
      }
    }
  );

  server.tool(
    "list_connections",
    "List all API connections in the configured resource group.",
    {},
    async () => {
      try {
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections`;

        const result = await armRequest<{ value: unknown[] }>("GET", path, token, {
          userAgent: userAgentProvider(),
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text" as const, text: `Error listing connections: ${msg}` }], isError: true as const };
      }
    }
  );

  server.tool(
    "get_consent_link",
    "Get an OAuth consent link for an existing connection that requires user authentication (status: Unauthenticated).",
    {
      connectionName: z.string().describe("Name of the connection to get a consent link for."),
      objectId: z.string().describe("Azure AD object ID of the user who will consent."),
      tenantId: z.string().optional().describe("Entra ID tenant ID (defaults to common)."),
    },
    async ({ connectionName, objectId, tenantId }) => {
      try {
        const token = await tokenProvider();
        const path = `/subscriptions/${armContext.subscriptionId}/resourceGroups/${armContext.resourceGroup}/providers/Microsoft.Web/connections/${connectionName}/listConsentLinks`;

        const body = {
          parameters: [
            {
              objectId,
              parameterName: "token",
              redirectUrl: "http://localhost:8080",
              tenantId: tenantId ?? "common",
            },
          ],
        };

        const result = await armRequest<unknown>("POST", path, token, {
          apiVersion: "2018-07-01-preview",
          body,
          userAgent: userAgentProvider(),
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        return { content: [{ type: "text" as const, text: `Error getting consent link: ${msg}` }], isError: true as const };
      }
    }
  );
}
