import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
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
  listTelnyxSmsAccountIds,
  resolveDefaultTelnyxSmsAccountId,
  resolveTelnyxSmsAccount,
  type ResolvedTelnyxSmsAccount,
} from "./accounts.js";
import { probeTelnyxSms, sendTelnyxSms } from "./api.js";
import { resolveTelnyxSmsWebhookPath, startTelnyxSmsMonitor } from "./monitor.js";
import { getTelnyxSmsRuntime } from "./runtime.js";

const channel = "telnyx-sms";

const meta = {
  id: channel,
  label: "Telnyx SMS",
  selectionLabel: "Telnyx SMS",
  docsPath: "/channels/telnyx-sms",
  docsLabel: "telnyx-sms",
  blurb: "SMS messaging via Telnyx Messaging API.",
  aliases: ["sms"],
  order: 76,
  quickstartAllowFrom: true,
};

function normalizePhone(raw: string): string {
  return normalizeE164(raw.replace(/^(telnyx-sms|sms):/i, ""));
}

function looksLikePhone(raw: string): boolean {
  const cleaned = raw
    .trim()
    .replace(/^(telnyx-sms|sms):/i, "")
    .trim();
  return /^\+?\d{10,15}$/.test(cleaned);
}

export const telnyxSmsDock: ChannelDock = {
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
      (resolveTelnyxSmsAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry))
        .filter(Boolean)
        .map((entry) => normalizePhone(entry)),
  },
};

// Build a minimal config schema — Telnyx SMS has no Zod schema in core
const telnyxSmsConfigSchema = buildChannelConfigSchema({
  // Empty schema — no additional validation beyond what buildChannelConfigSchema provides
});

export const telnyxSmsPlugin: ChannelPlugin<ResolvedTelnyxSmsAccount> = {
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
  reload: { configPrefixes: ["channels.telnyx-sms"] },
  configSchema: telnyxSmsConfigSchema,
  config: {
    listAccountIds: (cfg) => listTelnyxSmsAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTelnyxSmsAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTelnyxSmsAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "telnyx-sms",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "telnyx-sms",
        accountId,
        clearBaseFields: ["apiKey", "phoneNumber", "publicKey", "webhookPath", "name"],
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
      (resolveTelnyxSmsAccount({ cfg, accountId }).config.dm?.allowFrom ?? []).map((entry) =>
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
      const account = resolveTelnyxSmsAccount({ cfg });
      if (account.credentialSource === "none") {
        return;
      }
      const to = normalizePhone(id);
      await sendTelnyxSms({ account, to, text: PAIRING_APPROVED_MESSAGE });
    },
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const section = cfg.channels?.["telnyx-sms"] as Record<string, unknown> | undefined;
      const useAccountPath = Boolean(
        (section?.accounts as Record<string, unknown> | undefined)?.[resolvedAccountId],
      );
      const allowFromPath = useAccountPath
        ? `channels.telnyx-sms.accounts.${resolvedAccountId}.dm.`
        : "channels.telnyx-sms.dm.";
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        allowFromPath,
        approveHint: formatPairingApproveHint("telnyx-sms"),
        normalizeEntry: (raw: string) => normalizePhone(raw),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (account.config.dm?.policy === "open") {
        warnings.push(
          `- Telnyx SMS DMs are open to anyone. Set channels.telnyx-sms.dm.policy="pairing" or "allowlist".`,
        );
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const cleaned = raw
        .trim()
        .replace(/^(telnyx-sms|sms):/i, "")
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
      const account = resolveTelnyxSmsAccount({ cfg, accountId });
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
          .replace(/^(telnyx-sms|sms):/i, "")
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
        channelKey: "telnyx-sms",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "TELNYX_API_KEY env vars can only be used for the default account.";
      }
      if (!input.useEnv && !input.token) {
        return "Telnyx SMS requires --token (API key) or TELNYX_API_KEY env var.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "telnyx-sms",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "telnyx-sms",
            })
          : namedConfig;
      const patch = input.useEnv ? {} : input.token ? { apiKey: input.token } : {};
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
            "telnyx-sms": {
              ...next.channels?.["telnyx-sms"],
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
          "telnyx-sms": {
            ...next.channels?.["telnyx-sms"],
            enabled: true,
            accounts: {
              ...(next.channels?.["telnyx-sms"] as Record<string, unknown> | undefined)?.accounts,
              [accountId]: {
                ...(
                  (next.channels?.["telnyx-sms"] as Record<string, unknown> | undefined)
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
    chunker: (text, limit) => getTelnyxSmsRuntime().channel.text.chunkMarkdownText(text, limit),
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
              "Telnyx SMS",
              "<+1XXXXXXXXXX> or channels.telnyx-sms.dm.allowFrom[0]",
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
          "Telnyx SMS",
          "<+1XXXXXXXXXX> or channels.telnyx-sms.dm.allowFrom[0]",
        ),
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveTelnyxSmsAccount({ cfg, accountId });
      const normalizedTo = normalizePhone(to);
      const result = await sendTelnyxSms({ account, to: normalizedTo, text });
      return {
        channel: "telnyx-sms",
        messageId: result?.data?.id ?? "",
        chatId: normalizedTo,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      if (!mediaUrl) {
        throw new Error("Telnyx SMS mediaUrl is required.");
      }
      const account = resolveTelnyxSmsAccount({ cfg, accountId });
      const normalizedTo = normalizePhone(to);
      const result = await sendTelnyxSms({
        account,
        to: normalizedTo,
        text,
        mediaUrls: [mediaUrl],
      });
      return {
        channel: "telnyx-sms",
        messageId: result?.data?.id ?? "",
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
            channel: "telnyx-sms",
            accountId,
            kind: "config",
            message:
              "Telnyx phone number is missing (set channels.telnyx-sms.phoneNumber or TELNYX_PHONE_NUMBER).",
            fix: "Set channels.telnyx-sms.phoneNumber or TELNYX_PHONE_NUMBER env var.",
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
    probeAccount: async ({ account }) => probeTelnyxSms(account),
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
      ctx.log?.info(`[${account.accountId}] starting Telnyx SMS webhook`);
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveTelnyxSmsWebhookPath({ account }),
        phoneNumber: account.phoneNumber,
      });
      const unregister = await startTelnyxSmsMonitor({
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
