import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";

export function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
  hostname: string,
): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch, port, hostname }, resolve);
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `Port ${port} is already in use on ${hostname}. Stop the other process or set PORT.`,
            )
          : err,
      );
    });
  });
}
