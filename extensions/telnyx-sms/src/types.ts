/** Telnyx webhook event wrapper. */
export type TelnyxSmsWebhookEvent = {
  data?: {
    event_type?: string;
    id?: string;
    occurred_at?: string;
    payload?: TelnyxSmsMessagePayload;
    record_type?: string;
  };
  meta?: {
    attempt?: number;
    delivered_to?: string;
  };
};

/** Inbound SMS/MMS message payload from Telnyx webhook. */
export type TelnyxSmsMessagePayload = {
  id?: string;
  direction?: string;
  type?: string;
  from?: { phone_number?: string; carrier?: string; line_type?: string };
  to?: Array<{ phone_number?: string; status?: string }>;
  text?: string;
  media?: TelnyxSmsMedia[];
  completed_at?: string;
  sent_at?: string;
  received_at?: string;
  messaging_profile_id?: string;
  parts?: number;
  cost?: { amount?: string; currency?: string };
};

/** Media attachment in a Telnyx MMS message. */
export type TelnyxSmsMedia = {
  url?: string;
  content_type?: string;
  size?: number;
  hash_sha256?: string;
};

/** Request body for sending a Telnyx SMS/MMS. */
export type TelnyxSmsSendRequest = {
  from: string;
  to: string;
  text?: string;
  media_urls?: string[];
  messaging_profile_id?: string;
  type?: "SMS" | "MMS";
};

/** Telnyx send message API response. */
export type TelnyxSmsSendResponse = {
  data?: {
    id?: string;
    record_type?: string;
    direction?: string;
    from?: { phone_number?: string };
    to?: Array<{ phone_number?: string; status?: string }>;
    text?: string;
    media?: TelnyxSmsMedia[];
    type?: string;
    parts?: number;
  };
};
