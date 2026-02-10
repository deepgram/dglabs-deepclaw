import type { VoiceCallConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { TelephonyTtsRuntime } from "./telephony-tts.js";
import { generateCallSummary } from "./call-summary.js";
import { resolveVoiceCallConfig, validateProviderConfig } from "./config.js";
import { DeepgramMediaBridge } from "./deepgram-media-bridge.js";
import { CallManager } from "./manager.js";
import { DeepgramProvider } from "./providers/deepgram.js";
import { MockProvider } from "./providers/mock.js";
import { PlivoProvider } from "./providers/plivo.js";
import { TelnyxProvider } from "./providers/telnyx.js";
import { TwilioProvider } from "./providers/twilio.js";
import { createTelephonyTtsProvider } from "./telephony-tts.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import {
  cleanupTailscaleExposure,
  setupTailscaleExposure,
  VoiceCallWebhookServer,
} from "./webhook.js";

export type VoiceCallRuntime = {
  config: VoiceCallConfig;
  provider: VoiceCallProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

function isLoopbackBind(bind: string | undefined): boolean {
  if (!bind) {
    return false;
  }
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function resolveProvider(config: VoiceCallConfig): VoiceCallProvider {
  const allowNgrokFreeTierLoopbackBypass =
    config.tunnel?.provider === "ngrok" &&
    isLoopbackBind(config.serve?.bind) &&
    (config.tunnel?.allowNgrokFreeTierLoopbackBypass ?? false);

  switch (config.provider) {
    case "telnyx":
      return new TelnyxProvider(
        {
          apiKey: config.telnyx?.apiKey,
          connectionId: config.telnyx?.connectionId,
          publicKey: config.telnyx?.publicKey,
        },
        {
          allowUnsignedWebhooks:
            config.inboundPolicy === "open" || config.inboundPolicy === "disabled",
        },
      );
    case "twilio":
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.enabled ? config.streaming.streamPath : undefined,
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "plivo":
      return new PlivoProvider(
        {
          authId: config.plivo?.authId,
          authToken: config.plivo?.authToken,
        },
        {
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          ringTimeoutSec: Math.max(1, Math.floor(config.ringTimeoutMs / 1000)),
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "deepgram":
      return new TwilioProvider(
        {
          accountSid: config.twilio?.accountSid,
          authToken: config.twilio?.authToken,
        },
        {
          allowNgrokFreeTierLoopbackBypass,
          publicUrl: config.publicUrl,
          skipVerification: config.skipSignatureVerification,
          streamPath: config.streaming?.streamPath || "/voice/stream",
          webhookSecurity: config.webhookSecurity,
        },
      );
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unsupported voice-call provider: ${String(config.provider)}`);
  }
}

export async function createVoiceCallRuntime(params: {
  config: VoiceCallConfig;
  coreConfig: CoreConfig;
  ttsRuntime?: TelephonyTtsRuntime;
  logger?: Logger;
}): Promise<VoiceCallRuntime> {
  const { config: rawConfig, coreConfig, ttsRuntime, logger } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  const config = resolveVoiceCallConfig(rawConfig);

  if (!config.enabled) {
    throw new Error("Voice call disabled. Enable the plugin entry in config.");
  }

  const validation = validateProviderConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid voice-call config: ${validation.errors.join("; ")}`);
  }

  const provider = resolveProvider(config);
  const manager = new CallManager(config);
  const webhookServer = new VoiceCallWebhookServer(config, manager, provider, coreConfig);

  const localUrl = await webhookServer.start();

  // Determine public URL - priority: config.publicUrl > tunnel > legacy tailscale
  let publicUrl: string | null = config.publicUrl ?? null;
  let tunnelResult: TunnelResult | null = null;

  if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
    try {
      tunnelResult = await startTunnel({
        provider: config.tunnel.provider,
        port: config.serve.port,
        path: config.serve.path,
        ngrokAuthToken: config.tunnel.ngrokAuthToken,
        ngrokDomain: config.tunnel.ngrokDomain,
      });
      publicUrl = tunnelResult?.publicUrl ?? null;
    } catch (err) {
      log.error(
        `[voice-call] Tunnel setup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!publicUrl && config.tailscale?.mode !== "off") {
    publicUrl = await setupTailscaleExposure(config);
  }

  // `publicUrl` is treated as a public *origin* (scheme+host) for exposure.
  // The actual webhook endpoint must include `config.serve.path`.
  //
  // Important: do NOT require users to append `/voice/webhook` to PUBLIC_URL.
  // PUBLIC_URL should be the tunnel origin (e.g. https://xyz.ngrok.app).
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
  const webhookUrl = publicOrigin ? new URL(config.serve.path, publicOrigin).toString() : localUrl;

  if (publicOrigin && provider.name === "twilio") {
    (provider as TwilioProvider).setPublicUrl(publicOrigin);
  }

  if (provider.name === "twilio" && config.streaming?.enabled) {
    const twilioProvider = provider as TwilioProvider;
    if (ttsRuntime?.textToSpeechTelephony) {
      try {
        const ttsProvider = createTelephonyTtsProvider({
          coreConfig,
          ttsOverride: config.tts,
          runtime: ttsRuntime,
        });
        twilioProvider.setTTSProvider(ttsProvider);
        log.info("[voice-call] Telephony TTS provider configured");
      } catch (err) {
        log.warn(
          `[voice-call] Failed to initialize telephony TTS: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    } else {
      log.warn("[voice-call] Telephony TTS unavailable; streaming TTS disabled");
    }

    const mediaHandler = webhookServer.getMediaStreamHandler();
    if (mediaHandler) {
      twilioProvider.setMediaStreamHandler(mediaHandler);
      log.info("[voice-call] Media stream handler wired to provider");
    }
  }

  // Deepgram hybrid mode: Twilio handles telephony, Deepgram handles voice AI
  if (config.provider === "deepgram" && config.deepgram) {
    const deepgramProvider = new DeepgramProvider(config.deepgram);
    const twilioProvider = provider as TwilioProvider;

    // Ensure public URL is set for stream URL generation
    if (publicOrigin && !twilioProvider.getPublicUrl()) {
      twilioProvider.setPublicUrl(publicOrigin);
    }

    const gatewayPort = process.env.OPENCLAW_GATEWAY_PORT || "18789";
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

    const bridge = new DeepgramMediaBridge({
      deepgramProvider,
      manager,
      gatewayUrl,
      gatewayToken,
      publicUrl: publicOrigin ?? undefined,
      coreConfig,
      voiceCallConfig: config,
      shouldAcceptStream: ({ callId, token }) => {
        const call = manager.getCallByProviderCallId(callId);
        if (!call) return false;
        if (!twilioProvider.isValidStreamToken(callId, token)) {
          console.warn(`[voice-call] Rejecting media stream: invalid token for ${callId}`);
          return false;
        }
        return true;
      },
      onCallEnded: (callRecord, agentId) => {
        void generateCallSummary({
          voiceConfig: config,
          coreConfig,
          callRecord,
          agentId,
        });
      },
    });

    webhookServer.setDeepgramMediaBridge(bridge);
    if (gatewayToken) {
      webhookServer.setGatewayConfig(gatewayUrl, gatewayToken);
    }

    log.info("[voice-call] Deepgram hybrid mode enabled (Twilio + Deepgram + Gateway)");
  }

  manager.initialize(provider, webhookUrl);

  const stop = async () => {
    if (tunnelResult) {
      await tunnelResult.stop();
    }
    await cleanupTailscaleExposure(config);
    await webhookServer.stop();
  };

  log.info("[voice-call] Runtime initialized");
  log.info(`[voice-call] Webhook URL: ${webhookUrl}`);
  if (publicOrigin) {
    log.info(`[voice-call] Public URL: ${publicOrigin}`);
  }

  return {
    config,
    provider,
    manager,
    webhookServer,
    webhookUrl,
    publicUrl: publicOrigin,
    stop,
  };
}
