import { existsSync } from "node:fs";

export function loadDotenv(path = ".env"): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
