import {
  applyAccountNameToChannelSection,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  missingTargetError,
  normalizeAccountId,
  normalizeE164,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelDock,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import {
  listTwilioSmsAccountIds,
  resolveDefaultTwilioSmsAccountId,
  resolveTwilioSmsAccount,
  type ResolvedTwilioSmsAccount,
} from "./accounts.js";
import { probeTwilioSms, sendTwilioSms } from "./api.js";
import { resolveTwilioSmsWebhookPath, startTwilioSmsMonitor } from "./monitor.js";
import { getTwilioSmsRuntime } from "./runtime.js";

const channel = "twilio-sms";

const meta = {
  id: channel,
  label: "Twilio SMS",
  selectionLabel: "Twilio SMS",
  docsPath: "/channels/twilio-sms",
  docsLabel: "twilio-sms",
  blurb: "SMS messaging via Twilio Programmable Messaging API.",
  aliases: ["twilio-sms"],
  order: 77,
  quickstartAllowFrom: true,
};

function normalizePhone(raw: string): string {
  return normalizeE164(raw.replace(/^(twilio-sms|sms):/i, ""));
}

function looksLikePhone(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/^(twilio-sms|sms):/i, "")
    .trim();
  return /^\+?\d{10,15}$/.test(cleaned);
}

export const twilioSmsDock: ChannelDock = {
  id: channel,
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    media: true,
    threads: false,
    blockStreaming: true,
  },
  outbound: { textChunkLimit: 1600 },
  config: {
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTwilioSmsAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map((entry) => normalizePhone(entry)),
  },
};

// Inline config schema — no Zod schema needed for Twilio SMS
const twilioSmsConfigSchema = {
  schema: { type: "object", additionalProperties: false, properties: {} } as Record<
    string,
    unknown
  >,
};

export const twilioSmsPlugin: ChannelPlugin<ResolvedTwilioSmsAccount> = {
  id: channel,
  meta: { ...meta },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    media: true,
    threads: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1200, idleMs: 800 },
  },
  reload: { configPrefixes: ["channels.twilio-sms"] },
  configSchema: twilioSmsConfigSchema,
  config: {
    listAccountIds: (cfg) => listTwilioSmsAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTwilioSmsAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTwilioSmsAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "twilio-sms",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "twilio-sms",
        accountId,
        clearBaseFields: ["accountSid", "authToken", "phoneNumber", "webhookPath", "name"],
      }),
    isConfigured: (account) => account.credentialSource !== "none",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveTwilioSmsAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map((entry) => normalizePhone(entry)),
  },
  pairing: {
    idLabel: "phoneNumber",
    normalizeAllowEntry: (entry) => normalizePhone(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveTwilioSmsAccount({ cfg });
      if (account.credentialSource === "none") {
        return;
      }
      const to = normalizePhone(id);
      await sendTwilioSms({ account, to, text: PAIRING_APPROVED_MESSAGE });
    },
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const section = cfg.channels?.["twilio-sms"] as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(
        (section?.accounts as Record<string, unknown> | undefined)?.[resolvedAccountId],
      );
      const allowFromPath = useAccountPath
        ? `channels.twilio-sms.accounts.${resolvedAccountId}.dm.`
        : "channels.twilio-sms.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("twilio-sms"),
        normalizeEntry: (raw: string) => normalizePhone(raw),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Twilio SMS DMs are open to anyone. Set channels.twilio-sms.dm.policy="pairing" or "allowlist".`,
        );
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const cleaned = raw
        .trim()
        .replace(/^(twilio-sms|sms):/i, "")
        .trim();
      if (!cleaned) {
        return null;
      }
      return normalizeE164(cleaned);
    },
    targetResolver: {
      looksLikeId: (raw, normalized) => {
        const value = normalized ?? raw.trim();
        return looksLikePhone(value);
      },
      hint: "<+1XXXXXXXXXX>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveTwilioSmsAccount({ cfg, accountId });
      const q = query?.trim().toLowerCase() || "";
      const allowFrom = account.config.dm?.allowFrom ?? [];
      const peers = Array.from(
        new Set(
          allowFrom
            .map((entry) => String(entry).trim())
            .filter((entry) => Boolean(entry) && entry !== "*")
            .map((entry) => normalizePhone(entry)),
        ),
      )
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "user", id }) as const);
      return peers;
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      const resolved = inputs.map((input) => {
        const cleaned = input
          .trim()
          .replace(/^(twilio-sms|sms):/i, "")
          .trim();
        if (!cleaned) {
          return { input, resolved: false, note: "empty target" };
        }
        const normalized = normalizeE164(cleaned);
        if (kind === "user" && looksLikePhone(cleaned)) {
          return { input, resolved: true, id: normalized };
        }
        return {
          input,
          resolved: false,
          note: "use E.164 phone format (+1XXXXXXXXXX)",
        };
      });
      return resolved;
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "twilio-sms",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "Twilio SMS requires --token (auth token) or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN env vars.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "twilio-sms",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "twilio-sms",
            })
          : namedConfig;
      const patch = input.useEnv ? {} : input.token ? { authToken: input.token } : {};
      const phoneNumber = input.phoneNumber?.trim();
      const webhookPath = input.webhookPath?.trim();
      const configPatch = {
        ...patch,
        ...(phoneNumber ? { phoneNumber } : {}),
        ...(webhookPath ? { webhookPath } : {}),
      };
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            "twilio-sms": {
              ...next.channels?.["twilio-sms"],
              enabled: true,
              ...configPatch,
            },
          },
        } as OpenClawConfig;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          "twilio-sms": {
            ...next.channels?.["twilio-sms"],
            enabled: true,
            accounts: {
              ...(next.channels?.["twilio-sms"] as Record<string, unknown> | undefined)?.accounts,
              [accountId]: {
                ...(
                  (next.channels?.["twilio-sms"] as Record<string, unknown> | undefined)
                    ?.accounts as Record<string, unknown> | undefined
                )?.[accountId],
                enabled: true,
                ...configPatch,
              },
            },
          },
        },
      } as OpenClawConfig;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getTwilioSmsRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 1600,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowListRaw = (allowFrom ?? []).map((entry) => String(entry).trim()).filter(Boolean);
      const allowList = allowListRaw
        .filter((entry) => entry !== "*")
        .map((entry) => normalizePhone(entry))
        .filter(Boolean);

      if (trimmed) {
        const normalized = normalizePhone(trimmed);
        if (!normalized || !looksLikePhone(normalized)) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: allowList[0] };
          }
          return {
            ok: false,
            error: missingTargetError(
              "Twilio SMS",
              "<+1XXXXXXXXXX> or channels.twilio-sms.dm.allowFrom[0]",
            ),
          };
        }
        return { ok: true, to: normalized };
      }

      if (allowList.length > 0) {
        return { ok: true, to: allowList[0] };
      }
      return {
        ok: false,
        error: missingTargetError(
          "Twilio SMS",
          "<+1XXXXXXXXXX> or channels.twilio-sms.dm.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveTwilioSmsAccount({ cfg, accountId });
      const normalizedTo = normalizePhone(to);
      const result = await sendTwilioSms({ account, to: normalizedTo, text });
      return {
        channel: "twilio-sms",
        messageId: result?.sid ?? "",
        chatId: normalizedTo,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        throw new Error("Twilio SMS mediaUrl is required.");
      }
      const account = resolveTwilioSmsAccount({ cfg, accountId });
      const normalizedTo = normalizePhone(to);
      const result = await sendTwilioSms({
        account,
        to: normalizedTo,
        text,
        mediaUrls: [mediaUrl],
      });
      return {
        channel: "twilio-sms",
        messageId: result?.sid ?? "",
        chatId: normalizedTo,
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) {
          return [];
        }
        const issues = [];
        if (!entry.phoneNumber) {
          issues.push({
            channel: "twilio-sms",
            accountId,
            kind: "config",
            message:
              "Twilio phone number is missing (set channels.twilio-sms.phoneNumber or TWILIO_PHONE_NUMBER).",
            fix: "Set channels.twilio-sms.phoneNumber or TWILIO_PHONE_NUMBER env var.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      credentialSource: snapshot.credentialSource ?? "none",
      phoneNumber: snapshot.phoneNumber ?? null,
      webhookPath: snapshot.webhookPath ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account }) => probeTwilioSms(account),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.credentialSource !== "none",
      credentialSource: account.credentialSource,
      phoneNumber: account.phoneNumber,
      webhookPath: account.config.webhookPath,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      dmPolicy: account.config.dm?.policy ?? "pairing",
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Twilio SMS webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveTwilioSmsWebhookPath({ account }),
        phoneNumber: account.phoneNumber,
      });
      const unregister = await startTwilioSmsMonitor({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });
      return () => {
        unregister?.();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
