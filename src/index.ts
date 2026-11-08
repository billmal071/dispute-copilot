import { createContext, initialSync } from "./app.js";
import { loadConfig } from "./config.js";
import { loadDotenv } from "./env.js";
import { listen } from "./listen.js";
import { prefillDemoDrafts } from "./seed/prefill.js";
import { createServer } from "./server.js";

try {
  loadDotenv();
  const config = loadConfig(process.env);
  const ctx = createContext(config);

  try {
    await initialSync(ctx);
  } catch (err) {
    console.warn(`Initial sync failed, starting with local data only: ${String(err)}`);
  }

  try {
    await prefillDemoDrafts(ctx);
  } catch (err) {
    console.warn(`Demo drafts were not prefilled: ${String(err)}`);
  }

  const info = await listen(createServer(ctx).fetch, config.port, config.host);
  console.log(`Dispute Copilot (${ctx.mode}) listening on http://${config.host}:${info.port}`);
} catch (err) {
  console.error(`Cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
