// The agent container's only way out: a forward proxy that allows exactly one destination,
// CONNECT api.anthropic.com:443, and refuses everything else.
//
// How it is wired (d3-factory.yml, pipeline job): the agent container runs on a Docker --internal
// network with no route out, and the host is dropped on that network's bridge too. This proxy runs
// in its own container, attached to that network (as "proxy") and to the default bridge, which is
// how it reaches the API. The agents get HTTPS_PROXY=http://proxy:8888, which the Claude CLI honours.
//
// What it does NOT do:
//   - forward plain HTTP (any non-CONNECT request gets 403), so nothing goes out unencrypted or to
//     another host through a "GET http://evil/..." request;
//   - look inside the tunnel (TLS to Anthropic is end to end). So it cannot tell the factory's key
//     from another one: an injected agent could still call the API with an attacker's key. The
//     spend-capped key and the run's short life are what limit that; see the workflow comments.
//   - resolve names for the agents: the internal network has no DNS for outside names, and the
//     target here is a fixed name, so the agent's own lookups never matter.
//
// It runs from the TRUSTED checkout, mounted read-only into the proxy container. The agents' copy
// of the repo (which they can edit) is never what runs here, and they cannot reach this container's
// filesystem or environment. No dependencies, no secrets, no environment it reads.

import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const ALLOWED = Object.freeze(["api.anthropic.com:443"]);
export const PORT = 8888;
const MAX_CONNECTIONS = 256;
const CONNECT_TIMEOUT_MS = 15_000;

// Exact match on the CONNECT authority (host:port), case-insensitive. No suffix or pattern matching,
// no IP literals, no trailing dot, no userinfo: anything that is not literally an allowed entry fails.
export function allowedTarget(authority) {
  if (typeof authority !== "string" || authority.length > 300) return null;
  const a = authority.toLowerCase();
  if (!ALLOWED.includes(a)) return null;
  const i = a.lastIndexOf(":");
  return { host: a.slice(0, i), port: Number(a.slice(i + 1)) };
}

// A target as it may appear in the log: the agent wrote it, so keep it short and to a safe character
// set, so no log line can start a workflow command (::...) or hide anything.
export const logSafe = (s) => String(s ?? "").slice(0, 120).replace(/[^A-Za-z0-9._:\-[\]]/g, "?");

export function createProxy({ connect = net.connect, log = (line) => console.log(line) } = {}) {
  const server = http.createServer((req, res) => {
    log(`deny ${logSafe(req.method)} ${logSafe(req.headers.host)}`);
    res.writeHead(403, { "content-type": "text/plain", connection: "close" });
    res.end("Only CONNECT api.anthropic.com:443 is allowed.\n");
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connect", (req, client, head) => {
    const target = allowedTarget(req.url);
    if (!target) {
      log(`deny CONNECT ${logSafe(req.url)}`);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    log(`allow CONNECT ${target.host}:${target.port}`);
    const upstream = connect({ host: target.host, port: target.port });
    const fail = () => {
      if (client.writable && !client.destroyed && !upstream.established) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      client.destroy();
      upstream.destroy();
    };
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => { if (!upstream.established) fail(); });
    upstream.once("connect", () => {
      upstream.established = true;
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", fail);
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const server = createProxy();
  server.listen(PORT, "0.0.0.0", () => console.log(`egress proxy listening on ${PORT}; allowed: ${ALLOWED.join(", ")}`));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
}
