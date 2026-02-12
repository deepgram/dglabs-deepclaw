import type { ResolvedTwilioSmsAccount } from "./accounts.js";
import type { TwilioSmsSendResponse } from "./types.js";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

async function sendSmsViaProxy(params: {
  proxyUrl: string;
  from?: string;
  to: string;
  text?: string;
  mediaUrls?: string[];
}): Promise<TwilioSmsSendResponse> {
  const { proxyUrl, from, to, text, mediaUrls } = params;
  const body = { from, to, text, mediaUrls };

  console.log(
    `[twilio-sms] Sending SMS via proxy to=${to} from=${from ?? "unknown"} bodyLen=${(text ?? "").length}`,
  );

  const response = await fetch(proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SMS proxy error: ${response.status} ${errorText}`);
  }

  return (await response.json()) as TwilioSmsSendResponse;
}

export async function sendTwilioSms(params: {
  account: ResolvedTwilioSmsAccount;
  to: string;
  text?: string;
  mediaUrls?: string[];
}): Promise<TwilioSmsSendResponse> {
  const { account, to, text, mediaUrls } = params;

  // Proxy mode: no Twilio credentials, but proxy URL is available
  if (!account.accountSid && account.proxyUrl) {
    return sendSmsViaProxy({
      proxyUrl: account.proxyUrl,
      from: account.phoneNumber,
      to,
      text,
      mediaUrls,
    });
  }

  if (!account.accountSid) {
    throw new Error("Twilio Account SID is not configured.");
  }
  if (!account.authToken) {
    throw new Error("Twilio Auth Token is not configured.");
  }
  if (!account.phoneNumber) {
    throw new Error("Twilio phone number is not configured.");
  }

  const formParams = new URLSearchParams();
  formParams.append("From", account.phoneNumber);
  formParams.append("To", to);
  formParams.append("Body", text ?? "");

  if (mediaUrls && mediaUrls.length > 0) {
    for (const url of mediaUrls) {
      formParams.append("MediaUrl", url);
    }
  }

  const credentials = Buffer.from(`${account.accountSid}:${account.authToken}`).toString("base64");

  const hasMedia = mediaUrls && mediaUrls.length > 0;
  console.log(
    `[twilio-sms] Sending SMS to=${to} from=${account.phoneNumber} bodyLen=${(text ?? "").length}${hasMedia ? ` mediaUrls=${mediaUrls.length}` : ""}`,
  );

  const response = await fetch(`${TWILIO_API_BASE}/Accounts/${account.accountSid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formParams.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[twilio-sms] SMS failed to=${to} status=${response.status} error=${errorText}`);
    throw new Error(`Twilio API error: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as TwilioSmsSendResponse;
  console.log(`[twilio-sms] SMS sent sid=${result.sid} to=${to} status=${result.status}`);
  return result;
}

export async function probeTwilioSms(account: ResolvedTwilioSmsAccount): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  if (!account.accountSid || !account.authToken) {
    return { ok: false, error: "Account SID or Auth Token not configured" };
  }

  try {
    const credentials = Buffer.from(`${account.accountSid}:${account.authToken}`).toString(
      "base64",
    );

    const response = await fetch(`${TWILIO_API_BASE}/Accounts/${account.accountSid}.json`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
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
