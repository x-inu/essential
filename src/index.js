const GITHUB_RAW = "https://raw.githubusercontent.com/x-inu/essential/main";
const CACHE_TTL = 300; // 5 minutes

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return new Response("raw.xinu.my.id - file proxy\n", {
        headers: { "content-type": "text/plain" },
      });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);

    if (cached) {
      return cached;
    }

    const origin = `${GITHUB_RAW}${path}`;
    const res = await fetch(origin, {
      headers: { "User-Agent": "raw.xinu.my.id proxy" },
    });

    if (!res.ok) {
      return new Response("not found\n", { status: 404 });
    }

    const contentType = guessType(path);
    const response = new Response(res.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": `public, max-age=${CACHE_TTL}`,
        "x-source": "github",
      },
    });

    request.method === "GET" && cache.put(cacheKey, response.clone());

    return response;
  },
};

function guessType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".sh")) return "text/plain";
  if (path.endsWith(".md")) return "text/plain; charset=utf-8";
  return "text/plain";
}
