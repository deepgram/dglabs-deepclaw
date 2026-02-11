import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { twilioSmsDock, twilioSmsPlugin } from "./src/channel.js";
import { handleTwilioSmsWebhookRequest } from "./src/monitor.js";
import { setTwilioSmsRuntime } from "./src/runtime.js";

const plugin = {
  id: "twilio-sms",
  name: "Twilio SMS",
  description: "OpenClaw Twilio SMS channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTwilioSmsRuntime(api.runtime);
    api.registerChannel({ plugin: twilioSmsPlugin, dock: twilioSmsDock });
    api.registerHttpHandler(handleTwilioSmsWebhookRequest);
  },
};

export default plugin;
