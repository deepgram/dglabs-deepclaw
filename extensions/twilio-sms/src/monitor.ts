import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { createReplyPrefixOptions, normalizeE164 } from "openclaw/plugin-sdk";
import type { ResolvedTwilioSmsAccount } from "./accounts.js";
import type { TwilioSmsWebhookFields } from "./types.js";
import { sendTwilioSms } from "./api.js";
import { getTwilioSmsRuntime } from "./runtime.js";

export type TwilioSmsRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type TwilioSmsMonitorOptions = {
  account: ResolvedTwilioSmsAccount;
  config: OpenClawConfig;
  runtime: TwilioSmsRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type TwilioSmsCoreRuntime = ReturnType<typeof getTwilioSmsRuntime>;

type WebhookTarget = {
  account: ResolvedTwilioSmsAccount;
  config: OpenClawConfig;
  runtime: TwilioSmsRuntimeEnv;
  core: TwilioSmsCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: TwilioSmsCoreRuntime, runtime: TwilioSmsRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[twilio-sms] ${message}`);
  }
}

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "/";
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

function resolveWebhookPath(webhookPath?: string): string {
  const trimmedPath = webhookPath?.trim();
  if (trimmedPath) {
    return normalizeWebhookPath(trimmedPath);
  }
  return "/twilio-sms";
}

function registerWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

function verifyTwilioWebhook(params: {
  authToken: string | undefined;
  signature: string | undefined;
  url: string;
  body: Record<string, string>;
}): { ok: boolean; reason?: string } {
  const { authToken, signature, url, body } = params;

  if (!authToken) {
    return { ok: true, reason: "verification skipped (no auth token)" };
  }

  if (!signature) {
    return { ok: false, reason: "Missing X-Twilio-Signature header" };
  }

  try {
    // Twilio signature algorithm:
    // 1. Start with the full webhook URL
    // 2. Sort POST params alphabetically by key
    // 3. Append each key+value (no separator)
    // 4. HMAC-SHA1 with authToken as key
    // 5. Base64 encode result
    const sortedKeys = Object.keys(body).sort();
    let data = url;
    for (const key of sortedKeys) {
      data += key + (body[key] ?? "");
    }

    const expected = crypto.createHmac("sha1", authToken).update(data, "utf8").digest("base64");

    if (expected !== signature) {
      return { ok: false, reason: "Invalid signature" };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<string | null>((resolve) => {
    let resolved = false;
    const doResolve = (value: string | null) => {
      if (resolved) {
        return;
      }
      resolved = true;
      req.removeAllListeners();
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        doResolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      doResolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", () => {
      doResolve(null);
    });
  });
}

function resolveWebhookUrl(req: IncomingMessage): string {
  // Reconstruct the full URL that Twilio used to call us.
  // Prefer X-Forwarded headers when behind a reverse proxy.
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  const url = req.url ?? "/";
  return `${proto}://${host}${url}`;
}

export async function handleTwilioSmsWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  console.log(`[twilio-sms] webhook hit: ${req.method} ${url.pathname} (normalized: ${path})`);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    console.log(
      `[twilio-sms] no webhook targets registered for path=${path} (registered: ${[...webhookTargets.keys()].join(", ")})`,
    );
    return false;
  }

  if (req.method !== "POST") {
    console.log(`[twilio-sms] rejected non-POST method: ${req.method}`);
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const rawBody = await readRawBody(req, 1024 * 1024);
  if (!rawBody) {
    console.log("[twilio-sms] rejected: empty/invalid body");
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const fields: TwilioSmsWebhookFields = Object.fromEntries(new URLSearchParams(rawBody));
  if (!fields.MessageSid) {
    console.log("[twilio-sms] rejected: no MessageSid in payload");
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const numMedia = parseInt(fields.NumMedia ?? "0", 10);
  console.log(
    `[twilio-sms] inbound SMS: sid=${fields.MessageSid} from=${fields.From} to=${fields.To} body="${(fields.Body ?? "").slice(0, 80)}" media=${fields.NumMedia ?? 0}`,
  );
  if (numMedia > 0) {
    for (let i = 0; i < numMedia; i++) {
      console.log(
        `[twilio-sms] media[${i}]: url=${fields[`MediaUrl${i}`] ?? "<missing>"} type=${fields[`MediaContentType${i}`] ?? "<missing>"}`,
      );
    }
    // Log all field keys when media expected — helps diagnose missing MediaUrl fields
    const fieldKeys = Object.keys(fields).sort().join(", ");
    console.log(`[twilio-sms] webhook field keys: ${fieldKeys}`);
  }

  const twilioSignature = req.headers["x-twilio-signature"];
  const signatureStr = Array.isArray(twilioSignature) ? twilioSignature[0] : twilioSignature;
  const webhookUrl = resolveWebhookUrl(req);
  console.log(
    `[twilio-sms] signature verification: url=${webhookUrl} hasSig=${Boolean(signatureStr)}`,
  );

  let selected: WebhookTarget | undefined;
  for (const target of targets) {
    // Skip signature verification when running behind a proxy (TWILIO_SMS_PROXY_URL).
    // The proxy already received the legitimate Twilio request; re-verifying
    // the signature on the internal hop is unnecessary and will fail because
    // the X-Twilio-Signature header is not forwarded.
    if (target.account.proxyUrl) {
      console.log(
        `[twilio-sms] signature verification skipped (proxy mode, account=${target.account.accountId})`,
      );
      selected = target;
      break;
    }

    const verification = verifyTwilioWebhook({
      authToken: target.account.authToken,
      signature: signatureStr,
      url: webhookUrl,
      body: fields as Record<string, string>,
    });
    if (verification.ok) {
      console.log(`[twilio-sms] signature OK (${verification.reason ?? "valid"})`);
      selected = target;
      break;
    } else {
      console.log(
        `[twilio-sms] signature failed for account=${target.account.accountId}: ${verification.reason}`,
      );
    }
  }

  if (!selected) {
    console.log("[twilio-sms] rejected: no account matched signature");
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  // Respond with empty TwiML immediately, process async
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/xml");
  res.end("<Response></Response>");
  console.log("[twilio-sms] responded 200 TwiML, processing async...");

  selected.statusSink?.({ lastInboundAt: Date.now() });
  processInboundMessage(fields, selected).catch((err) => {
    selected?.runtime.error?.(
      `[${selected.account.accountId}] Twilio SMS webhook failed: ${String(err)}`,
    );
  });

  return true;
}

async function processInboundMessage(
  fields: TwilioSmsWebhookFields,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;
  console.log("[twilio-sms] processInboundMessage start");

  const fromPhone = fields.From?.trim();
  if (!fromPhone) {
    console.log("[twilio-sms] skip: no sender phone");
    logVerbose(core, runtime, "skip message with no sender phone");
    return;
  }

  const toPhone = fields.To?.trim();
  const messageText = (fields.Body ?? "").trim();
  const numMedia = parseInt(fields.NumMedia ?? "0", 10);
  const messageSid = fields.MessageSid;

  // Extract media attachments
  const mediaAttachments: Array<{ url: string; contentType: string }> = [];
  for (let i = 0; i < numMedia; i++) {
    const url = fields[`MediaUrl${i}`];
    const contentType = fields[`MediaContentType${i}`];
    if (url) {
      mediaAttachments.push({ url, contentType: contentType ?? "application/octet-stream" });
    }
  }

  const hasMedia = mediaAttachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    console.log("[twilio-sms] skip: empty body and no media");
    return;
  }

  const normalizedPhone = normalizeE164(fromPhone);
  console.log(
    `[twilio-sms] processing: from=${normalizedPhone} text="${messageText.slice(0, 80)}" media=${mediaAttachments.length}`,
  );

  // DM policy check
  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
  console.log(`[twilio-sms] dmPolicy=${dmPolicy} configAllowFrom=[${configAllowFrom.join(",")}]`);

  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeAuth
      ? await core.channel.pairing.readAllowFromStore("twilio-sms").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

  const senderAllowed = isSenderAllowed(normalizedPhone, effectiveAllowFrom);
  console.log(
    `[twilio-sms] senderAllowed=${senderAllowed} effectiveAllowFrom=[${effectiveAllowFrom.join(",")}]`,
  );
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
      })
    : undefined;

  if (dmPolicy === "disabled" || account.config.dm?.enabled === false) {
    console.log(`[twilio-sms] BLOCKED: dmPolicy=disabled for ${normalizedPhone}`);
    logVerbose(core, runtime, `Blocked Twilio SMS from ${normalizedPhone} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    if (!senderAllowed) {
      console.log(
        `[twilio-sms] BLOCKED: sender ${normalizedPhone} not in allowlist (dmPolicy=${dmPolicy})`,
      );
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "twilio-sms",
          id: normalizedPhone,
          meta: { name: undefined, phone: normalizedPhone },
        });
        if (created) {
          logVerbose(core, runtime, `twilio-sms pairing request sender=${normalizedPhone}`);
          try {
            await sendTwilioSms({
              account,
              to: normalizedPhone,
              text: core.channel.pairing.buildPairingReply({
                channel: "twilio-sms",
                idLine: `Your phone number: ${normalizedPhone}`,
                code,
              }),
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          } catch (err) {
            logVerbose(
              core,
              runtime,
              `pairing reply failed for ${normalizedPhone}: ${String(err)}`,
            );
          }
        }
      } else {
        logVerbose(
          core,
          runtime,
          `Blocked unauthorized Twilio SMS sender ${normalizedPhone} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  if (
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `twilio-sms: drop control command from ${normalizedPhone}`);
    return;
  }

  console.log(`[twilio-sms] sender authorized, resolving route...`);
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "twilio-sms",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: normalizedPhone,
    },
  });
  console.log(
    `[twilio-sms] route: agentId=${route.agentId} sessionKey=${route.sessionKey} accountId=${route.accountId}`,
  );

  // Handle media attachments
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (mediaAttachments.length > 0) {
    const first = mediaAttachments[0];
    if (first.url) {
      try {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        // Twilio media URLs require Basic auth to download; proxy-hosted URLs don't
        let authFetch: typeof fetch | undefined;
        if (account.accountSid && account.authToken) {
          const credentials = Buffer.from(`${account.accountSid}:${account.authToken}`).toString(
            "base64",
          );
          authFetch = (input, init) =>
            fetch(input, {
              ...init,
              headers: {
                ...Object.fromEntries(new Headers(init?.headers).entries()),
                Authorization: `Basic ${credentials}`,
              },
            });
        }
        const loaded = await core.channel.media.fetchRemoteMedia({
          url: first.url,
          maxBytes,
          fetchImpl: authFetch,
        });
        const saved = await core.channel.media.saveMediaBuffer(
          loaded.buffer,
          loaded.contentType ?? first.contentType,
          "inbound",
          maxBytes,
        );
        mediaPath = saved.path;
        mediaType = saved.contentType;
      } catch (err) {
        runtime.error?.(`twilio-sms: failed downloading media: ${String(err)}`);
      }
    }
  }

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Twilio SMS",
    from: normalizedPhone,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `twilio-sms:${normalizedPhone}`,
    To: `twilio-sms:${toPhone ?? account.phoneNumber ?? ""}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: normalizedPhone,
    SenderName: undefined,
    SenderId: normalizedPhone,
    CommandAuthorized: commandAuthorized,
    Provider: "twilio-sms",
    Surface: "twilio-sms",
    MessageSid: messageSid,
    MessageSidFull: messageSid,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "twilio-sms",
    OriginatingTo: `twilio-sms:${toPhone ?? account.phoneNumber ?? ""}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`twilio-sms: failed updating session meta: ${String(err)}`);
    });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "twilio-sms",
    accountId: route.accountId,
  });

  console.log(`[twilio-sms] dispatching to agent (agentId=${route.agentId})...`);
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        console.log(
          `[twilio-sms] delivering reply to ${normalizedPhone}: text=${Boolean(replyPayload.text)} media=${Boolean(replyPayload.mediaUrl || replyPayload.mediaUrls?.length)}`,
        );
        await deliverTwilioSmsReply({
          payload: replyPayload,
          account,
          to: normalizedPhone,
          runtime,
          core,
          config,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Twilio SMS ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}

function isSenderAllowed(normalizedPhone: string, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  return allowFrom.some((entry) => {
    const normalized = normalizeE164(String(entry));
    return normalized === normalizedPhone;
  });
}

async function deliverTwilioSmsReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedTwilioSmsAccount;
  to: string;
  runtime: TwilioSmsRuntimeEnv;
  core: TwilioSmsCoreRuntime;
  config: OpenClawConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, to, runtime, core, config, statusSink } = params;
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    try {
      await sendTwilioSms({
        account,
        to,
        text: payload.text,
        mediaUrls: mediaList,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`Twilio SMS MMS send failed: ${String(err)}`);
    }
    return;
  }

  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 1600;
    const chunkMode = core.channel.text.resolveChunkMode(config, "twilio-sms", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendTwilioSms({ account, to, text: chunk });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Twilio SMS message send failed: ${String(err)}`);
      }
    }
  }
}

export function monitorTwilioSms(options: TwilioSmsMonitorOptions): () => void {
  const core = getTwilioSmsRuntime();
  const webhookPath = resolveWebhookPath(options.webhookPath);
  console.log(
    `[twilio-sms] registering webhook target: path=${webhookPath} account=${options.account.accountId} phone=${options.account.phoneNumber}`,
  );

  const unregister = registerWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    core,
    path: webhookPath,
    statusSink: options.statusSink,
  });

  return unregister;
}

export async function startTwilioSmsMonitor(params: TwilioSmsMonitorOptions): Promise<() => void> {
  return monitorTwilioSms(params);
}

export function resolveTwilioSmsWebhookPath(params: { account: ResolvedTwilioSmsAccount }): string {
  return resolveWebhookPath(params.account.config.webhookPath);
}
