import { PublicClientApplication, AccountInfo } from "@azure/msal-node";
import { AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential } from "@azure/identity";
import open from "open";
import { logger } from "./logger.js";

const scopes = ["https://management.azure.com/.default"];
const clientId = "0d50963b-7bb9-4fe7-94c7-a99af00b5136";
const defaultAuthority = "https://login.microsoftonline.com/common";

export type AuthType = "interactive" | "azcli" | "env" | "envvar";

class OAuthAuthenticator {
  private accountId: AccountInfo | null = null;
  private publicClientApp: PublicClientApplication;

  constructor(tenantId?: string) {
    const authority =
      tenantId && tenantId !== "00000000-0000-0000-0000-000000000000"
        ? `https://login.microsoftonline.com/${tenantId}`
        : defaultAuthority;

    this.publicClientApp = new PublicClientApplication({
      auth: { clientId, authority },
    });
  }

  async getToken(): Promise<string> {
    // Try silent acquisition first
    if (this.accountId) {
      try {
        const silentResult = await this.publicClientApp.acquireTokenSilent({
          scopes,
          account: this.accountId,
        });
        if (silentResult?.accessToken) {
          return silentResult.accessToken;
        }
      } catch {
        logger.debug("Silent token acquisition failed, falling back to interactive");
      }
    }

    // Fall back to interactive (device code flow for CLI)
    const result = await this.publicClientApp.acquireTokenInteractive({
      scopes,
      openBrowser: async (url: string) => {
        await open(url);
      },
    });

    if (!result?.accessToken) {
      throw new Error("Failed to acquire token interactively");
    }

    this.accountId = result.account;
    return result.accessToken;
  }
}

export function createAuthenticator(type: string, tenantId?: string): () => Promise<string> {
  switch (type) {
    case "interactive": {
      const auth = new OAuthAuthenticator(tenantId);
      return () => auth.getToken();
    }

    case "azcli": {
      process.env.AZURE_TOKEN_CREDENTIALS = "dev";
      const credential = new ChainedTokenCredential(
        new AzureCliCredential(),
        new DefaultAzureCredential()
      );
      return async () => {
        const tokenResponse = await credential.getToken(scopes[0]);
        if (!tokenResponse?.token) {
          throw new Error("Failed to acquire token via Azure CLI");
        }
        return tokenResponse.token;
      };
    }

    case "env": {
      const credential = new DefaultAzureCredential();
      return async () => {
        const tokenResponse = await credential.getToken(scopes[0]);
        if (!tokenResponse?.token) {
          throw new Error("Failed to acquire token via DefaultAzureCredential");
        }
        return tokenResponse.token;
      };
    }

    case "envvar": {
      return async () => {
        const token = process.env.ARM_MCP_AUTH_TOKEN;
        if (!token) {
          throw new Error("ARM_MCP_AUTH_TOKEN environment variable is not set");
        }
        return token;
      };
    }

    default:
      throw new Error(`Unknown authentication type: ${type}`);
  }
}
