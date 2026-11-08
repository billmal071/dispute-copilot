import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { seedMock } from "./paypal/mock.js";
import { SCENARIOS } from "./seed/scenarios.js";

const config = loadConfig(process.env);
const db = openDb(config.dbPath);
db.exec(
  "DELETE FROM actions; DELETE FROM approvals; DELETE FROM drafts; DELETE FROM disputes; DELETE FROM audit; DELETE FROM webhook_events;",
);
seedMock(db, SCENARIOS);
console.log(`Seeded ${SCENARIOS.length} mock disputes into ${config.dbPath}`);
