import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, {
  fetch as workerFetch,
  fetchTool,
  loadManifest,
  resolveTool,
  validatePublicName,
  validateSourcePath,
} from "../src/index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const manifest = {
  cinit: {
      source: "tools/cinit",
      title: "Disable cloud-init",
      kanji: "止",
      note: "Stop cloud-init safely.",
      target: ["debian", "ubuntu"],
      shell: "sh",
      requires_root: true,
    },
  sudo: {
      source: "tools/sudo",
      title: "Install sudo",
      kanji: "権",
      note: "Install sudo safely.",
      target: ["debian", "ubuntu", "fedora", "arch", "alpine"],
      shell: "sh",
      requires_root: true,
    },
};

const manifestTools = Object.entries(manifest).map(([name, item]) => ({
  name,
  source: item.source,
  title: item.title,
  kanji: item.kanji,
  note: item.note,
  target: item.target,
  shell: item.shell,
  requiresRoot: item.requires_root,
}));

const dispatch = (request, env, ctx) => worker.fetch(request, env, ctx);

test("checked-in meta.json is the exact explicit allowlist", async () => {
  const checkedIn = JSON.parse(
    await readFile(new URL("../meta.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(checkedIn, {
    sudo: {
        source: "tools/sudo",
        title: "Install sudo",
        kanji: "権",
        note: "Installs sudo and safely grants administrative rights to an existing user.",
        target: ["debian", "ubuntu", "fedora", "arch", "alpine"],
        shell: "sh",
        requires_root: true,
      },
    cinit: {
        source: "tools/cinit",
        title: "Disable cloud-init",
        kanji: "止",
        note: "Safely disables cloud-init and preserves the previous network configuration.",
        target: ["debian", "ubuntu"],
        shell: "sh",
        requires_root: true,
      },
  });
});

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function toolBody(name, headers = {}) {
  return new Response(`#!/bin/sh\necho ${name}\n`, {
    headers: {
      etag: `"${name}-etag"`,
      "last-modified": "Fri, 28 Aug 2026 00:00:00 GMT",
      ...headers,
    },
  });
}

function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function installCache(cache) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: { default: cache },
  });
  return () => {
    if (descriptor) Object.defineProperty(globalThis, "caches", descriptor);
    else delete globalThis.caches;
  };
}

async function body(response) {
  return response.text();
}

test("strict public names and source paths accept only the allowlist shape", () => {
  for (const name of ["sudo", "cinit", "a-b", "a_b", "a.b", "a1"]) {
    assert.equal(validatePublicName(name), true, name);
  }
  for (const name of ["", ".sudo", "sudo/now", "SUDO", "sudo%2fnow", "sudo;id", "-sudo", "sudo-"]) {
    assert.equal(validatePublicName(name), false, name);
  }
  assert.equal(validateSourcePath("tools/sudo", "sudo"), true);
  assert.equal(validateSourcePath("tools/cinit", "cinit"), true);
  for (const source of ["sudo", "/tools/sudo", "tools//sudo", "tools/sudo/x", "tools/../sudo", "tools/%73udo", "tools\\sudo"]) {
    assert.equal(validateSourcePath(source, "sudo"), false, source);
  }
});

test("resolveTool supports direct and exact version routes only", () => {
  assert.deepEqual(resolveTool("/sudo"), { name: "sudo", ref: "main", versioned: false });
  assert.deepEqual(resolveTool(`/v/${SHA}/cinit`), { name: "cinit", ref: SHA, versioned: true });
  for (const path of [
    "/tools/sudo",
    "/src/index.js",
    "/meta.json",
    "/sudo/subdir",
    "/sudo;id",
    "/sudo%2fsubdir",
    `/v/${SHA.toUpperCase()}/sudo`,
    `/v/${SHA}/sudo/subdir`,
  ]) {
    assert.equal(resolveTool(path), null, path);
  }
});

test("loadManifest accepts the exact manifest shape", async (t) => {
  const restore = installFetch(async (url) => {
    assert.equal(url, `https://raw.githubusercontent.com/x-inu/essential/${SHA}/meta.json`);
    return json(manifest);
  });
  t.after(restore);
  assert.deepEqual(await loadManifest(SHA), manifestTools);
});

test("loadManifest rejects extra roots, extra fields, missing tools, duplicates, and source mismatches", async (t) => {
  const values = [
    { ...manifest, "bad;name": manifest.cinit },
    { ...manifest, cinit: { ...manifest.cinit, extra: true } },
    {},
    { ...manifest, cinit: { ...manifest.cinit, source: "tools/sudo" } },
    { ...manifest, cinit: { ...manifest.cinit, source: "../cinit" } },
    { ...manifest, cinit: { ...manifest.cinit, target: "debian" } },
  ];
  let index = 0;
  const restore = installFetch(async () => json(values[index++]));
  t.after(restore);
  for (const value of values) {
    await assert.rejects(loadManifest(SHA), /invalid upstream manifest/, JSON.stringify(value));
  }
});

test("invalid manifests are differentiated from missing and rate-limited upstreams", async (t) => {
  const responses = [
    json({ sha: SHA }),
    new Response("bad json"),
    json({ sha: SHA }),
    new Response("missing", { status: 404 }),
    json({ sha: SHA }),
    new Response("limited", { status: 429, headers: { "retry-after": "60" } }),
  ];
  const restoreFetch = installFetch(async () => responses.shift());
  const restoreCache = installCache({ match: async () => undefined, put: async () => {} });
  t.after(restoreFetch);
  t.after(restoreCache);

  const invalid = await dispatch(new Request("https://raw.xinu.my.id/sudo"));
  assert.equal(invalid.status, 502);
  assert.equal(await body(invalid), "invalid upstream manifest\n");

  const missing = await dispatch(new Request("https://raw.xinu.my.id/sudo"));
  assert.equal(missing.status, 404);
  assert.equal(await body(missing), "not found\n");

  const limited = await dispatch(new Request("https://raw.xinu.my.id/sudo"));
  assert.equal(limited.status, 503);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.equal(await body(limited), "upstream rate limited\n");
});

test("unsupported methods return 405 with Allow and never call upstream", async (t) => {
  let calls = 0;
  const restore = installFetch(async () => {
    calls += 1;
    return new Response();
  });
  t.after(restore);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await dispatch(new Request("https://raw.xinu.my.id/sudo", { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(calls, 0);
});

test("denied paths return 404 without an upstream attempt", async (t) => {
  let calls = 0;
  const restore = installFetch(async () => {
    calls += 1;
    throw new Error("must not fetch");
  });
  t.after(restore);
  for (const path of ["/tools/sudo", "/src/index.js", "/meta.json", "/sudo/a", "/sudo;id", "/%2e%2e/meta.json"]) {
    const response = await dispatch(new Request(`https://raw.xinu.my.id${path}`));
    assert.equal(response.status, 404, path);
  }
  assert.equal(calls, 0);
});

test("denied paths cannot be revived by a stale cache entry", async (t) => {
  let matches = 0;
  const restoreCache = installCache({
    match: async () => {
      matches += 1;
      return new Response("stale internal content");
    },
    put: async () => {},
  });
  t.after(restoreCache);
  const response = await dispatch(new Request("https://raw.xinu.my.id/meta.json"));
  assert.equal(response.status, 404);
  assert.equal(await body(response), "not found\n");
  assert.equal(matches, 0);
});

test("a valid but unlisted tool returns 404 without fetching a tool source", async (t) => {
  const calls = [];
  const restore = installFetch(async (url) => {
    calls.push(url);
    if (url.includes("/commits/main")) return json({ sha: SHA });
    if (url.endsWith(`/${SHA}/meta.json`)) return json(manifest);
    throw new Error(`unexpected tool fetch ${url}`);
  });
  t.after(restore);
  const response = await dispatch(new Request("https://raw.xinu.my.id/unknown?test=1"));
  assert.equal(response.status, 404);
  assert.deepEqual(calls, [
    "https://api.github.com/repos/x-inu/essential/commits/main",
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/meta.json`,
  ]);
});

test("direct /sudo maps only to tools/sudo and serves hardened plain text", async (t) => {
  const calls = [];
  const restore = installFetch(async (url) => {
    calls.push(url);
    if (url.includes("/commits/main")) return json({ sha: SHA });
    if (url.endsWith(`/${SHA}/meta.json`)) return json(manifest);
    if (url.endsWith(`/${SHA}/tools/sudo`)) return toolBody("sudo");
    throw new Error(`unexpected ${url}`);
  });
  t.after(restore);

  const response = await dispatch(new Request("https://raw.xinu.my.id/sudo?cache-bust=1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("etag"), '"sudo-etag"');
  assert.equal(response.headers.get("last-modified"), "Fri, 28 Aug 2026 00:00:00 GMT");
  assert.equal(response.headers.get("x-commit-sha"), SHA);
  assert.match(response.headers.get("cache-control"), /max-age=300/);
  assert.equal(await body(response), "#!/bin/sh\necho sudo\n");
  assert.deepEqual(calls, [
    "https://api.github.com/repos/x-inu/essential/commits/main",
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/meta.json`,
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/tools/sudo`,
  ]);
});

test("HEAD follows GET routing but has no body and does not write cache", async (t) => {
  let puts = 0;
  const restoreFetch = installFetch(async (url) => {
    if (url.includes("/commits/main")) return json({ sha: SHA });
    return url.endsWith("meta.json") ? json(manifest) : toolBody("sudo");
  });
  const restoreCache = installCache({
    match: async () => undefined,
    put: async () => {
      puts += 1;
    },
  });
  t.after(restoreFetch);
  t.after(restoreCache);
  const response = await dispatch(new Request("https://raw.xinu.my.id/sudo", { method: "HEAD" }));
  assert.equal(response.status, 200);
  assert.equal(await body(response), "");
  assert.equal(puts, 0);
});

test("version route fetches manifest and tool at the same SHA with immutable caching", async (t) => {
  const calls = [];
  const restore = installFetch(async (url) => {
    calls.push(url);
    if (url.endsWith(`/${SHA}/meta.json`)) return json(manifest);
    if (url.endsWith(`/${SHA}/tools/sudo`)) return toolBody("sudo");
    throw new Error(`unexpected ${url}`);
  });
  t.after(restore);
  const response = await dispatch(new Request(`https://raw.xinu.my.id/v/${SHA}/sudo?x=1`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, s-maxage=31536000, immutable");
  assert.deepEqual(calls, [
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/meta.json`,
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/tools/sudo`,
  ]);
});

test("GET cache uses normalized no-query keys and waitUntil catches cache.put failures", async (t) => {
  const matched = [];
  const put = [];
  const waits = [];
  const cacheErrors = [];
  const restoreFetch = installFetch(async (url) => {
    if (url.includes("/commits/main")) return json({ sha: SHA });
    return url.endsWith("meta.json") ? json(manifest) : toolBody("sudo");
  });
  const restoreCache = installCache({
    match: async (request) => {
      matched.push(request.url);
      return undefined;
    },
    put: async (request) => {
      put.push(request.url);
      throw new Error("cache down");
    },
  });
  t.after(restoreFetch);
  t.after(restoreCache);
  const ctx = { waitUntil(promise) { waits.push(promise); } };
  const response = await dispatch(
    new Request("https://raw.xinu.my.id/sudo"),
    { onCacheError(error) { cacheErrors.push(error.message); } },
    ctx,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(matched, ["https://raw.xinu.my.id/sudo"]);
  assert.deepEqual(put, ["https://raw.xinu.my.id/sudo"]);
  assert.equal(waits.length, 1);
  await assert.doesNotReject(waits[0]);
  assert.deepEqual(cacheErrors, ["cache down"]);
});

test("query, authorization, and cookies are omitted from the normalized cache key", async (t) => {
  let cacheCalls = 0;
  const restoreFetch = installFetch(async (url) => {
    if (url.includes("/commits/main")) return json({ sha: SHA });
    return url.endsWith("meta.json") ? json(manifest) : toolBody("sudo");
  });
  const restoreCache = installCache({
    match: async () => {
      cacheCalls += 1;
    },
    put: async () => {
      cacheCalls += 1;
    },
  });
  t.after(restoreFetch);
  t.after(restoreCache);
  const requests = [
    new Request("https://raw.xinu.my.id/sudo?q=1"),
    new Request("https://raw.xinu.my.id/sudo", { headers: { authorization: "Bearer x" } }),
    new Request("https://raw.xinu.my.id/sudo", { headers: { cookie: "a=b" } }),
  ];
  for (const request of requests) assert.equal((await dispatch(request)).status, 200);
  assert.equal(cacheCalls, 6);
});

test("cache hits avoid every upstream request", async (t) => {
  let upstream = 0;
  const restoreFetch = installFetch(async () => {
    upstream += 1;
    throw new Error("unexpected");
  });
  const restoreCache = installCache({
    match: async () => new Response("cached", { headers: { "content-type": "text/plain" } }),
    put: async () => {},
  });
  t.after(restoreFetch);
  t.after(restoreCache);
  const response = await dispatch(new Request("https://raw.xinu.my.id/sudo"));
  assert.equal(await body(response), "cached");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(upstream, 0);
});

test("network failures and timeouts produce differentiated responses", async (t) => {
  let mode = "network";
  const restore = installFetch(async (_url, options) => {
    if (mode === "network") throw new TypeError("offline");
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  });
  t.after(restore);
  let response = await dispatch(new Request("https://raw.xinu.my.id/sudo?x=1"));
  assert.equal(response.status, 502);
  assert.equal(await body(response), "upstream unavailable\n");
  mode = "timeout";
  response = await dispatch(new Request("https://raw.xinu.my.id/sudo?x=2"), { UPSTREAM_TIMEOUT_MS: "5" });
  assert.equal(response.status, 504);
  assert.equal(await body(response), "upstream timeout\n");
});

test("fetchTool computes SHA-256 over exact bytes", async (t) => {
  const restore = installFetch(async () => new Response("abc"));
  t.after(restore);
  const result = await fetchTool(manifestTools[0], SHA);
  assert.equal(result.size, 3);
  assert.equal(result.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("index uses one commit and shows simple direct commands for every tool", async (t) => {
  const calls = [];
  const restore = installFetch(async (url) => {
    calls.push(url);
    if (url.includes("/commits/main")) return json({ sha: SHA });
    if (url.endsWith(`/${SHA}/meta.json`)) return json(manifest);
    if (url.endsWith(`/${SHA}/tools/cinit`)) return toolBody("cinit");
    if (url.endsWith(`/${SHA}/tools/sudo`)) return toolBody("sudo");
    throw new Error(`unexpected ${url}`);
  });
  t.after(restore);
  const response = await dispatch(new Request("https://raw.xinu.my.id/?test=1"));
  const html = await body(response);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(response.headers.get("content-security-policy"), /style-src 'nonce-[A-Za-z0-9_-]+'/);
  assert.match(html, /href="\/sudo">Download latest/);
  assert.match(html, /curl -fsSL https:\/\/raw\.xinu\.my\.id\/cinit \| sh/);
  assert.match(html, /curl -fsSL https:\/\/raw\.xinu\.my\.id\/sudo \| sh/);
  assert.match(html, /id="rot2"/);
  assert.match(html, /id="rot3"/);
  assert.match(html, /# read it/);
  assert.match(html, /# run it/);
  assert.doesNotMatch(html, /sha256sum -c -/);
  assert.doesNotMatch(html, /mktemp/);
  assert.doesNotMatch(html, /read -r answer/);
  assert.match(html, new RegExp(`github\\.com/x-inu/essential/blob/${SHA}/tools/sudo`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Copy failed/);
  assert.match(html, /aria-hidden="true">RAW/);
  assert.match(html, /scroll-margin-top/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /--max:1080px/);
  assert.match(html, /--wide:1440px/);
  assert.match(html, /localStorage/);
  assert.match(html, /rotFadeReduced/);
  assert.doesNotMatch(html, /!important/);
  assert.doesNotMatch(html, / style="/);
  assert.doesNotMatch(html, /\/v\/[a-f0-9]{40}\/tools\//);
  assert.deepEqual(calls, [
    "https://api.github.com/repos/x-inu/essential/commits/main",
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/meta.json`,
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/tools/cinit`,
    `https://raw.githubusercontent.com/x-inu/essential/${SHA}/tools/sudo`,
  ]);
});

test("index escapes manifest HTML and safely encodes route segments", async (t) => {
  const hostile = structuredClone(manifest);
  hostile.cinit.title = `<img src=x onerror="alert(1)">`;
  hostile.cinit.note = `Ampersand & quote " and <script>`;
  hostile.cinit.target = ["target-all"];
  const restore = installFetch(async (url) => {
    if (url.includes("/commits/main")) return json({ sha: OTHER_SHA });
    if (url.endsWith("meta.json")) return json(hostile);
    return toolBody(url.endsWith("cinit") ? "cinit" : "sudo");
  });
  t.after(restore);
  const html = await body(await dispatch(new Request("https://raw.xinu.my.id/?x=escape")));
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /Ampersand &amp; quote &quot; and &lt;script&gt;/);
  assert.match(html, /target-all/);
  assert.match(html, /href="\/cinit">Download latest/);
});

test("favicon is local, hardened, GET/HEAD only", async () => {
  const get = await dispatch(new Request("https://raw.xinu.my.id/favicon.svg?x=1"));
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.match(await body(get), /<svg/);
  const head = await dispatch(new Request("https://raw.xinu.my.id/favicon.ico", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await body(head), "");
});

test("module exports the Cloudflare handler object and named fetch", () => {
  assert.equal(worker.fetch, workerFetch);
});
