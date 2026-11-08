import { serve } from "@hono/node-server";
import { createContext, initialSync } from "./app.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig(process.env);
const ctx = createContext(config);

try {
  await initialSync(ctx);
} catch (err) {
  console.warn(`Initial sync failed, starting with local data only: ${String(err)}`);
}

serve({ fetch: createServer(ctx).fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Dispute Copilot (${ctx.mode}) listening on http://${config.host}:${info.port}`);
});
