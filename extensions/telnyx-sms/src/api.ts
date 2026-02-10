import type { ResolvedTelnyxSmsAccount } from "./accounts.js";
import type { TelnyxSmsSendResponse } from "./types.js";

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

export async function sendTelnyxSms(params: {
  account: ResolvedTelnyxSmsAccount;
  to: string;
  text?: string;
  mediaUrls?: string[];
}): Promise<TelnyxSmsSendResponse> {
  const { account, to, text, mediaUrls } = params;
  if (!account.apiKey) {
    throw new Error("Telnyx API key is not configured.");
  }
  if (!account.phoneNumber) {
    throw new Error("Telnyx phone number is not configured.");
  }

  const body: Record<string, unknown> = {
    from: account.phoneNumber,
    to,
    text: text ?? "",
  };

  if (mediaUrls && mediaUrls.length > 0) {
    body.media_urls = mediaUrls;
    body.type = "MMS";
  }

  const response = await fetch(`${TELNYX_API_BASE}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telnyx API error: ${response.status} ${errorText}`);
  }

  return (await response.json()) as TelnyxSmsSendResponse;
}

export async function probeTelnyxSms(account: ResolvedTelnyxSmsAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  if (!account.apiKey) {
    return { ok: false, error: "API key not configured" };
  }

  try {
    const response = await fetch(`${TELNYX_API_BASE}/messaging_profiles`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
