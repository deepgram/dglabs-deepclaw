import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

export type TelnyxSmsCredentialSource = "config" | "env" | "none";

export type TelnyxSmsAccountConfig = {
  enabled?: boolean;
  name?: string;
  apiKey?: string;
  phoneNumber?: string;
  publicKey?: string;
  webhookPath?: string;
  dm?: {
    policy?: string;
    allowFrom?: Array<string | number>;
    enabled?: boolean;
  };
  textChunkLimit?: number;
  mediaMaxMb?: number;
};

export type ResolvedTelnyxSmsAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: TelnyxSmsAccountConfig;
  credentialSource: TelnyxSmsCredentialSource;
  apiKey: string | undefined;
  phoneNumber: string | undefined;
  publicKey: string | undefined;
};

const ENV_API_KEY = "TELNYX_API_KEY";
const ENV_PHONE_NUMBER = "TELNYX_PHONE_NUMBER";
const ENV_PUBLIC_KEY = "TELNYX_PUBLIC_KEY";

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const raw = cfg.channels?.["telnyx-sms"];
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const section = getChannelSection(cfg);
  const accounts = section?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts as Record<string, unknown>).filter(Boolean);
}

export function listTelnyxSmsAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTelnyxSmsAccountId(cfg: OpenClawConfig): string {
  const section = getChannelSection(cfg);
  const defaultAccount = (section?.defaultAccount as string | undefined)?.trim();
  if (defaultAccount) {
    return defaultAccount;
  }
  const ids = listTelnyxSmsAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TelnyxSmsAccountConfig | undefined {
  const section = getChannelSection(cfg);
  const accounts = section?.accounts as Record<string, TelnyxSmsAccountConfig> | undefined;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeAccountConfig(cfg: OpenClawConfig, accountId: string): TelnyxSmsAccountConfig {
  const section = getChannelSection(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = section;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as TelnyxSmsAccountConfig;
}

function resolveCredentials(params: { accountId: string; account: TelnyxSmsAccountConfig }): {
  apiKey: string | undefined;
  phoneNumber: string | undefined;
  publicKey: string | undefined;
  source: TelnyxSmsCredentialSource;
} {
  const { account, accountId } = params;

  const configApiKey = account.apiKey?.trim();
  const configPhone = account.phoneNumber?.trim();
  if (configApiKey) {
    return {
      apiKey: configApiKey,
      phoneNumber: configPhone,
      publicKey: account.publicKey?.trim(),
      source: "config",
    };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envApiKey = process.env[ENV_API_KEY]?.trim();
    if (envApiKey) {
      return {
        apiKey: envApiKey,
        phoneNumber: configPhone || process.env[ENV_PHONE_NUMBER]?.trim(),
        publicKey: account.publicKey?.trim() || process.env[ENV_PUBLIC_KEY]?.trim(),
        source: "env",
      };
    }
  }

  return { apiKey: undefined, phoneNumber: undefined, publicKey: undefined, source: "none" };
}

export function resolveTelnyxSmsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelnyxSmsAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = getChannelSection(params.cfg)?.enabled !== false;
  const merged = mergeAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentials({ accountId, account: merged });

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    credentialSource: credentials.source,
    apiKey: credentials.apiKey,
    phoneNumber: credentials.phoneNumber,
    publicKey: credentials.publicKey,
  };
}

export function listEnabledTelnyxSmsAccounts(cfg: OpenClawConfig): ResolvedTelnyxSmsAccount[] {
  return listTelnyxSmsAccountIds(cfg)
    .map((accountId) => resolveTelnyxSmsAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
