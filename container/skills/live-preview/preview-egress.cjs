// Some HTTP clients ignore HTTPS_PROXY on Node 22: Stripe's SDK builds its own https.Agent, and
// clients that call node:https directly never read the variable. This sends their non-loopback
// HTTPS requests through PREVIEW_HTTPS_PROXY with a CONNECT tunnel, so the preview identity adds
// its test-mode keys. A request that brings a proxy-aware agent of its own, or whose host NO_PROXY
// names, is left alone.
const proxyUrl = process.env.PREVIEW_HTTPS_PROXY;
if (proxyUrl) {
  const http = require('node:http');
  const https = require('node:https');
  const tls = require('node:tls');

  const proxy = new URL(proxyUrl);
  const auth = proxy.username
    ? 'Basic ' +
      Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')
    : undefined;

  class TunnelAgent extends https.Agent {
    createConnection(options, done) {
      const target = `${options.host}:${options.port || 443}`;
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: target,
        headers: { host: target, ...(auth ? { 'proxy-authorization': auth } : {}) },
        agent: false,
      });
      req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          done(new Error(`preview proxy refused CONNECT ${target}: ${res.statusCode}`));
          return;
        }
        done(null, tls.connect({ ...options, socket, servername: options.servername || options.host }));
      });
      req.once('error', done);
      req.end();
    }
  }

  const tunnel = new TunnelAgent({ keepAlive: true });
  const loopback = (host) => !host || host === 'localhost' || host === '::1' || /^127\./.test(host);
  const ownAgent = (agent) => agent === false || (agent != null && agent.constructor !== https.Agent);
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => {
      const m = /^(.*?)(?::(\d+))?$/.exec(entry.toLowerCase());
      return { host: m[1].replace(/^\*?\./, ''), port: m[2] };
    });
  const bypassed = (host, port) =>
    noProxy.some(
      (e) => e.host === '*' || ((!e.port || e.port === port) && (host === e.host || host.endsWith(`.${e.host}`))),
    );
  const route = (opts, rawHost, rawPort) => {
    const host = String(rawHost || '')
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    if (!ownAgent(opts.agent) && !loopback(host) && !bypassed(host, String(rawPort || 443))) opts.agent = tunnel;
    return opts;
  };

  for (const name of ['request', 'get']) {
    const original = https[name];
    https[name] = function (input, options, callback) {
      if (typeof input === 'string' || input instanceof URL) {
        if (typeof options === 'function') {
          callback = options;
          options = undefined;
        }
        const url = new URL(input);
        return original.call(this, url, route({ ...(options || {}) }, url.hostname, url.port), callback);
      }
      const opts = { ...(input || {}) };
      return original.call(this, route(opts, opts.hostname || opts.host, opts.port), options, callback);
    };
  }
}
