import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";

export type TwilioSmsCredentialSource = "config" | "env" | "none";

export type TwilioSmsAccountConfig = {
  enabled?: boolean;
  name?: string;
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
  webhookPath?: string;
  dm?: {
    policy?: string;
    allowFrom?: Array<string | number>;
    enabled?: boolean;
  };
  textChunkLimit?: number;
  mediaMaxMb?: number;
};

export type ResolvedTwilioSmsAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: TwilioSmsAccountConfig;
  credentialSource: TwilioSmsCredentialSource;
  accountSid: string | undefined;
  authToken: string | undefined;
  phoneNumber: string | undefined;
  proxyUrl: string | undefined;
};

const ENV_ACCOUNT_SID = "TWILIO_ACCOUNT_SID";
const ENV_AUTH_TOKEN = "TWILIO_AUTH_TOKEN";
const ENV_PHONE_NUMBER = "TWILIO_PHONE_NUMBER";
const ENV_PROXY_URL = "TWILIO_SMS_PROXY_URL";

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const raw = cfg.channels?.["twilio-sms"];
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

export function listTwilioSmsAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultTwilioSmsAccountId(cfg: OpenClawConfig): string {
  const section = getChannelSection(cfg);
  const defaultAccount = (section?.defaultAccount as string | undefined)?.trim();
  if (defaultAccount) {
    return defaultAccount;
  }
  const ids = listTwilioSmsAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): TwilioSmsAccountConfig | undefined {
  const section = getChannelSection(cfg);
  const accounts = section?.accounts as Record<string, TwilioSmsAccountConfig> | undefined;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeAccountConfig(cfg: OpenClawConfig, accountId: string): TwilioSmsAccountConfig {
  const section = getChannelSection(cfg) ?? {};
  const { accounts: _ignored, defaultAccount: _ignored2, ...base } = section;
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as TwilioSmsAccountConfig;
}

function resolveCredentials(params: { accountId: string; account: TwilioSmsAccountConfig }): {
  accountSid: string | undefined;
  authToken: string | undefined;
  phoneNumber: string | undefined;
  source: TwilioSmsCredentialSource;
} {
  const { account, accountId } = params;

  const configAccountSid = account.accountSid?.trim();
  const configAuthToken = account.authToken?.trim();
  const configPhone = account.phoneNumber?.trim();
  if (configAccountSid && configAuthToken) {
    return {
      accountSid: configAccountSid,
      authToken: configAuthToken,
      phoneNumber: configPhone,
      source: "config",
    };
  }

  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envAccountSid = process.env[ENV_ACCOUNT_SID]?.trim();
    const envAuthToken = process.env[ENV_AUTH_TOKEN]?.trim();
    if (envAccountSid && envAuthToken) {
      return {
        accountSid: envAccountSid,
        authToken: envAuthToken,
        phoneNumber: configPhone || process.env[ENV_PHONE_NUMBER]?.trim(),
        source: "env",
      };
    }
  }

  return { accountSid: undefined, authToken: undefined, phoneNumber: undefined, source: "none" };
}

export function resolveTwilioSmsAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTwilioSmsAccount {
  const accountId = normalizeAccountId(params.accountId);
  const baseEnabled = getChannelSection(params.cfg)?.enabled !== false;
  const merged = mergeAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const credentials = resolveCredentials({ accountId, account: merged });
  const proxyUrl = process.env[ENV_PROXY_URL]?.trim() || undefined;

  return {
    accountId,
    name: merged.name?.trim() || undefined,
    enabled,
    config: merged,
    credentialSource: credentials.source,
    accountSid: credentials.accountSid,
    authToken: credentials.authToken,
    phoneNumber: credentials.phoneNumber,
    proxyUrl,
  };
}

export function listEnabledTwilioSmsAccounts(cfg: OpenClawConfig): ResolvedTwilioSmsAccount[] {
  return listTwilioSmsAccountIds(cfg)
    .map((accountId) => resolveTwilioSmsAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
