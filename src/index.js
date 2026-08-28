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
  const route = isIndex || isFavicon ? null : resolveTool(url.pathname);
  if (!isIndex && !isFavicon && !route) return textResponse("not found\n", 404, request);

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

  const nonce = createNonce();
  const html = render(files, commit, nonce);
  const headers = securityHeaders({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`,
    "Content-Security-Policy": htmlCsp(nonce),
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

function htmlCsp(nonce) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'none'",
  ].join("; ");
}

function render(files, commit, nonce) {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const names = files.map((file) => file.name);
  const sample = esc(names[0] || "tool");
  const rows = files.map((file, index) => scriptEntry(file, index, commit)).join("");
  const safeNonce = esc(nonce);

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
<style nonce="${safeNonce}">
:root{--paper:#000;--raised:#0a0a0a;--ink:#cdc4ba;--dim:#b0a9a0;--muted:#958f87;--faint:#7a756e;--line:rgba(205,196,186,.26);--soft:rgba(205,196,186,.13);--strong:rgba(205,196,186,.42);--tint:rgba(205,196,186,.05);--display:"Fraunces",Georgia,serif;--sans:"Space Grotesk",system-ui,sans-serif;--mono:"Space Mono",ui-monospace,monospace;--max:1080px;--wide:1440px;--gutter:clamp(1.15rem,4vw,3rem);--section:clamp(2.5rem,6vw,4.75rem);--move:.17s;--ease:cubic-bezier(.215,.61,.355,1)}
*{box-sizing:border-box;margin:0;padding:0}html{color-scheme:dark;scroll-behavior:smooth}html,body{width:100%;max-width:100%;overflow-x:clip}body{background:var(--paper);color:var(--dim);font:clamp(.94rem,.9rem + .18vw,1rem)/1.65 var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}body:before{content:"";position:fixed;inset:0;z-index:9999;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='256'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='256' height='256' filter='url(%23n)'/%3E%3C/svg%3E");opacity:.055}::selection{background:var(--ink);color:var(--paper)}a{color:inherit}button{font:inherit}h1,h2,h3{color:var(--ink);font-family:var(--display);font-weight:400;letter-spacing:-.01em;line-height:1;text-wrap:balance}.wrap{width:100%;max-width:var(--max);margin-inline:auto;padding-inline:var(--gutter)}.wide{width:100%;max-width:var(--wide);margin-inline:auto;padding-inline:var(--gutter)}.mono{font-family:var(--mono)}.hdr{position:fixed;z-index:100;inset:0 0 auto;height:56px;display:flex;align-items:center;border-bottom:1px solid transparent;transition:background var(--move),border-color var(--move)}.hdr.solid{background:rgba(0,0,0,.9);backdrop-filter:blur(8px);border-color:var(--line)}.hdr__in{display:flex;align-items:center;justify-content:space-between;gap:1rem}.logo{display:flex;gap:.5rem;align-items:baseline;color:var(--ink);text-decoration:none}.logo__t{font:clamp(.65rem,.55rem + .5vw,.75rem) var(--mono);color:var(--muted)}.nav{display:flex;align-items:center;gap:clamp(.9rem,3vw,1.5rem)}.nav a,.motion{font-size:.625rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);background:none;border:0;text-decoration:none;cursor:pointer}.nav a:hover,.motion:hover{color:var(--ink)}:where(a,button):focus-visible{outline:2px solid var(--ink);outline-offset:4px;border-radius:2px}.hero{position:relative;padding:calc(56px + 2.5rem) 0 3.5rem}.hero:after{content:"";position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(var(--line) 1px,transparent 1.3px);background-size:22px 22px;opacity:.45;mask-image:radial-gradient(100% 75% at 84% 25%,#000 10%,transparent 70%)}.hero__grid{position:relative;z-index:1;display:grid;grid-template-columns:1fr;gap:2rem}.eyebrow{display:flex;align-items:center;gap:.75rem;margin-bottom:1.5rem;color:var(--muted);font-size:.66rem;font-weight:500;letter-spacing:.22em;text-transform:uppercase}.eyebrow:after{content:"";height:1px;flex:1;background:var(--line)}.eyebrow__k{color:var(--ink);font:.9rem var(--display);letter-spacing:0}.live{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1rem}.dot{width:6px;height:6px;border-radius:50%;background:var(--ink);animation:blink 1.5s infinite}.micro,.label{font-size:.625rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}h1{font:400 clamp(1.75rem,1rem + 4.4vw,3.4rem)/1 var(--mono)}.lede{max-width:58ch;margin-top:1rem;color:var(--muted)}.spec{max-width:540px;margin-top:2rem}.spec__row{display:flex;align-items:baseline;gap:.75rem;padding:.5rem 0;border-bottom:1px solid var(--soft)}.spec__k{font-size:.6875rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.spec__lead{flex:1;border-bottom:1px dotted var(--soft);transform:translateY(-.28em)}.spec__v{font:.76rem var(--mono);color:var(--ink);overflow-wrap:anywhere}.readout,.cmd{background:var(--raised);border:1px solid var(--line);border-radius:2px}.readout{padding:clamp(.75rem,3vw,1rem);font:clamp(.7rem,.65rem + .25vw,.78rem)/1.75 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere}.usage-label{margin-bottom:.75rem}.usage-note{margin-top:1rem;line-height:1.8}.prompt,.comment{color:var(--faint)}.hl{color:var(--ink)}section:not(.hero){position:relative;padding-block:var(--section);border-top:1px solid var(--line)}section[id]{scroll-margin-top:72px}.stmt{max-width:28ch;font:400 clamp(1.25rem,1rem + 1.4vw,1.85rem)/1.2 var(--sans);margin-bottom:2rem}.entry{display:grid;gap:1rem;padding:2rem 0;border-bottom:1px solid var(--soft)}.entry:last-child{border-bottom:0;padding-bottom:0}.entry__head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}.entry__idx{margin-bottom:.5rem;font:.5625rem var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}.entry__name{font-size:clamp(1.5rem,1.1rem + 1.6vw,2.1rem)}.entry__meta{font:.7rem/1.65 var(--mono);color:var(--faint);overflow-wrap:anywhere}.entry__note{max-width:65ch;color:var(--muted)}.hash{font:.67rem/1.65 var(--mono);color:var(--faint);overflow-wrap:anywhere}.cmd{display:flex;flex-direction:column;min-width:0;transition:border-color var(--move)}.cmd:hover{border-color:var(--strong)}.cmd__text{min-width:0;padding:.85rem 1rem;font:clamp(.68rem,.63rem + .25vw,.75rem)/1.7 var(--mono);color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}.cmd__btn{padding:.75rem 1rem;border:0;border-top:1px solid var(--line);background:transparent;color:var(--muted);font-size:.625rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;text-align:right;cursor:pointer}.cmd__btn:hover{background:var(--tint);color:var(--ink)}.copy-status{min-height:1.25em;color:var(--muted);font-size:.72rem}.links{display:flex;gap:1.5rem;flex-wrap:wrap}.glink{position:relative;color:var(--muted);font-size:.625rem;font-weight:500;letter-spacing:.14em;text-transform:uppercase;text-decoration:none}.glink:after{content:"";position:absolute;left:0;bottom:-3px;width:100%;height:1px;background:currentColor;transform:scaleX(0);transform-origin:left;transition:transform var(--move) var(--ease)}.glink:hover{color:var(--ink)}.glink:hover:after{transform:scaleX(1)}.two{display:grid;grid-template-columns:1fr;gap:3rem}.notes{display:grid;gap:1.5rem}.note p:last-child{color:var(--muted);font-size:.94rem}.note .label{margin-bottom:.25rem}.plate{position:relative;padding:clamp(1rem,4vw,2rem);border:1px solid var(--line);background:var(--raised)}.plate .stmt{margin-bottom:1.5rem}.readout--rows{display:grid;gap:.75rem;margin-top:1.5rem}.rot{display:inline-block;min-width:10ch;color:var(--ink)}.rot__t{display:inline-block}.rot.is-live .rot__t{animation:rotFade 3s linear infinite}.motion-off .rot.is-live .rot__t,.motion-off .dot{animation:none}.ftr{padding-top:3rem;border-top:1px solid var(--line);overflow:clip}.ftr__word{margin-bottom:-1.5rem;color:transparent;font:clamp(4rem,22vw,15rem)/.8 var(--display);text-align:center;-webkit-text-stroke:1px var(--line);user-select:none}.ftr__bar{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-top:2rem;padding:1rem 0 1.5rem;border-top:1px solid var(--soft);font:.625rem var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}.ftr__bar a{text-decoration:none}.ftr__bar a:hover{color:var(--ink)}
@keyframes blink{0%,48%{opacity:1}60%,to{opacity:.18}}@keyframes blinkReduced{0%,48%{opacity:1}60%,to{opacity:.45}}@keyframes rotFade{0%{opacity:0;transform:translateY(.35em)}9%,91%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-.35em)}}@keyframes rotFadeReduced{0%,100%{opacity:.25}12%,88%{opacity:1}}
@media(max-width:420px){.nav a[href^="https"]{display:none}.nav{gap:.75rem}}
@media(min-width:660px){.cmd{flex-direction:row}.cmd__text{flex:1;white-space:nowrap;overflow-x:auto}.cmd__btn{border-top:0;border-left:1px solid var(--line);text-align:center}.entry__meta{text-align:right}}
@media(min-width:780px){.hero__grid{grid-template-columns:1.15fr .85fr;align-items:start;gap:4rem}.two{grid-template-columns:.95fr 1.05fr}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.rot.is-live .rot__t{animation-name:rotFadeReduced}.dot{animation-name:blinkReduced}.motion-on .rot.is-live .rot__t{animation-name:rotFade}.motion-on .dot{animation-name:blink}}
.motion-off .rot.is-live .rot__t{animation-name:rotFadeReduced}.motion-off .dot{animation:none}
</style>
</head>
<body>
<header class="hdr" id="hdr"><div class="wide hdr__in"><a class="logo" href="/"><span>源</span><span class="logo__t">${DOMAIN}</span></a><nav class="nav" aria-label="Primary"><a href="#scripts">Tools</a><a href="https://github.com/${REPO}">Source</a><button class="motion" id="motion" type="button" aria-pressed="true">Motion: on</button></nav></div></header>
<main>
<section class="hero"><div class="wrap hero__grid"><div><p class="eyebrow"><span class="eyebrow__k">源</span> Tool index</p><div class="live"><span class="dot" aria-hidden="true"></span><span class="micro">Serving from the edge</span></div><h1>${DOMAIN}</h1><p class="lede">A small, explicit allowlist from <span class="mono">${REPO}</span>. Every published tool is available through a short, memorable URL.</p><div class="spec">${specRow("Source", REPO)}${specRow("Commit", commit)}${specRow("Tools", String(files.length).padStart(2, "0"))}${specRow("Payload", fmtSize(total))}${specRow("Edge cache", `${CACHE_TTL / 60} min`)}</div></div><div><p class="label usage-label">Quick use</p><div class="readout"><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/</span><span class="rot" id="rot"><span class="rot__t">${sample}</span></span><span class="hl"> | sh</span></div><p class="micro usage-note">Choose a tool, copy the command, and run it in a privileged shell.</p></div></div></section>
<section id="scripts"><div class="wrap"><p class="eyebrow"><span class="eyebrow__k">具</span> Published</p><h2 class="stmt">Manifest-listed tools, verified one commit at a time.</h2>${rows}</div></section>
<section id="how"><div class="wrap two"><div><p class="eyebrow"><span class="eyebrow__k">道</span> Trust path</p><h2 class="stmt">The manifest is the boundary, not a directory listing.</h2></div><div class="notes"><div class="readout">GET /v/${commit}/<span class="comment">&lt;name&gt;</span>
  <span class="comment">├─</span> validate public route
  <span class="comment">├─</span> load manifest at the same commit
  <span class="comment">├─</span> fetch its declared tools/<span class="comment">&lt;name&gt;</span> source
  <span class="comment">└─</span> serve text with immutable caching</div><div class="note"><p class="label">No free proxy</p><p>Repository paths, subdirectories, hidden files, and names outside the local allowlist are never forwarded upstream.</p></div><div class="note"><p class="label">Simple routes</p><p>Each published tool has one direct route that follows the latest commit on the main branch.</p></div></div></div></section>
<section id="care"><div class="wrap"><p class="eyebrow"><span class="eyebrow__k">見</span> Before you run</p><div class="plate"><h2 class="stmt">Read it before you trust it.</h2><p class="entry__note">These tools can make system-wide changes. Review the source and understand the requested privileges before running them.</p><div class="readout readout--rows"><span><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/</span><span class="rot" id="rot2"><span class="rot__t">${sample}</span></span><span class="comment"> # print it</span></span><span><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/</span><span class="rot" id="rot3"><span class="rot__t">${sample}</span></span><span class="hl"> | sh</span><span class="comment"> # then run it</span></span></div></div></div></section>
</main>
<footer class="ftr"><div class="wide"><div class="ftr__word" aria-hidden="true">RAW</div><div class="ftr__bar"><span>One explicit manifest · ${REPO}</span><a href="https://github.com/${REPO}">github.com/${REPO} ↗</a><span>源 · ${DOMAIN}</span></div></div></footer>
<script nonce="${safeNonce}">
document.documentElement.classList.remove("no-js");
const hdr=document.getElementById("hdr");const onScroll=()=>hdr.classList.toggle("solid",scrollY>8);onScroll();addEventListener("scroll",onScroll,{passive:true});
const motion=document.getElementById("motion");const applyMotion=value=>{document.documentElement.classList.toggle("motion-off",value==="off");document.documentElement.classList.toggle("motion-on",value==="on");motion.setAttribute("aria-pressed",String(value!=="off"));motion.textContent=value==="off"?"Motion: off":"Motion: on"};let motionValue=null;try{motionValue=localStorage.getItem("raw-motion")}catch(error){console.warn("Motion preference unavailable",error)}applyMotion(motionValue);motion.addEventListener("click",()=>{motionValue=motionValue==="off"?"on":"off";try{localStorage.setItem("raw-motion",motionValue)}catch(error){console.warn("Motion preference could not be saved",error)}applyMotion(motionValue)});
document.querySelectorAll("[data-copy]").forEach(button=>{button.addEventListener("click",async()=>{const status=document.getElementById(button.getAttribute("aria-describedby"));try{await navigator.clipboard.writeText(button.dataset.copy);button.textContent="Copied";status.textContent="Command copied to the clipboard.";setTimeout(()=>{button.textContent="Copy"},1400)}catch{button.textContent="Copy failed";status.textContent="Copy failed. Select and copy the command manually."}})});
const names=${JSON.stringify(names).replace(/</g, "\\u003c")};const rots=["rot","rot2","rot3"].map(id=>document.getElementById(id)).filter(Boolean);if(rots.length&&names.length>1){const texts=rots.map(node=>node.querySelector(".rot__t"));let index=0;texts[0].addEventListener("animationiteration",()=>{index=(index+1)%names.length;texts.forEach(node=>{node.textContent=names[index]})});rots.forEach(node=>node.classList.add("is-live"))}
</script>
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

  return `<article class="entry"><div><p class="entry__idx">${String(index).padStart(2, "0")} // ${esc(file.name.toUpperCase())}</p><div class="entry__head"><h3 class="entry__name">${glyph} &nbsp;${title}</h3><p class="entry__meta">${fmtSize(file.size)}<br>${target}</p></div></div><p class="entry__note">${note}</p><p class="hash"><span class="label">Commit</span> ${commit}<br><span class="label">SHA-256</span> ${digest}</p><div class="cmd"><code class="cmd__text">${esc(command)}</code><button class="cmd__btn" data-copy="${esc(command)}" aria-describedby="${statusId}" type="button">Copy</button></div><p class="copy-status" id="${statusId}" role="status" aria-live="polite"></p><div class="links"><a class="glink" href="https://github.com/${REPO}/blob/${commit}/${file.source.split("/").map(encodeURIComponent).join("/")}">View source ↗</a><a class="glink" href="/${encodedName}">Download latest</a></div></article>`;
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

function createNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
