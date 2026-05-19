#!/usr/bin/env node
//
// Push a subms-diff.json (or a SubMsBenchSummary) to an external sink. Six
// sinks: slack, http, prometheus, influxdb, datadog, stdout. Designed to be
// stitched after `subms-action-diff` or `subms-action-diff-aggregate` so regression data
// leaves CI for downstream observability (Slack on red, Prometheus for trend
// charts, etc).
//
// Inputs come from env vars set by action.yml. The action is "soft" by
// default - a flaky webhook can't block the gate.

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { URL } = require("node:url");

const env = process.env;
const INPUT_PATH = env.INPUT_PATH;
const SINK = (env.SINK || "").toLowerCase();
const ONLY_ON_REGRESSION = (env.ONLY_ON_REGRESSION || "false") === "true";
const FAIL_ON_SINK_ERROR = (env.FAIL_ON_SINK_ERROR || "false") === "true";
const METRIC_PREFIX = env.METRIC_PREFIX || "subms_perf";
const TAGS = safeJsonParse(env.TAGS, {});

// Enterprise transport knobs (all optional; safe defaults match the dev path).
const PROXY_URL = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
const NO_PROXY = (env.NO_PROXY || env.no_proxy || "").split(",").map((s) => s.trim()).filter(Boolean);
const CA_BUNDLE_PATH = env.SUBMS_CA_BUNDLE || env.NODE_EXTRA_CA_CERTS || "";
const MTLS_CERT_PATH = env.SUBMS_CLIENT_CERT || "";
const MTLS_KEY_PATH = env.SUBMS_CLIENT_KEY || "";
const RETRY_MAX = Math.max(0, Number.parseInt(env.SUBMS_RETRY_MAX || "3", 10));
const RETRY_BASE_MS = Math.max(50, Number.parseInt(env.SUBMS_RETRY_BASE_MS || "500", 10));
const SINK_TIMEOUT_MS = Math.max(1_000, Number.parseInt(env.SUBMS_SINK_TIMEOUT_MS || "30000", 10));
// PII scrubber. Accepts a JSON array of regex strings, OR a newline-separated
// list (more friendly to YAML pipe-string literals - no double-escaping).
// Matches across all patterns are replaced with "[REDACTED]".
//
// YAML pipe-string (preferred):
//   env:
//     SUBMS_PII_SCRUB: |
//       [\w.+-]+@[\w.-]+
//       (\d{1,3}\.){3}\d{1,3}
//
// JSON array (one-liner):
//   SUBMS_PII_SCRUB='["[\\w.+-]+@[\\w.-]+","(\\d{1,3}\\.){3}\\d{1,3}"]'
const SCRUB_PATTERNS = (() => {
  const raw = (env.SUBMS_PII_SCRUB || "").trim();
  if (!raw) return [];
  let entries = null;
  if (raw.startsWith("[")) {
    try { entries = JSON.parse(raw); } catch (_) { entries = null; }
  }
  if (entries === null) {
    entries = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  return entries
    .map((p) => {
      try { return new RegExp(p, "g"); } catch (_) { return null; }
    })
    .filter(Boolean);
})();

const caBundle = CA_BUNDLE_PATH && fs.existsSync(CA_BUNDLE_PATH) ? fs.readFileSync(CA_BUNDLE_PATH) : null;
const clientCert = MTLS_CERT_PATH && fs.existsSync(MTLS_CERT_PATH) ? fs.readFileSync(MTLS_CERT_PATH) : null;
const clientKey = MTLS_KEY_PATH && fs.existsSync(MTLS_KEY_PATH) ? fs.readFileSync(MTLS_KEY_PATH) : null;

if (!INPUT_PATH) {
  err("INPUT_PATH is required");
  process.exit(2);
}
if (!SINK) {
  err("SINK is required (one of: slack, http, prometheus, influxdb, datadog, stdout)");
  process.exit(2);
}

function safeJsonParse(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch (_) {
    return fallback;
  }
}

function err(msg) {
  process.stderr.write(`subms-diff-sink: ${msg}\n`);
}

function setOutput(name, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, `${name}=${value}\n`);
}

// ---------------------------------------------------------------------
// Load the input. Two valid shapes:
//   - subms-diff.json     (has `has_regression` + `stages[*].metrics`)
//   - subms-summary.json  (has `stages.<name>.{p50_ns,p99_ns,...}`)
// We normalise to a flat list of {stage, metric, value_ns, delta_pct?} rows.
// ---------------------------------------------------------------------

const raw = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
const doc = Array.isArray(raw) ? raw[0] : raw;
const isDiff = Array.isArray(doc.stages);   // diff puts stages as an array
const isSummary = doc.stages && typeof doc.stages === "object" && !Array.isArray(doc.stages);

let rows = [];
let workload, lang, hasRegression = false;

if (isDiff) {
  workload = doc.candidate_workload;
  lang = doc.lang;
  hasRegression = !!doc.has_regression;
  for (const stage of doc.stages) {
    for (const m of stage.metrics || []) {
      rows.push({
        stage: stage.stage,
        metric: m.metric,
        baseline_ns: m.baseline_ns,
        candidate_ns: m.candidate_ns,
        delta_ns: m.delta_ns,
        delta_pct: m.delta_pct,
        worst_regression_pct: stage.worst_regression_pct,
      });
    }
  }
} else if (isSummary) {
  workload = doc.workload;
  lang = doc.lang;
  for (const [name, s] of Object.entries(doc.stages)) {
    for (const metric of ["p50_ns", "p99_ns", "p999_ns", "max_ns", "mean_ns"]) {
      rows.push({ stage: name, metric: metric.replace(/_ns$/, ""), value_ns: s[metric] });
    }
  }
} else {
  err(`unknown JSON shape at ${INPUT_PATH}; expected subms-action-diff or subms-summary`);
  if (FAIL_ON_SINK_ERROR) process.exit(2);
  setOutput("pushed", "false");
  setOutput("sink", SINK);
  process.exit(0);
}

if (ONLY_ON_REGRESSION && !hasRegression) {
  process.stdout.write("subms-diff-sink: only-on-regression set; no regression, skipping.\n");
  setOutput("pushed", "false");
  setOutput("sink", SINK);
  process.exit(0);
}

// Merge runtime tags + static tags from input. Scrubber is applied later
// after the helper is declared so SUBMS_PII_SCRUB rules redact tag values
// before they reach any sink.
let baseTags = { workload: workload || "unknown", lang: lang || "unknown", ...TAGS };

// ---------------------------------------------------------------------
// HTTP transport - proxy-aware, TLS-aware, mTLS-aware, retry-aware. Still
// zero-dep: pure Node std lib.
// ---------------------------------------------------------------------

/** Honor NO_PROXY for the target host. Supports literal hostnames and `.suffix.com`
 *  match. */
function shouldBypassProxy(hostname) {
  for (const rule of NO_PROXY) {
    if (!rule) continue;
    if (rule === "*") return true;
    if (rule.startsWith(".")) {
      if (hostname.endsWith(rule)) return true;
    } else if (hostname === rule) {
      return true;
    }
  }
  return false;
}

/** Build an http(s).Agent that honours HTTPS_PROXY, custom CA bundle, and mTLS
 *  client cert/key. Returned agent is suitable to pass via `agent:` to
 *  http.request / https.request. */
function buildAgent(targetUrl) {
  const target = new URL(targetUrl);
  const isHttps = target.protocol === "https:";

  // mTLS / custom CA TLS options.
  const tlsOptions = {};
  if (caBundle) tlsOptions.ca = caBundle;
  if (clientCert) tlsOptions.cert = clientCert;
  if (clientKey) tlsOptions.key = clientKey;

  if (!PROXY_URL || shouldBypassProxy(target.hostname)) {
    return isHttps ? new https.Agent(tlsOptions) : new http.Agent();
  }

  const proxy = new URL(PROXY_URL);

  // For HTTPS-through-HTTP-proxy we CONNECT tunnel ourselves with a one-off
  // socket; for HTTP-through-HTTP-proxy we just rewrite the request. Most
  // corporate proxies are HTTP CONNECT, which is what the tunneling path
  // here implements.
  if (isHttps) {
    return new https.Agent({
      ...tlsOptions,
      keepAlive: false,
      createConnection(options, cb) {
        const tunnelReq = http.request({
          host: proxy.hostname,
          port: proxy.port || 80,
          method: "CONNECT",
          path: `${target.hostname}:${target.port || 443}`,
          headers: proxy.username
            ? { "Proxy-Authorization": "Basic " + Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64") }
            : {},
        });
        tunnelReq.on("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            cb(new Error(`proxy CONNECT failed: ${res.statusCode} ${res.statusMessage}`));
            return;
          }
          cb(null, tls.connect({
            ...tlsOptions,
            socket,
            servername: target.hostname,
          }));
        });
        tunnelReq.on("error", cb);
        tunnelReq.end();
      },
    });
  }
  // HTTP target through HTTP proxy - the simple proxy-rewrite case.
  return new http.Agent({ keepAlive: false });
}

/** Detect transient failure modes worth retrying. */
function isRetryable(status, errorMessage) {
  if (errorMessage) {
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|socket hang up/i.test(errorMessage);
  }
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

/** Sleep with exponential backoff + jitter. */
function backoffDelay(attempt) {
  const exp = RETRY_BASE_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * (RETRY_BASE_MS / 2));
  return Math.min(exp + jitter, 30_000);
}

function httpRequestOnce(urlString, { method = "POST", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const isHttps = u.protocol === "https:";
    const useProxyRewrite = PROXY_URL && !isHttps && !shouldBypassProxy(u.hostname);
    const targetForRequest = useProxyRewrite ? new URL(PROXY_URL) : u;
    const agent = buildAgent(urlString);
    const lib = isHttps ? https : http;
    const reqOpts = {
      method,
      hostname: targetForRequest.hostname,
      port: targetForRequest.port || (targetForRequest.protocol === "https:" ? 443 : 80),
      path: useProxyRewrite ? urlString : `${u.pathname}${u.search}`,
      headers: {
        Host: u.host,
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
      agent,
      timeout: SINK_TIMEOUT_MS,
    };
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${SINK_TIMEOUT_MS} ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Retrying HTTP request. Honours RETRY_MAX + RETRY_BASE_MS + isRetryable(). */
async function httpRequest(urlString, opts = {}) {
  let attempt = 0;
  let lastError;
  while (true) {
    try {
      const res = await httpRequestOnce(urlString, opts);
      if (attempt < RETRY_MAX && isRetryable(res.status)) {
        const wait = backoffDelay(attempt);
        process.stderr.write(`subms-diff-sink: retry ${attempt + 1}/${RETRY_MAX} after ${wait}ms (status ${res.status})\n`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < RETRY_MAX && isRetryable(0, e.message)) {
        const wait = backoffDelay(attempt);
        process.stderr.write(`subms-diff-sink: retry ${attempt + 1}/${RETRY_MAX} after ${wait}ms (${e.message})\n`);
        await new Promise((r) => setTimeout(r, wait));
        attempt++;
        continue;
      }
      throw lastError;
    }
  }
}

/** Scrub a single tag value against SUBMS_PII_SCRUB regexes. */
function scrubValue(v) {
  if (SCRUB_PATTERNS.length === 0) return v;
  let s = String(v);
  for (const re of SCRUB_PATTERNS) {
    s = s.replace(re, "[REDACTED]");
  }
  return s;
}

/** Apply scrubber to every value in a flat tags object. */
function scrubTags(tags) {
  if (SCRUB_PATTERNS.length === 0) return tags;
  const out = {};
  for (const [k, v] of Object.entries(tags)) out[k] = scrubValue(v);
  return out;
}

// Apply scrubber to baseTags now (after the helper is defined). All sinks
// read from baseTags below, so this single application covers them all.
baseTags = scrubTags(baseTags);

// ---------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------

function formatNsForSlack(ns) {
  if (ns == null) return "?";
  const abs = Math.abs(ns);
  if (abs < 1_000) return `${ns} ns`;
  if (abs < 1_000_000) return `${(ns / 1_000).toFixed(1)} us`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

async function sendSlack(url) {
  if (!url) throw new Error("webhook-url required for slack sink");
  const lines = [];
  const emoji = hasRegression ? ":rotating_light:" : ":large_green_circle:";
  lines.push(`${emoji} *subms-action-diff* - ${baseTags.workload} (${baseTags.lang})`);
  if (isDiff) {
    const regressed = rows.filter((r) => r.worst_regression_pct > 0 && r.delta_pct > 0);
    const top = [...new Map(regressed.map((r) => [r.stage, r])).values()]
      .sort((a, b) => b.worst_regression_pct - a.worst_regression_pct)
      .slice(0, 5);
    if (top.length === 0) {
      lines.push("No stage regressed.");
    } else {
      lines.push("Worst regressing stages:");
      for (const r of top) {
        lines.push(`• \`${r.stage}\` worst +${r.worst_regression_pct.toFixed(1)}%`);
      }
    }
  } else {
    lines.push("Per-stage p99:");
    const seen = new Set();
    for (const r of rows.filter((x) => x.metric === "p99")) {
      if (seen.has(r.stage)) continue;
      seen.add(r.stage);
      lines.push(`• \`${r.stage}\` p99 = ${formatNsForSlack(r.value_ns)}`);
    }
  }
  const payload = JSON.stringify({ text: lines.join("\n") });
  const res = await httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`slack webhook responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendHttp(url, method, headers) {
  if (!url) throw new Error("webhook-url required for http sink");
  const payload = JSON.stringify({
    workload, lang, tags: baseTags, has_regression: hasRegression, rows,
  });
  const res = await httpRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: payload,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`http sink responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

function tagsToPromLabels(extra = {}) {
  const all = { ...baseTags, ...extra };
  return Object.entries(all)
    .map(([k, v]) => `${k.replace(/[^a-zA-Z0-9_]/g, "_")}="${String(v).replace(/"/g, '\\"')}"`)
    .join(",");
}

async function sendPrometheus(gateway, jobName) {
  if (!gateway) throw new Error("prometheus-pushgateway required for prometheus sink");
  // Prometheus pushgateway expects text exposition format. Job name is a
  // path segment; static labels can be added in the URL path too.
  const url = `${gateway.replace(/\/$/, "")}/metrics/job/${encodeURIComponent(jobName)}`;
  const lines = [];
  // Emit one gauge per (metric, stage) pair. If the input is a diff we
  // expose both candidate value and delta percentage.
  for (const r of rows) {
    const labels = tagsToPromLabels({ stage: r.stage, metric: r.metric });
    if (isDiff) {
      lines.push(`# HELP ${METRIC_PREFIX}_candidate_ns Candidate value, ns`);
      lines.push(`# TYPE ${METRIC_PREFIX}_candidate_ns gauge`);
      lines.push(`${METRIC_PREFIX}_candidate_ns{${labels}} ${r.candidate_ns}`);
      lines.push(`${METRIC_PREFIX}_baseline_ns{${labels}} ${r.baseline_ns}`);
      lines.push(`${METRIC_PREFIX}_delta_pct{${labels}} ${Number.isFinite(r.delta_pct) ? r.delta_pct : 0}`);
    } else {
      lines.push(`${METRIC_PREFIX}_value_ns{${labels}} ${r.value_ns}`);
    }
  }
  if (isDiff) {
    lines.push(`${METRIC_PREFIX}_has_regression{${tagsToPromLabels()}} ${hasRegression ? 1 : 0}`);
  }
  const body = lines.join("\n") + "\n";
  const res = await httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`pushgateway responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

function influxEscape(s) {
  return String(s).replace(/[\s,=]/g, (m) => `\\${m}`);
}

async function sendInflux(url, token) {
  if (!url) throw new Error("influx-url required for influxdb sink");
  // Line protocol: <measurement>,<tags> <fields> <timestamp_ns?>
  const ts = Date.now() * 1_000_000;   // ms -> ns for InfluxDB precision=ns
  const measurement = METRIC_PREFIX;
  const lines = [];
  for (const r of rows) {
    const tagPairs = Object.entries({ ...baseTags, stage: r.stage, metric: r.metric })
      .map(([k, v]) => `${influxEscape(k)}=${influxEscape(v)}`)
      .join(",");
    const fields = isDiff
      ? `candidate_ns=${r.candidate_ns},baseline_ns=${r.baseline_ns},delta_pct=${Number.isFinite(r.delta_pct) ? r.delta_pct : 0}`
      : `value_ns=${r.value_ns}`;
    lines.push(`${measurement},${tagPairs} ${fields} ${ts}`);
  }
  if (isDiff) {
    const tagPairs = Object.entries(baseTags)
      .map(([k, v]) => `${influxEscape(k)}=${influxEscape(v)}`)
      .join(",");
    lines.push(`${measurement}_meta,${tagPairs} has_regression=${hasRegression ? 1 : 0}i ${ts}`);
  }
  const body = lines.join("\n");
  const headers = { "Content-Type": "text/plain; charset=utf-8" };
  if (token) headers.Authorization = `Token ${token}`;
  const res = await httpRequest(url, { method: "POST", headers, body });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`influx responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendDatadog(apiKey, site) {
  if (!apiKey) throw new Error("datadog-api-key required for datadog sink");
  const url = `https://api.${site}/api/v2/series`;
  const nowSec = Math.floor(Date.now() / 1000);
  const tagList = Object.entries(baseTags).map(([k, v]) => `${k}:${v}`);
  const series = [];
  for (const r of rows) {
    const baseName = `${METRIC_PREFIX}.${isDiff ? "candidate_ns" : "value_ns"}`;
    series.push({
      metric: baseName,
      type: 3,                          // gauge
      points: [{ timestamp: nowSec, value: isDiff ? r.candidate_ns : r.value_ns }],
      tags: [...tagList, `stage:${r.stage}`, `metric:${r.metric}`],
    });
    if (isDiff) {
      series.push({
        metric: `${METRIC_PREFIX}.delta_pct`,
        type: 3,
        points: [{ timestamp: nowSec, value: Number.isFinite(r.delta_pct) ? r.delta_pct : 0 }],
        tags: [...tagList, `stage:${r.stage}`, `metric:${r.metric}`],
      });
    }
  }
  if (isDiff) {
    series.push({
      metric: `${METRIC_PREFIX}.has_regression`,
      type: 3,
      points: [{ timestamp: nowSec, value: hasRegression ? 1 : 0 }],
      tags: tagList,
    });
  }
  const res = await httpRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "DD-API-KEY": apiKey },
    body: JSON.stringify({ series }),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`datadog responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

function sendStdout() {
  for (const r of rows) {
    process.stdout.write(
      JSON.stringify({ workload, lang, tags: baseTags, ...r, has_regression: hasRegression }) + "\n",
    );
  }
}

function sendFile(filePath) {
  if (!filePath) throw new Error("file-path required for file sink");
  const lines = rows.map(
    (r) => JSON.stringify({ workload, lang, tags: baseTags, ...r, has_regression: hasRegression }),
  );
  // Append (rather than overwrite) so multiple runs accumulate in the same
  // file - useful for local replay / pipelines that tail the file.
  fs.appendFileSync(filePath, lines.join("\n") + "\n");
}

/** Render the canonical payload as a single JSON document (used by cloud-object
 *  sinks where one upload = one bench run). */
function canonicalPayload() {
  return JSON.stringify({
    workload,
    lang,
    tags: baseTags,
    has_regression: hasRegression,
    rows,
  });
}

async function sendS3(url) {
  // S3 sink uses a presigned URL PUT - that's what makes the action portable
  // (no SigV4 implementation needed, no AWS CLI dependency). Caller is
  // responsible for generating the URL via `aws s3 presign` or equivalent.
  if (!url) throw new Error("s3-url (presigned PUT URL) required for s3 sink");
  const res = await httpRequest(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: canonicalPayload(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`s3 (presigned PUT) responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendGcs(url) {
  // GCS V4 signed-URL PUT. Caller pre-signs externally (`gcloud storage sign-url`).
  if (!url) throw new Error("gcs-url (signed PUT URL) required for gcs sink");
  const res = await httpRequest(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: canonicalPayload(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`gcs (signed PUT) responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendAzure(url) {
  // Azure Blob via SAS-token URL PUT (BlockBlob). Caller generates the
  // SAS token via `az storage blob generate-sas` or the portal.
  if (!url) throw new Error("azure-url (SAS PUT URL) required for azure sink");
  const res = await httpRequest(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-ms-blob-type": "BlockBlob",
      "x-ms-version": "2021-08-06",
    },
    body: canonicalPayload(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`azure-blob responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendSplunk(url, token) {
  if (!url) throw new Error("splunk-url required for splunk sink (e.g. https://splunk.example.com:8088/services/collector)");
  if (!token) throw new Error("splunk-token (HEC token) required for splunk sink");
  // Splunk HEC takes one JSON document per request with `event` containing
  // the payload. We emit one HEC event per (stage, metric) row so trends
  // are queryable inside Splunk.
  const nowMs = Date.now();
  const events = rows.map((r) => ({
    time: nowMs / 1000,
    source: "subms-diff-sink",
    sourcetype: "subms_perf",
    event: { workload, lang, tags: baseTags, ...r, has_regression: hasRegression },
  }));
  const body = events.map((e) => JSON.stringify(e)).join("");
  const res = await httpRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Splunk ${token}`,
    },
    body,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`splunk HEC responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendNewRelic(licenseKey, region) {
  if (!licenseKey) throw new Error("newrelic-license-key required for newrelic sink");
  // New Relic Metric API (gauges). EU region uses metric-api.eu.newrelic.com.
  const host = region === "eu" ? "metric-api.eu.newrelic.com" : "metric-api.newrelic.com";
  const url = `https://${host}/metric/v1`;
  const nowMs = Date.now();
  const commonAttrs = Object.fromEntries(
    Object.entries(baseTags).map(([k, v]) => [k.replace(/[^A-Za-z0-9._]/g, "_"), String(v)]),
  );
  const metrics = [];
  for (const r of rows) {
    const tags = { ...commonAttrs, stage: r.stage, metric: r.metric };
    metrics.push({
      name: `${METRIC_PREFIX}.${isDiff ? "candidate_ns" : "value_ns"}`,
      type: "gauge",
      value: isDiff ? r.candidate_ns : r.value_ns,
      timestamp: nowMs,
      attributes: tags,
    });
    if (isDiff) {
      metrics.push({
        name: `${METRIC_PREFIX}.delta_pct`,
        type: "gauge",
        value: Number.isFinite(r.delta_pct) ? r.delta_pct : 0,
        timestamp: nowMs,
        attributes: tags,
      });
    }
  }
  const body = JSON.stringify([{ common: { timestamp: nowMs }, metrics }]);
  const res = await httpRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": licenseKey,
    },
    body,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`newrelic responded ${res.status}: ${res.body.slice(0, 200)}`);
  }
}

async function sendHoneycomb(apiKey, dataset, region) {
  if (!apiKey) throw new Error("honeycomb-api-key required for honeycomb sink");
  if (!dataset) throw new Error("honeycomb-dataset required for honeycomb sink");
  const host = region === "eu" ? "api.eu1.honeycomb.io" : "api.honeycomb.io";
  const url = `https://${host}/1/events/${encodeURIComponent(dataset)}`;
  // One event per (stage, metric). Honeycomb's events are flat so we
  // promote tags + stage + metric to top-level fields.
  for (const r of rows) {
    const event = {
      workload, lang, has_regression: hasRegression,
      ...baseTags,
      stage: r.stage, metric: r.metric,
      ...(isDiff
        ? { candidate_ns: r.candidate_ns, baseline_ns: r.baseline_ns, delta_pct: Number.isFinite(r.delta_pct) ? r.delta_pct : 0 }
        : { value_ns: r.value_ns }),
    };
    const res = await httpRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Honeycomb-Team": apiKey },
      body: JSON.stringify(event),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`honeycomb responded ${res.status}: ${res.body.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------------
// Dispatch - supports comma-separated multi-sink, e.g. "slack,prometheus,s3".
// Per-sink failures are isolated: one bad sink shouldn't suppress the others.
// ---------------------------------------------------------------------

async function runSink(name) {
  switch (name) {
    case "slack":
      return sendSlack(env.WEBHOOK_URL);
    case "http":
    case "rest":
      return sendHttp(env.WEBHOOK_URL, env.HTTP_METHOD || "POST", safeJsonParse(env.HTTP_HEADERS, {}));
    case "prometheus":
      return sendPrometheus(env.PROMETHEUS_PUSHGATEWAY, env.PROMETHEUS_JOB || "subms-diff");
    case "influxdb":
      return sendInflux(env.INFLUX_URL, env.INFLUX_TOKEN);
    case "datadog":
      return sendDatadog(env.DATADOG_API_KEY, env.DATADOG_SITE || "datadoghq.com");
    case "stdout":
      return sendStdout();
    case "file":
      return sendFile(env.FILE_PATH);
    case "s3":
      return sendS3(env.S3_URL);
    case "gcs":
      return sendGcs(env.GCS_URL);
    case "azure":
      return sendAzure(env.AZURE_URL);
    case "splunk":
      return sendSplunk(env.SPLUNK_URL, env.SPLUNK_TOKEN);
    case "newrelic":
      return sendNewRelic(env.NEWRELIC_LICENSE_KEY, env.NEWRELIC_REGION || "us");
    case "honeycomb":
      return sendHoneycomb(env.HONEYCOMB_API_KEY, env.HONEYCOMB_DATASET, env.HONEYCOMB_REGION || "us");
    default:
      throw new Error(`unknown sink "${name}"`);
  }
}

(async () => {
  const sinkNames = SINK.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const succeeded = [];
  const failed = [];
  for (const name of sinkNames) {
    try {
      await runSink(name);
      succeeded.push(name);
      process.stdout.write(`subms-diff-sink: ${rows.length} rows -> ${name}\n`);
    } catch (e) {
      err(`${name} sink failed: ${e.message}`);
      failed.push({ name, error: e.message });
    }
  }
  setOutput("pushed", succeeded.length > 0 ? "true" : "false");
  setOutput("sink", succeeded.join(","));
  setOutput("failed-sinks", failed.map((f) => f.name).join(","));
  if (failed.length > 0 && FAIL_ON_SINK_ERROR) {
    process.exit(1);
  }
})();
