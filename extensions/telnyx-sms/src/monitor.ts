import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import crypto from "node:crypto";
import { createReplyPrefixOptions, normalizeE164 } from "openclaw/plugin-sdk";
import type { ResolvedTelnyxSmsAccount } from "./accounts.js";
import type { TelnyxSmsWebhookEvent } from "./types.js";
import { sendTelnyxSms } from "./api.js";
import { getTelnyxSmsRuntime } from "./runtime.js";

export type TelnyxSmsRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type TelnyxSmsMonitorOptions = {
  account: ResolvedTelnyxSmsAccount;
  config: OpenClawConfig;
  runtime: TelnyxSmsRuntimeEnv;
  abortSignal: AbortSignal;
  webhookPath?: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type TelnyxSmsCoreRuntime = ReturnType<typeof getTelnyxSmsRuntime>;

type WebhookTarget = {
  account: ResolvedTelnyxSmsAccount;
  config: OpenClawConfig;
  runtime: TelnyxSmsRuntimeEnv;
  core: TelnyxSmsCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function logVerbose(core: TelnyxSmsCoreRuntime, runtime: TelnyxSmsRuntimeEnv, message: string) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[telnyx-sms] ${message}`);
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
  return "/telnyx-sms";
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

function verifyTelnyxWebhook(params: {
  publicKey: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
}): { ok: boolean; reason?: string } {
  const { publicKey, signature, timestamp, rawBody } = params;

  if (!publicKey) {
    // No public key configured — allow unsigned (warn in logs)
    return { ok: true, reason: "verification skipped (no public key configured)" };
  }

  if (!signature || !timestamp) {
    return { ok: false, reason: "Missing signature or timestamp header" };
  }

  try {
    const signedPayload = `${timestamp}|${rawBody}`;
    const signatureBuffer = Buffer.from(signature, "base64");
    const publicKeyBuffer = Buffer.from(publicKey, "base64");

    const isValid = crypto.verify(
      null, // Ed25519 doesn't use a digest
      Buffer.from(signedPayload),
      {
        key: publicKeyBuffer,
        format: "der",
        type: "spki",
      },
      signatureBuffer,
    );

    if (!isValid) {
      return { ok: false, reason: "Invalid signature" };
    }

    // Check timestamp is within 5 minutes
    const eventTime = parseInt(timestamp, 10) * 1000;
    const now = Date.now();
    if (Math.abs(now - eventTime) > 5 * 60 * 1000) {
      return { ok: false, reason: "Timestamp too old" };
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

export async function handleTelnyxSmsWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const rawBody = await readRawBody(req, 1024 * 1024);
  if (!rawBody) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  let event: TelnyxSmsWebhookEvent;
  try {
    event = JSON.parse(rawBody) as TelnyxSmsWebhookEvent;
  } catch {
    res.statusCode = 400;
    res.end("invalid JSON");
    return true;
  }

  if (!event.data || typeof event.data !== "object") {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const signature = req.headers["telnyx-signature-ed25519"];
  const timestamp = req.headers["telnyx-timestamp"];
  const signatureStr = Array.isArray(signature) ? signature[0] : signature;
  const timestampStr = Array.isArray(timestamp) ? timestamp[0] : timestamp;

  let selected: WebhookTarget | undefined;
  for (const target of targets) {
    const verification = verifyTelnyxWebhook({
      publicKey: target.account.publicKey,
      signature: signatureStr,
      timestamp: timestampStr,
      rawBody,
    });
    if (verification.ok) {
      selected = target;
      break;
    }
  }

  if (!selected) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  // Respond 200 immediately, process async
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end("{}");

  selected.statusSink?.({ lastInboundAt: Date.now() });
  processInboundMessage(event, selected).catch((err) => {
    selected?.runtime.error?.(
      `[${selected.account.accountId}] Telnyx SMS webhook failed: ${String(err)}`,
    );
  });

  return true;
}

async function processInboundMessage(
  event: TelnyxSmsWebhookEvent,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, core, statusSink } = target;
  const data = event.data;
  if (!data) {
    return;
  }

  // Only process inbound messages
  if (data.event_type !== "message.received") {
    return;
  }

  const payload = data.payload;
  if (!payload) {
    return;
  }

  if (payload.direction !== "inbound") {
    return;
  }

  const fromPhone = payload.from?.phone_number?.trim();
  if (!fromPhone) {
    logVerbose(core, runtime, "skip message with no sender phone");
    return;
  }

  const messageText = (payload.text ?? "").trim();
  const mediaAttachments = payload.media ?? [];
  const hasMedia = mediaAttachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) {
    return;
  }

  const normalizedPhone = normalizeE164(fromPhone);

  // DM policy check
  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));

  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    dmPolicy !== "open" || shouldComputeAuth
      ? await core.channel.pairing.readAllowFromStore("telnyx-sms").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

  const senderAllowed = isSenderAllowed(normalizedPhone, effectiveAllowFrom);
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
      })
    : undefined;

  if (dmPolicy === "disabled" || account.config.dm?.enabled === false) {
    logVerbose(core, runtime, `Blocked Telnyx SMS from ${normalizedPhone} (dmPolicy=disabled)`);
    return;
  }

  if (dmPolicy !== "open") {
    if (!senderAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await core.channel.pairing.upsertPairingRequest({
          channel: "telnyx-sms",
          id: normalizedPhone,
          meta: { name: undefined, phone: normalizedPhone },
        });
        if (created) {
          logVerbose(core, runtime, `telnyx-sms pairing request sender=${normalizedPhone}`);
          try {
            await sendTelnyxSms({
              account,
              to: normalizedPhone,
              text: core.channel.pairing.buildPairingReply({
                channel: "telnyx-sms",
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
          `Blocked unauthorized Telnyx SMS sender ${normalizedPhone} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }
  }

  if (
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `telnyx-sms: drop control command from ${normalizedPhone}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "telnyx-sms",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: normalizedPhone,
    },
  });

  // Handle media attachments
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (mediaAttachments.length > 0) {
    const first = mediaAttachments[0];
    if (first.url) {
      try {
        const maxBytes = (account.config.mediaMaxMb ?? 20) * 1024 * 1024;
        const loaded = await core.channel.media.fetchRemoteMedia(first.url, { maxBytes });
        const saved = await core.channel.media.saveMediaBuffer(
          loaded.buffer,
          loaded.contentType ?? first.content_type,
          "inbound",
          maxBytes,
        );
        mediaPath = saved.path;
        mediaType = saved.contentType;
      } catch (err) {
        runtime.error?.(`telnyx-sms: failed downloading media: ${String(err)}`);
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
    channel: "Telnyx SMS",
    from: normalizedPhone,
    timestamp: payload.received_at ? Date.parse(payload.received_at) : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `telnyx-sms:${normalizedPhone}`,
    To: `telnyx-sms:${account.phoneNumber ?? ""}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: normalizedPhone,
    SenderName: undefined,
    SenderId: normalizedPhone,
    CommandAuthorized: commandAuthorized,
    Provider: "telnyx-sms",
    Surface: "telnyx-sms",
    MessageSid: payload.id,
    MessageSidFull: payload.id,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    OriginatingChannel: "telnyx-sms",
    OriginatingTo: `telnyx-sms:${account.phoneNumber ?? ""}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`telnyx-sms: failed updating session meta: ${String(err)}`);
    });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "telnyx-sms",
    accountId: route.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        await deliverTelnyxSmsReply({
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
          `[${account.accountId}] Telnyx SMS ${info.kind} reply failed: ${String(err)}`,
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

async function deliverTelnyxSmsReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedTelnyxSmsAccount;
  to: string;
  runtime: TelnyxSmsRuntimeEnv;
  core: TelnyxSmsCoreRuntime;
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
      await sendTelnyxSms({
        account,
        to,
        text: payload.text,
        mediaUrls: mediaList,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      runtime.error?.(`Telnyx SMS MMS send failed: ${String(err)}`);
    }
    return;
  }

  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 1600;
    const chunkMode = core.channel.text.resolveChunkMode(config, "telnyx-sms", account.accountId);
    const chunks = core.channel.text.chunkMarkdownTextWithMode(payload.text, chunkLimit, chunkMode);
    for (const chunk of chunks) {
      try {
        await sendTelnyxSms({ account, to, text: chunk });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`Telnyx SMS message send failed: ${String(err)}`);
      }
    }
  }
}

export function monitorTelnyxSms(options: TelnyxSmsMonitorOptions): () => void {
  const core = getTelnyxSmsRuntime();
  const webhookPath = resolveWebhookPath(options.webhookPath);

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

export async function startTelnyxSmsMonitor(params: TelnyxSmsMonitorOptions): Promise<() => void> {
  return monitorTelnyxSms(params);
}

export function resolveTelnyxSmsWebhookPath(params: { account: ResolvedTelnyxSmsAccount }): string {
  return resolveWebhookPath(params.account.config.webhookPath);
}
