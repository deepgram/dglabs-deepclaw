import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { telnyxSmsDock, telnyxSmsPlugin } from "./src/channel.js";
import { handleTelnyxSmsWebhookRequest } from "./src/monitor.js";
import { setTelnyxSmsRuntime } from "./src/runtime.js";

const plugin = {
  id: "telnyx-sms",
  name: "Telnyx SMS",
  description: "OpenClaw Telnyx SMS channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTelnyxSmsRuntime(api.runtime);
    api.registerChannel({ plugin: telnyxSmsPlugin, dock: telnyxSmsDock });
    api.registerHttpHandler(handleTelnyxSmsWebhookRequest);
  },
};

export default plugin;
