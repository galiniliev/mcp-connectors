import { logger } from "./logger.js";
import { randomUUID } from "crypto";

const ARM_BASE_URL = "https://management.azure.com";
const DEFAULT_API_VERSION = "2016-06-01";
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 30000;

export interface ArmContext {
  subscriptionId: string;
  resourceGroup: string;
  location: string;
}

export class ArmError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "ArmError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number, retryAfterHeader?: string | null): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  // Exponential backoff with jitter: 1s, 2s, 4s base + random jitter
  const baseDelay = Math.pow(2, attempt) * 1000;
  const jitter = Math.random() * 1000;
  return baseDelay + jitter;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function armRequest<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  token: string,
  options?: {
    apiVersion?: string;
    query?: Record<string, string>;
    body?: unknown;
    userAgent?: string;
  }
): Promise<T> {
  const apiVersion = options?.apiVersion ?? DEFAULT_API_VERSION;
  const correlationId = randomUUID();

  const url = new URL(path, ARM_BASE_URL);
  url.searchParams.set("api-version", apiVersion);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-ms-correlation-request-id": correlationId,
  };

  if (options?.userAgent) {
    headers["User-Agent"] = options.userAgent;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };

  if (options?.body && (method === "PUT" || method === "POST")) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.debug(`ARM ${method} ${url.pathname}`, { attempt, correlationId });

      const response = await fetch(url.toString(), fetchOptions);

      if (response.ok) {
        const text = await response.text();
        if (!text) return {} as T;
        return JSON.parse(text) as T;
      }

      if (isRetryable(response.status) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, response.headers.get("Retry-After"));
        logger.warn(`ARM request returned ${response.status}, retrying in ${delay}ms`, {
          attempt,
          correlationId,
        });
        await sleep(delay);
        continue;
      }

      // Parse ARM error envelope
      let errorCode = "UnknownError";
      let errorMessage = `ARM request failed with status ${response.status}`;
      try {
        const errorBody = await response.json() as { error?: { code?: string; message?: string } };
        if (errorBody?.error) {
          errorCode = errorBody.error.code ?? errorCode;
          errorMessage = errorBody.error.message ?? errorMessage;
        }
      } catch {
        // Ignore JSON parse errors for error body
      }

      throw new ArmError(errorCode, errorMessage, response.status);
    } catch (error) {
      if (error instanceof ArmError) throw error;

      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt);
        logger.warn(`ARM request failed with error, retrying in ${delay}ms`, {
          attempt,
          correlationId,
          error: lastError.message,
        });
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError ?? new Error("ARM request failed after retries");
}
