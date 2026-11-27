import type {
  PushAvailability,
  PushDelivery,
  PushDeliveryResult,
  PushMessage,
  PushResultError,
  PushResultMessage,
} from "./protocol.ts";
import { sendApns, type ApnsCredentials } from "./push-apns.ts";
import { parseFcmServiceAccount, sendFcm, type FcmServiceAccount } from "./push-fcm.ts";

export interface PushEnv {
  readonly APNS_KEY_P8?: string;
  readonly APNS_KEY_ID?: string;
  readonly APNS_TEAM_ID?: string;
  /** Optional comma list of bundle ids this relay will push to. */
  readonly APNS_TOPICS?: string;
  readonly FCM_SERVICE_ACCOUNT_JSON?: string;
}

export const PUSH_BUCKET_CAPACITY = 120;
const PUSH_REFILL_PER_MS = PUSH_BUCKET_CAPACITY / 60_000;
// Workers allow six simultaneous open subrequests per invocation.
const PUSH_CONCURRENCY = 6;

export function apnsCredentials(env: PushEnv): ApnsCredentials | null {
  const keyP8 = env.APNS_KEY_P8?.trim();
  const keyId = env.APNS_KEY_ID?.trim();
  const teamId = env.APNS_TEAM_ID?.trim();
  return keyP8 && keyId && teamId ? { keyP8, keyId, teamId } : null;
}

function apnsTopicAllowlist(env: PushEnv): ReadonlySet<string> | null {
  const topics = (env.APNS_TOPICS ?? "")
    .split(",")
    .map((topic) => topic.trim())
    .filter((topic) => topic.length > 0);
  return topics.length > 0 ? new Set(topics) : null;
}

export function pushAvailability(env: PushEnv): PushAvailability {
  return {
    apns: apnsCredentials(env) !== null,
    fcm: parseFcmServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON) !== null,
  };
}

/** Per-host token bucket, refilled continuously. Protects the user's APNs/FCM quotas. */
export class PushRateLimiter {
  private tokens = PUSH_BUCKET_CAPACITY;
  private updatedAtMs: number;

  constructor(nowMs: number) {
    this.updatedAtMs = nowMs;
  }

  tryTake(count: number, nowMs: number): boolean {
    const elapsed = Math.max(0, nowMs - this.updatedAtMs);
    this.tokens = Math.min(PUSH_BUCKET_CAPACITY, this.tokens + elapsed * PUSH_REFILL_PER_MS);
    this.updatedAtMs = nowMs;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}

export interface PushDeps {
  readonly env: PushEnv;
  readonly rateLimiter: PushRateLimiter;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

function failAll(message: PushMessage, error: PushResultError): PushResultMessage {
  return {
    type: "push_result",
    pushId: message.pushId,
    error,
    results: message.deliveries.map((delivery) => ({
      token: delivery.token,
      platform: delivery.platform,
      ok: false,
      reason: error,
    })),
  };
}

async function deliverOne(
  delivery: PushDelivery,
  deps: PushDeps,
  apns: ApnsCredentials | null,
  fcm: FcmServiceAccount | null,
  topics: ReadonlySet<string> | null,
): Promise<PushDeliveryResult> {
  const base = { token: delivery.token, platform: delivery.platform };
  try {
    if (delivery.platform === "apns") {
      if (!apns) return { ...base, ok: false, reason: "push_not_configured" };
      if (topics && !topics.has(delivery.topic)) {
        return { ...base, ok: false, reason: "topic_not_allowed" };
      }
      return await sendApns(delivery, apns, deps.fetch, deps.now());
    }
    if (!fcm) return { ...base, ok: false, reason: "push_not_configured" };
    return await sendFcm(delivery, fcm, deps.fetch, deps.now());
  } catch {
    return { ...base, ok: false, reason: "internal_error" };
  }
}

/** Always resolves with exactly one result per delivery, in order. */
export async function deliverPush(
  message: PushMessage,
  deps: PushDeps,
): Promise<PushResultMessage> {
  const apns = apnsCredentials(deps.env);
  const fcm = parseFcmServiceAccount(deps.env.FCM_SERVICE_ACCOUNT_JSON);
  if (!apns && !fcm) return failAll(message, "push_not_configured");
  if (!deps.rateLimiter.tryTake(message.deliveries.length, deps.now())) {
    return failAll(message, "rate_limited");
  }

  const topics = apnsTopicAllowlist(deps.env);
  const results = new Array<PushDeliveryResult>(message.deliveries.length);
  let next = 0;
  const worker = async () => {
    while (next < message.deliveries.length) {
      const index = next++;
      results[index] = await deliverOne(message.deliveries[index]!, deps, apns, fcm, topics);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PUSH_CONCURRENCY, message.deliveries.length) }, worker),
  );
  return { type: "push_result", pushId: message.pushId, results };
}

/** Counts and status codes only: tokens and payloads never reach logs. */
export function summarizePushResult(result: PushResultMessage): Record<string, unknown> {
  const statuses: Record<string, number> = {};
  let ok = 0;
  let unregistered = 0;
  for (const entry of result.results) {
    if (entry.ok) ok++;
    if (entry.unregistered) unregistered++;
    const key = `${entry.platform}:${entry.status ?? entry.reason ?? "none"}`;
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  return {
    event: "push_result",
    deliveries: result.results.length,
    ok,
    unregistered,
    statuses,
    ...(result.error ? { error: result.error } : {}),
  };
}
