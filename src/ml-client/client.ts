import type { MlAnalyzeRequest, MlAnalyzeResponse } from "./types.js";

const DEFAULT_API_URL = "https://vibedrift-api.fly.dev";
const TIMEOUT_MS = 90_000; // 90s to handle cold starts with model loading

/**
 * Call the VibeDrift deep-analysis API.
 *
 * Authenticates with a Bearer token from the user's `vibedrift login`
 * session (stored at ~/.vibedrift/config.json or in VIBEDRIFT_TOKEN).
 */
export async function callMlApi(
  request: MlAnalyzeRequest,
  token?: string,
  apiUrl?: string,
): Promise<MlAnalyzeResponse> {
  const url = `${apiUrl ?? DEFAULT_API_URL}/v1/analyze`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`Deep-analysis API error ${response.status}: ${errorBody.slice(0, 200)}`);
    }

    return (await response.json()) as MlAnalyzeResponse;
  } finally {
    clearTimeout(timeout);
  }
}
