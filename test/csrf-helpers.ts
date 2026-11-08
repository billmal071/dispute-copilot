import type { Server } from "../src/server.js";

export interface Session {
  token: string;
  cookie: string;
}

export async function startSession(server: Server): Promise<Session> {
  const res = await server.request("/");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const html = await res.text();
  const token = /name="csrf_token" value="([^"]+)"|hx-headers='\{"X-CSRF-Token":"([^"]+)"/.exec(
    html,
  );
  return { token: token?.[1] ?? token?.[2] ?? "", cookie };
}

export function withSession(server: Server, session: Session): Server {
  const request = ((input: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET") return server.request(input, init);
    const headers = new Headers(init.headers);
    headers.set("cookie", session.cookie);
    headers.set("x-csrf-token", session.token);
    return server.request(input, { ...init, headers });
  }) as Server["request"];
  return Object.assign(Object.create(server), { request }) as Server;
}
