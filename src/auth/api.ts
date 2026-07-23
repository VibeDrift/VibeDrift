import { resolveApiUrl } from "./resolver.js";
import type { UploadEvent } from "../session/upload-schema.js";

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

/** Internal: shared fetch helper with timeout, JSON parsing, error mapping.
 *  `timeoutMs` overrides the default for best-effort, latency-sensitive calls
 *  (e.g. a cosmetic banner) that must not stall the command if the API is slow. */
async function jsonFetch<T>(url: string, init: RequestInit = {}, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new VibeDriftApiError(0, `Request timed out after ${timeoutMs / 1000}s`);
    }
    if (err instanceof VibeDriftApiError) throw err;
    throw new VibeDriftApiError(0, err instanceof Error ? err.message : String(err));
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

export interface SessionEntitlementResponse {
  entitled: boolean;
  plan: "free" | "pro" | "enterprise";
  trial_used: number;
  trial_limit: number;
}

/** Drift Sessions entitlement for the account (Pro or trial-remaining). */
export async function fetchSessionEntitlement(
  token: string,
  opts?: { apiUrl?: string },
): Promise<SessionEntitlementResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<SessionEntitlementResponse>(`${base}/v1/sessions/entitlement`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Count a watched session against the trial. The server dedups by session_id,
 *  so reinstalls / rapid restarts of the same session never double-count. */
export async function consumeSessionTrial(
  token: string,
  sessionId: string,
  opts?: { apiUrl?: string },
): Promise<SessionEntitlementResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<SessionEntitlementResponse>(`${base}/v1/sessions/consume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

export interface SessionIngestResponse {
  accepted: number;
}

/** Upload a batch of DERIVED-ONLY session events (Phase 5). Only invoked by the
 *  uploader when the user opted into hosted sync and is logged in. The wire
 *  carries `UploadEvent`s (findings/scores/outcomes/metadata) — never prompts or
 *  code; the server re-validates derived-only as defense in depth. Shorter
 *  timeout: a stalled upload must not wedge the resident watcher. */
export async function postSessionIngest(
  token: string,
  events: UploadEvent[],
  opts?: { apiUrl?: string; timeoutMs?: number },
): Promise<SessionIngestResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<SessionIngestResponse>(
    `${base}/v1/sessions/ingest`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    },
    opts?.timeoutMs ?? 15_000,
  );
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

/** Fetch the user's credit summary (welcome + purchased + manual).
 *  `timeoutMs` lets a caller cap the wait — the pre-scan banner uses a short
 *  one so a slow API never delays the scan from starting. */
export async function fetchCredits(token: string, opts?: { apiUrl?: string; timeoutMs?: number }): Promise<CreditsResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<CreditsResponse>(`${base}/account/credits`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }, opts?.timeoutMs);
}

/** Create a Stripe Customer Portal session and return the URL to open. */
export async function createPortalSession(token: string, opts?: { apiUrl?: string }): Promise<PortalResponse> {
  const base = await resolveApiUrl(opts?.apiUrl);
  return jsonFetch<PortalResponse>(`${base}/account/portal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
