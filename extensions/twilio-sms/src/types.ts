/** Parsed fields from a Twilio SMS webhook POST (URL-encoded form). */
export type TwilioSmsWebhookFields = {
  MessageSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  Body?: string;
  NumMedia?: string; // String count "0", "1", etc.
  NumSegments?: string;
  SmsStatus?: string; // "received", "sent", "delivered", etc.
  ApiVersion?: string;
  // Media fields are dynamic: MediaUrl0, MediaContentType0, MediaUrl1, etc.
  [key: string]: string | undefined;
};

/** Twilio send message API response (JSON). */
export type TwilioSmsSendResponse = {
  sid?: string;
  account_sid?: string;
  from?: string;
  to?: string;
  body?: string;
  status?: string;
  direction?: string;
  error_code?: number | null;
  error_message?: string | null;
  num_media?: string;
  num_segments?: string;
  date_created?: string;
  date_sent?: string | null;
  date_updated?: string;
  price?: string | null;
  price_unit?: string;
  uri?: string;
  subresource_uris?: {
    media?: string;
  };
};
