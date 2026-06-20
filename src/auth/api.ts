import { resolveApiUrl } from "./resolver.js";

/**
 * Typed HTTP client for the VibeDrift Auth + Account API.
 *
 * All endpoints live on the same Fly.io app as the analyze endpoint
 * (vibedrift-api.fly.dev). Auth endpoints are unauthenticated; account
 * endpoints require a Bearer token in the Authorization header.
 */

const REQUEST_TIMEOUT_MS = 30_000;

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number; // seconds
  interval: number;   // seconds — minimum gap between polls
}

export interface DevicePollSuccess {
  status: "authorized";
  access_token: string;
  email: string;
  plan: "free" | "pro" | "enterprise";
  expires_at: string;
}

export interface DevicePollPending {
  status: "pending";
}

export interface DevicePollDenied {
  status: "denied" | "expired";
  message?: string;
}

export type DevicePollResponse = DevicePollSuccess | DevicePollPending | DevicePollDenied;

export interface ValidateResponse {
  valid: boolean;
  email?: string;
  plan?: "free" | "pro" | "enterprise";
  expires_at?: string;
}

export interface UsageResponse {
  user: {
    email: string;
    plan: "free" | "pro" | "enterprise";
  };
  current_period: {
    start: string;
    end: string;
    scans: number;
    deep_scans: number;
  };
  limits: {
    deep_scans_per_month: number | null; // null = unlimited
    rate_limit_per_min: number;
  };
  recent_scans: Array<{
    id: string;
    project_hash: string;
    score: number | null;
    is_deep: boolean;
    created_at: string;
  }>;
}

export interface PortalResponse {
  url: string;
}

export interface FeedbackResponse {
  id: string;
  received_at: string;
}

export interface CreditsResponse {
  plan: "free" | "pro" | "enterprise";
  unlimited: boolean;
  available_total: number;
  available_welcome: number;
  available_purchased: number;
  available_manual: number;
  welcome_granted: boolean;
  welcome_consumed: boolean;
  has_free_deep_scan: boolean;
}

export class VibeDriftApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "VibeDriftApiError";
  }
}

/** Internal: shared fetch helper with timeout, JSON parsing, error mapping. */
async function jsonFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json() as { detail?: string; message?: string };
        detail = body.detail ?? body.message ?? "";
      } catch {
        try { detail = await res.text(); } catch { /* ignore */ }
      }
      throw new VibeDriftApiError(res.status, detail || `HTTP ${res.status}`);
    }

    return await res.json() as T;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new VibeDriftApiError(0, `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    if (err instanceof VibeDriftApiError) throw err;
    throw new VibeDriftApiError(0, err?.message ?? String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Begin a device authorization flow. CLI calls this and prints user_code. */
export async function startDeviceAuth(opts?: { apiUrl?: string }): Promise<DeviceStartResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<DeviceStartResponse>(`${base}/auth/device`, {
    method: "POST",
    body: JSON.stringify({ client_id: "vibedrift-cli" }),
  });
}

/** Poll for device-auth completion. Server responds with pending/authorized/denied/expired. */
export async function pollDeviceAuth(deviceCode: string, opts?: { apiUrl?: string }): Promise<DevicePollResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<DevicePollResponse>(`${base}/auth/poll`, {
    method: "POST",
    body: JSON.stringify({ device_code: deviceCode }),
  });
}

/** Validate a token. Used by `vibedrift status` and `vibedrift doctor`. */
export async function validateToken(token: string, opts?: { apiUrl?: string }): Promise<ValidateResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<ValidateResponse>(`${base}/auth/validate`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Revoke the current token server-side. Called by `vibedrift logout`. */
export async function revokeToken(token: string, opts?: { apiUrl?: string }): Promise<void> {
  const base = await resolveApiUrl(opts?.apiUrl);
  await jsonFetch<{ ok: true }>(`${base}/auth/revoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Fetch usage stats for the authenticated user. */
export async function fetchUsage(token: string, opts?: { apiUrl?: string }): Promise<UsageResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<UsageResponse>(`${base}/account/usage`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/**
 * Send free-form feedback. Auth is OPTIONAL — anonymous submissions
 * are accepted by the server. When `token` is supplied we attach it so
 * the dashboard can correlate the feedback with the user's account.
 */
export async function sendFeedback(args: {
  source: "cli" | "dashboard" | "landing";
  message: string;
  token?: string;
  email?: string;
  metadata?: Record<string, unknown>;
  apiUrl?: string;
}): Promise<FeedbackResponse> {
  const base = await resolveApiUrl(args.apiUrl);
  const headers: Record<string, string> = {};
  if (args.token) headers.Authorization = `Bearer ${args.token}`;
  return jsonFetch<FeedbackResponse>(`${base}/v1/feedback/general`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: args.source,
      message: args.message,
      email: args.email,
      metadata: args.metadata,
    }),
  });
}

/** Fetch the user's credit summary (welcome + purchased + manual). */
export async function fetchCredits(token: string, opts?: { apiUrl?: string }): Promise<CreditsResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<CreditsResponse>(`${base}/account/credits`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Create a Stripe Customer Portal session and return the URL to open. */
export async function createPortalSession(token: string, opts?: { apiUrl?: string }): Promise<PortalResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<PortalResponse>(`${base}/account/portal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
