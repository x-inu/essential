const REPO = "x-inu/essential";
const BRANCH = "main";
const DOMAIN = "raw.xinu.my.id";
const RAW_ORIGIN = "https://raw.githubusercontent.com";
const API_ORIGIN = "https://api.github.com";
const CACHE_TTL = 300;
const IMMUTABLE_TTL = 31536000;
const UPSTREAM_TIMEOUT_MS = 8000;
const VERSION_RE = /^[a-f0-9]{40}$/;
const PUBLIC_NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const INTERNAL_NAMES = new Set(["meta.json", "wrangler.toml"]);
const ASSET_PATHS = new Set(["/style.css", "/app.js"]);

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" fill="#000"/>
<text x="32" y="33" fill="#cdc4ba" font-family="Georgia,'Times New Roman',serif" font-size="46" text-anchor="middle" dominant-baseline="central">源</text>
</svg>`;

class UpstreamError extends Error {
  constructor(kind, message, status = 0, retryAfter = "") {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function fetch(request, env = {}, ctx = {}) {
  const method = String(request.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return textResponse("method not allowed\n", 405, request, { Allow: "GET, HEAD" });
  }

  const url = new URL(request.url);
  const isIndex = url.pathname === "/" || url.pathname === "";
  const isFavicon = url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico";
  const isAsset = ASSET_PATHS.has(url.pathname);
  const route = isIndex || isFavicon || isAsset ? null : resolveTool(url.pathname);
  if (!isIndex && !isFavicon && !isAsset && !route) return textResponse("not found\n", 404, request);

  if (isAsset) {
    try {
      return await serveAsset(request, env);
    } catch {
      return textResponse("asset unavailable\n", 502, request);
    }
  }

  const cache = getDefaultCache();
  const cacheKey = normalizedCacheKey(request, url);

  if (cache && cacheKey) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return new Response(isHead(request) ? null : cached.body, {
          status: cached.status,
          statusText: cached.statusText,
          headers: securityHeaders(cached.headers),
        });
      }
    } catch (error) {
      // Cache availability must never make the origin unavailable.
      console.warn("cache read failed", error);
    }
  }

  let response;
  try {
    if (isIndex) {
      response = await serveIndex(request, env);
    } else if (isFavicon) {
      response = faviconResponse(request);
    } else {
      const snapshot = route.versioned
        ? { commit: route.ref, manifest: await loadManifest(route.ref, env) }
        : await resolveMutableRef(env);
      const manifest = snapshot.manifest;
      const tool = manifest.find((item) => item.name === route.name);
      if (!tool) return textResponse("not found\n", 404, request);

      response = await serveTool(request, tool, snapshot.commit, route.versioned, env);
      if (!route.versioned) response.headers.set("X-Commit-SHA", snapshot.commit);
    }
  } catch (error) {
    response = upstreamErrorResponse(error, request);
  }

  if (method === "GET" && cache && cacheKey && response.status === 200) {
    const write = cache.put(cacheKey, response.clone()).catch((error) => {
      if (env && typeof env.onCacheError === "function") env.onCacheError(error);
      else console.warn("cache write failed", error);
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
  }

  return response;
}

export default { fetch };

export async function loadManifest(ref = BRANCH, env = {}) {
  if (ref !== BRANCH && !VERSION_RE.test(ref)) {
    throw new UpstreamError("manifest", "invalid manifest ref");
  }

  const url = rawUrl(ref, "meta.json");
  const response = await upstreamBytes(url, env, false, "manifest");
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(response.bytes));
  } catch {
    throw new UpstreamError("manifest", "invalid upstream manifest");
  }

  if (!isPlainObject(value)) {
    throw new UpstreamError("manifest", "invalid upstream manifest");
  }

  const seen = new Set();
  const tools = Object.entries(value).map(([name, item]) => {
    if (!isPlainObject(item)) throw new UpstreamError("manifest", "invalid upstream manifest");
    const keys = Object.keys(item).sort();
    const expected = ["kanji", "note", "requires_root", "shell", "source", "target", "title"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new UpstreamError("manifest", "invalid upstream manifest");
    }

    const { source, title, kanji, note, target, shell, requires_root: requiresRoot } = item;
    if (
      !validatePublicName(name) ||
      !validateSourcePath(source, name) ||
      seen.has(name) ||
      !nonEmptyText(title, 120) ||
      !nonEmptyText(kanji, 8) ||
      !nonEmptyText(note, 600) ||
      !Array.isArray(target) ||
      target.length === 0 ||
      target.some((os) => !validatePublicName(os)) ||
      shell !== "sh" ||
      requiresRoot !== true
    ) {
      throw new UpstreamError("manifest", "invalid upstream manifest");
    }

    seen.add(name);
    return { name, source, title, kanji, note, target, shell, requiresRoot };
  });

  if (tools.length === 0) throw new UpstreamError("manifest", "invalid upstream manifest");

  return tools;
}

export function validatePublicName(name) {
  return typeof name === "string" && PUBLIC_NAME_RE.test(name);
}

export function validateSourcePath(source, publicName) {
  if (typeof source !== "string" || source.includes("\\") || source.includes("%")) return false;
  const match = /^tools\/([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/.exec(source);
  return Boolean(match && validatePublicName(match[1]) && (!publicName || match[1] === publicName));
}

export function resolveTool(pathname) {
  if (typeof pathname !== "string") return null;

  const direct = /^\/([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/.exec(pathname);
  if (direct) {
    const name = direct[1];
    if (!validatePublicName(name) || INTERNAL_NAMES.has(name)) return null;
    return { name, ref: BRANCH, versioned: false };
  }

  const versioned = /^\/v\/([a-f0-9]{40})\/([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/.exec(pathname);
  if (!versioned) return null;
  const [, ref, name] = versioned;
  if (!VERSION_RE.test(ref) || !validatePublicName(name) || INTERNAL_NAMES.has(name)) return null;
  return { name, ref, versioned: true };
}

export async function fetchTool(tool, ref = BRANCH, env = {}) {
  if (
    !tool ||
    !validatePublicName(tool.name) ||
    !validateSourcePath(tool.source, tool.name) ||
    (ref !== BRANCH && !VERSION_RE.test(ref))
  ) {
    throw new UpstreamError("manifest", "invalid upstream manifest");
  }

  const response = await upstreamBytes(rawUrl(ref, tool.source), env, false, "tool");
  const { bytes } = response;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    bytes,
    size: bytes.byteLength,
    sha256: hex(digest),
    etag: response.headers.get("etag") || "",
    lastModified: response.headers.get("last-modified") || "",
  };
}

async function resolveMutableRef(env) {
  const commit = await loadCommitSha(env);
  return { commit, manifest: await loadManifest(commit, env) };
}

export async function serveTool(request, tool, ref = BRANCH, versioned = false, env = {}) {
  const result = await fetchTool(tool, ref, env);
  const headers = securityHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": versioned
      ? `public, max-age=${IMMUTABLE_TTL}, s-maxage=${IMMUTABLE_TTL}, immutable`
      : `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
    "X-Source": "github",
  });
  if (result.etag) headers.set("ETag", result.etag);
  if (result.lastModified) headers.set("Last-Modified", result.lastModified);
  return new Response(isHead(request) ? null : result.bytes, { status: 200, headers });
}

export async function serveIndex(request, env = {}) {
  const commit = await loadCommitSha(env);
  const manifest = await loadManifest(commit, env);
  const files = await Promise.all(
    manifest.map(async (tool) => ({ ...tool, ...(await fetchTool(tool, commit, env)) })),
  );
  files.sort((a, b) => a.name.localeCompare(b.name));

  const html = render(files, commit);
  const headers = securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
    "Content-Security-Policy": htmlCsp(),
  });
  return new Response(isHead(request) ? null : html, { status: 200, headers });
}

async function loadCommitSha(env) {
  const response = await upstreamBytes(`${API_ORIGIN}/repos/${REPO}/commits/${BRANCH}`, env, true, "commit");
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(response.bytes));
  } catch {
    throw new UpstreamError("upstream", "invalid upstream response");
  }
  if (!value || !VERSION_RE.test(value.sha)) {
    throw new UpstreamError("upstream", "invalid upstream response");
  }
  return value.sha;
}

async function upstreamBytes(url, env, api, resource) {
  return upstreamFetch(url, env, api, async (response) => {
    if (!response.ok) throw classifyUpstreamResponse(response, resource);
    return { bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers };
  });
}

async function upstreamFetch(url, env, api = false, consume = (response) => response) {
  const controller = new AbortController();
  const timeoutMs = positiveInteger(env && env.UPSTREAM_TIMEOUT_MS) || UPSTREAM_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({
    Accept: api ? "application/vnd.github+json" : "application/octet-stream",
    "User-Agent": `${DOMAIN} worker`,
  });
  if (api && env && env.GITHUB_TOKEN) headers.set("Authorization", `Bearer ${env.GITHUB_TOKEN}`);

  try {
    const response = await globalThis.fetch(url, { headers, signal: controller.signal });
    return await consume(response);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (error && (error.name === "AbortError" || controller.signal.aborted)) {
      throw new UpstreamError("timeout", "upstream timeout");
    }
    throw new UpstreamError("network", "upstream unavailable");
  } finally {
    clearTimeout(timer);
  }
}

function classifyUpstreamResponse(response, resource) {
  const retryAfter = response.headers.get("retry-after") || "";
  if (response.status === 404) return new UpstreamError("not-found", `${resource} not found`, 404);
  if (response.status === 429 || response.status === 403) {
    return new UpstreamError("rate-limit", "upstream rate limited", response.status, retryAfter);
  }
  return new UpstreamError("upstream", "upstream unavailable", response.status);
}

function upstreamErrorResponse(error, request) {
  if (!(error instanceof UpstreamError)) return textResponse("upstream unavailable\n", 502, request);
  if (error.kind === "not-found") return textResponse("not found\n", 404, request);
  if (error.kind === "rate-limit") {
    const extra = error.retryAfter ? { "Retry-After": error.retryAfter } : {};
    return textResponse("upstream rate limited\n", 503, request, extra);
  }
  if (error.kind === "timeout") return textResponse("upstream timeout\n", 504, request);
  if (error.kind === "manifest") return textResponse("invalid upstream manifest\n", 502, request);
  return textResponse("upstream unavailable\n", 502, request);
}

function normalizedCacheKey(request, url) {
  const method = String(request.method).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  return new Request(`${url.origin}${url.pathname}`, { method: "GET" });
}

function getDefaultCache() {
  try {
    return globalThis.caches && globalThis.caches.default ? globalThis.caches.default : null;
  } catch (error) {
    console.warn("Cache API unavailable", error);
    return null;
  }
}

function rawUrl(ref, source) {
  const segments = source.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${RAW_ORIGIN}/${REPO}/${encodeURIComponent(ref)}/${segments}`;
}

function faviconResponse(request) {
  return new Response(isHead(request) ? null : FAVICON, {
    headers: securityHeaders({
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    }),
  });
}

async function serveAsset(request, env) {
  if (!env || !env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    return textResponse("not found\n", 404, request);
  }

  const response = await env.ASSETS.fetch(request);
  if (!response.ok) return textResponse("not found\n", 404, request);

  const headers = securityHeaders(response.headers);
  headers.set("Cache-Control", `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`);
  return new Response(isHead(request) ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function textResponse(body, status, request, extra = {}) {
  return new Response(isHead(request) ? null : body, {
    status,
    headers: securityHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    }),
  });
}

function securityHeaders(initial = {}) {
  const headers = new Headers(initial);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  }
  return headers;
}

function htmlCsp() {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'none'",
  ].join("; ");
}

function render(files, commit) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const names = files.map((file) => file.name);
  const sample = esc(names[0] || "tool");
  const rows = files.map((file, index) => scriptEntry(file, index, commit)).join("");
  return `<!DOCTYPE html>
<html lang="en" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>源 raw.xinu</title>
<meta name="description" content="A verified allowlist of shell tools from ${REPO}, served from the Cloudflare edge.">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..600&amp;family=Space+Grotesk:wght@400;500&amp;family=Space+Mono:wght@400;700&amp;display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="hdr" id="hdr"><div class="wide hdr__in"><a class="logo" href="/"><span>源</span><span class="logo__t">${DOMAIN}</span></a><nav class="nav" aria-label="Primary"><a href="#scripts">Tools</a><a href="https://github.com/${REPO}">Source</a></nav></div></header>
<main>
<section class="hero"><div class="wrap hero__grid"><div><p class="eyebrow"><span class="eyebrow__k">源</span> Tool index</p><div class="live"><span class="dot" aria-hidden="true"></span><span class="micro">Serving from the edge</span></div><h1>${DOMAIN}</h1><p class="lede">A small, explicit allowlist from <span class="mono">${REPO}</span>. Every published tool is available through a short, memorable URL.</p><div class="spec">${specRow("Source", REPO)}${specRow("Commit", commit)}${specRow("Tools", String(files.length).padStart(2, "0"))}${specRow("Payload", fmtSize(total))}${specRow("Edge cache", `${CACHE_TTL / 60} min`)}</div></div><div><p class="label usage-label">Quick use</p><div class="readout"><span class="quick-command"><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/&lt;name&gt; | sh</span></span></div><p class="micro usage-note">Choose a tool, copy the command, and run it in a privileged shell.</p></div></div></section>
<section id="scripts"><div class="wrap"><p class="eyebrow"><span class="eyebrow__k">具</span> Published</p><h2 class="stmt">Manifest-listed tools, verified one commit at a time.</h2>${rows}</div></section>
<section id="how"><div class="wrap two"><div><p class="eyebrow"><span class="eyebrow__k">道</span> Trust path</p><h2 class="stmt">The manifest is the boundary, not a directory listing.</h2></div><div class="notes"><div class="readout">GET https://${DOMAIN}/<span class="rot" id="rot4"><span class="rot__t">${sample}</span></span>
  <span class="comment">├─</span> validate public route
  <span class="comment">├─</span> load manifest at the same commit
  <span class="comment">├─</span> fetch its declared tools/<span class="comment">&lt;name&gt;</span> source
  <span class="comment">└─</span> serve text with edge caching</div><div class="note"><p class="label">No free proxy</p><p>Repository paths, subdirectories, hidden files, and names outside the local allowlist are never forwarded upstream.</p></div><div class="note"><p class="label">Simple routes</p><p>Each published tool has one direct route that follows the latest commit on the main branch.</p></div></div></div></section>
<section id="care"><div class="wrap"><p class="eyebrow"><span class="eyebrow__k">見</span> Before you run</p><div class="plate"><h2 class="stmt">Read it before you trust it.</h2><p class="entry__note">These tools can make system-wide changes. Review the source and understand the requested privileges before running them.</p><div class="readout readout--rows"><span class="command-row"><span class="command-row__code"><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/</span><span class="rot" id="rot2"><span class="rot__t">${sample}</span></span></span><span class="comment"># print it</span></span><span class="command-row"><span class="command-row__code"><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/</span><span class="rot" id="rot3"><span class="rot__t">${sample}</span></span><span class="hl"> | sh</span></span><span class="comment"># then run it</span></span></div></div></div></section>
</main>
<footer class="ftr"><div class="wide"><div class="ftr__word" aria-hidden="true">RAW</div><div class="ftr__bar"><span>One explicit manifest · ${REPO}</span><a href="https://github.com/${REPO}">github.com/${REPO} ↗</a><span>源 · ${DOMAIN}</span></div></div></footer>
</body>
</html>`;
}

function scriptEntry(file, index, commit) {
  const name = esc(file.name);
  const title = esc(file.title);
  const note = esc(file.note);
  const target = esc(file.target.join(" · "));
  const digest = esc(file.sha256);
  const encodedName = encodeURIComponent(file.name);
  const command = `curl -fsSL https://${DOMAIN}/${encodedName} | sh`;
  const statusId = `copy-status-${index}`;
  const glyph = esc(file.kanji);

  return `<article class="entry" data-tool-name="${name}"><div><p class="entry__idx">${String(index).padStart(2, "0")} // ${esc(file.name.toUpperCase())}</p><div class="entry__head"><h3 class="entry__name">${glyph} &nbsp;${title}</h3><p class="entry__meta">${fmtSize(file.size)}<br>${target}</p></div></div><p class="entry__note">${note}</p><p class="hash"><span class="label">Commit</span> ${commit}<br><span class="label">SHA-256</span> ${digest}</p><div class="cmd"><code class="cmd__text">${esc(command)}</code><button class="cmd__btn" data-copy="${esc(command)}" aria-describedby="${statusId}" type="button">Copy</button></div><p class="copy-status" id="${statusId}" role="status" aria-live="polite"></p><div class="links"><a class="glink" href="https://github.com/${REPO}/blob/${commit}/${file.source.split("/").map(encodeURIComponent).join("/")}">View source ↗</a><a class="glink" href="/${encodedName}">Download latest</a></div></article>`;
}

function specRow(label, value) {
  return `<div class="spec__row"><span class="spec__k">${esc(label)}</span><span class="spec__lead"></span><span class="spec__v">${esc(value)}</span></div>`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isHead(request) {
  return String(request.method || "GET").toUpperCase() === "HEAD";
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function nonEmptyText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}
