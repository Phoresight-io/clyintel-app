// Run with: node --test scripts/egress-proxy.test.mjs
//
// The egress proxy is the agent container's only way out, so its rule is tested directly: exactly
// CONNECT api.anthropic.com:443 is tunnelled, everything else is refused without any connection
// being made. The upstream connect is swapped for a local echo server, so no network is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { allowedTarget, logSafe, createProxy, ALLOWED, PORT } from "./egress-proxy.mjs";

test("allowedTarget: exactly api.anthropic.com:443, case-insensitive; nothing else", () => {
  assert.deepEqual(ALLOWED, ["api.anthropic.com:443"]);
  assert.equal(PORT, 8888);
  assert.deepEqual(allowedTarget("api.anthropic.com:443"), { host: "api.anthropic.com", port: 443 });
  assert.deepEqual(allowedTarget("API.Anthropic.COM:443"), { host: "api.anthropic.com", port: 443 });
  for (const t of [
    "api.anthropic.com:80", "api.anthropic.com:4430", "api.anthropic.com", "api.anthropic.com.:443",
    "api.anthropic.com.evil.example:443", "evil-api.anthropic.com:443", "anthropic.com:443", "console.anthropic.com:443",
    "statsig.anthropic.com:443", "user@api.anthropic.com:443", "api.anthropic.com:443/", " api.anthropic.com:443",
    "api.anthropic.com:443 ", "160.79.104.10:443", "[::1]:443", "169.254.169.254:80", "example.com:443",
    "", undefined, null, 443, "a".repeat(400) + ":443",
  ]) assert.equal(allowedTarget(t), null, JSON.stringify(t));
});

test("logSafe: agent-supplied names are short and limited to a safe character set", () => {
  assert.equal(logSafe("evil.example:443"), "evil.example:443");
  assert.equal(logSafe("a\nb\r::add-mask::x`$(id)"), "a?b?::add-mask::x???id?");
  assert.ok(!logSafe("x\ny").includes("\n"));
  assert.equal(logSafe("a".repeat(500)).length, 120);
  assert.equal(logSafe(undefined), "");
});

// A proxy on an ephemeral port whose "upstream" is a local echo server; records every upstream dial.
async function harness({ upstreamFails = false } = {}) {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const dials = [];
  const lines = [];
  const proxy = createProxy({
    connect: (opts) => {
      dials.push(opts);
      return net.connect({ host: "127.0.0.1", port: upstreamFails ? 1 : echo.address().port });
    },
    log: (l) => lines.push(l),
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const port = proxy.address().port;
  const close = async () => { await new Promise((r) => proxy.close(r)); await new Promise((r) => echo.close(r)); };
  return { port, dials, lines, close };
}

// Sends raw bytes to the proxy, returns everything it answers until it closes or `until` matches.
function talk(port, data, { until, after } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    let sentAfter = false;
    const t = setTimeout(() => { s.destroy(); resolve(buf); }, 3000);
    s.on("data", (d) => {
      buf += d.toString("latin1");
      if (after && !sentAfter && buf.includes("\r\n\r\n")) { sentAfter = true; s.write(after); }
      if (until && until.test(buf)) { clearTimeout(t); s.destroy(); resolve(buf); }
    });
    s.on("close", () => { clearTimeout(t); resolve(buf); });
    s.on("error", reject);
    s.write(data);
  });
}

test("proxy: CONNECT api.anthropic.com:443 is tunnelled both ways", async () => {
  const h = await harness();
  try {
    const out = await talk(h.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n", { after: "ping-through-tunnel", until: /ping-through-tunnel/ });
    assert.match(out, /^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    assert.match(out, /ping-through-tunnel/); // echoed back by the "upstream"
    assert.deepEqual(h.dials, [{ host: "api.anthropic.com", port: 443 }]);
    assert.deepEqual(h.lines, ["allow CONNECT api.anthropic.com:443"]);
  } finally { await h.close(); }
});

test("proxy: any other CONNECT is refused with 403 and never dialled", async () => {
  const h = await harness();
  try {
    for (const target of ["example.com:443", "169.254.169.254:80", "168.63.129.16:80", "172.17.0.1:22", "api.anthropic.com:80", "api.anthropic.com.evil.example:443"]) {
      const out = await talk(h.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      assert.match(out, /^HTTP\/1\.1 403 Forbidden/, target);
    }
    assert.equal(h.dials.length, 0, `dialled: ${JSON.stringify(h.dials)}`);
    assert.ok(h.lines.every((l) => l.startsWith("deny CONNECT ")), h.lines.join("\n"));
  } finally { await h.close(); }
});

test("proxy: plain HTTP is never forwarded, not even to the allowed host", async () => {
  const h = await harness();
  try {
    for (const req of [
      "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
      "GET http://api.anthropic.com/v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n",
      "POST http://169.254.169.254/latest/api/token HTTP/1.1\r\nHost: 169.254.169.254\r\nContent-Length: 0\r\n\r\n",
    ]) {
      const out = await talk(h.port, req);
      assert.match(out, /^HTTP\/1\.1 403 Forbidden/, req.split("\r\n")[0]);
    }
    assert.equal(h.dials.length, 0);
  } finally { await h.close(); }
});

test("proxy: an upstream that cannot be reached gives 502, not a hang", async () => {
  const h = await harness({ upstreamFails: true });
  try {
    const out = await talk(h.port, "CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n");
    assert.match(out, /^HTTP\/1\.1 502 Bad Gateway/);
  } finally { await h.close(); }
});
