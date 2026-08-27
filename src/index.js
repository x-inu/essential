const GITHUB_RAW = "https://raw.githubusercontent.com/x-inu/essential/main";
const GITHUB_API = "https://api.github.com/repos/x-inu/essential/git/trees/main";
const CACHE_TTL = 300;
const DOMAIN = "raw.xinu.my.id";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return serveLanding();
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

async function serveLanding() {
  let files = [];
  try {
    const res = await fetch(GITHUB_API, {
      headers: { "User-Agent": "raw.xinu.my.id proxy" },
    });
    if (res.ok) {
      const data = await res.json();
      files = data.tree
        .filter(f => f.type === "blob" && !f.path.startsWith(".") && !f.path.startsWith("src/") && f.path !== "LICENSE" && f.path !== "README.md" && f.path !== "wrangler.toml")
        .map(f => ({ name: f.path, size: f.size }));
    }
  } catch {}

  const fileRows = files.length > 0
    ? files.map(f => {
        const size = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`;
        return `
      <tr>
        <td class="file-name"><a href="/${f.name}">${f.name}</a></td>
        <td class="file-size">${size}</td>
        <td class="file-cmd">curl -fsSL https://${DOMAIN}/${f.name} | sh</td>
      </tr>`;
      }).join("")
    : `<tr><td colspan="3" style="text-align:center">loading...</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DOMAIN}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #b0b0b0;
    font-family: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", monospace;
    font-size: 14px;
    line-height: 1.6;
    padding: 0;
    min-height: 100vh;
  }
  .term {
    max-width: 820px;
    margin: 0 auto;
    padding: 20px;
  }
  .bar {
    background: #1a1a2e;
    border: 1px solid #333;
    border-radius: 8px 8px 0 0;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .dot-r { background: #ff5f57; }
  .dot-y { background: #febc2e; }
  .dot-g { background: #28c840; }
  .bar-title {
    flex: 1;
    text-align: center;
    color: #666;
    font-size: 12px;
  }
  .body {
    background: #0d1117;
    border: 1px solid #333;
    border-top: none;
    border-radius: 0 0 8px 8px;
    padding: 24px;
    overflow-x: auto;
  }
  .prompt { color: #7ee787; }
  .cmd { color: #e6edf3; }
  .comment { color: #555; }
  .accent { color: #58a6ff; }
  .warn { color: #d29922; }
  h1 {
    color: #58a6ff;
    font-size: 16px;
    font-weight: normal;
    margin-bottom: 4px;
  }
  .sep {
    color: #333;
    margin: 16px 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
  }
  th {
    text-align: left;
    color: #555;
    font-weight: normal;
    padding: 4px 12px 4px 0;
    border-bottom: 1px solid #222;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  td {
    padding: 6px 12px 6px 0;
    border-bottom: 1px solid #161b22;
    white-space: nowrap;
  }
  .file-name a {
    color: #7ee787;
    text-decoration: none;
  }
  .file-name a:hover {
    text-decoration: underline;
  }
  .file-size {
    color: #555;
    text-align: right;
    padding-right: 20px;
  }
  .file-cmd {
    color: #8b949e;
    font-size: 12px;
  }
  .usage {
    background: #161b22;
    border: 1px solid #222;
    border-radius: 6px;
    padding: 16px;
    margin: 12px 0;
    overflow-x: auto;
  }
  .usage pre { white-space: pre-wrap; word-break: break-all; }
  .copy-hint {
    color: #444;
    font-size: 11px;
    margin-top: 8px;
  }
  .footer {
    color: #333;
    font-size: 11px;
    margin-top: 20px;
    text-align: center;
  }
  .footer a { color: #444; text-decoration: none; }
  .footer a:hover { color: #666; }
  @media (max-width: 600px) {
    .body { padding: 16px 12px; }
    .file-cmd { display: none; }
    td, th { padding: 4px 8px 4px 0; }
  }
</style>
</head>
<body>
<div class="term">
  <div class="bar">
    <span class="dot dot-r"></span>
    <span class="dot dot-y"></span>
    <span class="dot dot-g"></span>
    <span class="bar-title">${DOMAIN}</span>
  </div>
  <div class="body">
    <h1><span class="accent">$</span> ${DOMAIN}</h1>
    <p class="comment"># script proxy for x-inu/essential</p>
    <div class="sep">────────────────────────────────────────────</div>

    <p class="comment"># available scripts</p>
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th style="text-align:right">Size</th>
          <th class="file-cmd">Usage</th>
        </tr>
      </thead>
      <tbody>${fileRows}</tbody>
    </table>

    <div class="sep">────────────────────────────────────────────</div>

    <p class="comment"># usage</p>
    <div class="usage">
      <pre><span class="prompt">$</span> <span class="cmd">curl -fsSL https://${DOMAIN}/</span><span class="warn">&lt;file&gt;</span> <span class="cmd">| sh</span></pre>
    </div>

    <p class="comment"># example</p>
    <div class="usage">
      <pre><span class="prompt">$</span> <span class="cmd">curl -fsSL https://${DOMAIN}/cinit | sh</span>
<span class="comment"># disables cloud-init completely</span></pre>
    </div>

    <p class="copy-hint">files are cached for 5 minutes after each fetch from github</p>

    <div class="footer">
      <a href="https://github.com/x-inu/essential">github.com/x-inu/essential</a>
    </div>
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

function guessType(path) {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".js")) return "application/javascript";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".sh")) return "text/plain";
  if (path.endsWith(".md")) return "text/plain; charset=utf-8";
  return "text/plain";
}
