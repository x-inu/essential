const GITHUB_RAW = "https://raw.githubusercontent.com/x-inu/essential/main";
const GITHUB_API = "https://api.github.com/repos/x-inu/essential/git/trees/main";
const REPO = "x-inu/essential";
const BRANCH = "main";
const CACHE_TTL = 300;
const DOMAIN = "raw.xinu.my.id";

const HIDDEN = new Set([
  "LICENSE",
  "README.md",
  "wrangler.toml",
  "package.json",
  "package-lock.json",
  "meta.json",
]);

const FALLBACK_NOTES = {
  cinit: {
    title: "Disable cloud-init",
    kanji: "止",
    note: "Stops cloud-init from reclaiming your network config on the next boot. Writes the disable flag, masks the four units, pins network config off. Elevates through sudo on its own when it is not run as root.",
    target: "Debian · Ubuntu · any systemd host with /etc/cloud",
  },
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return serveIndex();
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);

    if (cached) {
      return cached;
    }

    const res = await fetch(`${GITHUB_RAW}${path}`, {
      headers: { "User-Agent": `${DOMAIN} proxy` },
    });

    if (!res.ok) {
      return new Response("not found\n", { status: 404 });
    }

    const response = new Response(res.body, {
      status: 200,
      headers: {
        "content-type": guessType(path),
        "cache-control": `public, max-age=${CACHE_TTL}`,
        "x-source": "github",
      },
    });

    request.method === "GET" && cache.put(cacheKey, response.clone());

    return response;
  },
};

async function listFiles() {
  try {
    const res = await fetch(`${GITHUB_API}?recursive=1`, {
      headers: { "User-Agent": `${DOMAIN} proxy` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.tree
      .filter(
        f =>
          f.type === "blob" &&
          !f.path.includes("/") &&
          !f.path.startsWith(".") &&
          !HIDDEN.has(f.path)
      )
      .map(f => ({ name: f.path, size: f.size }));
  } catch {
    return [];
  }
}

async function loadNotes() {
  try {
    const res = await fetch(`${GITHUB_RAW}/meta.json`, {
      headers: { "User-Agent": `${DOMAIN} proxy` },
    });
    if (!res.ok) return FALLBACK_NOTES;
    const data = await res.json();
    return data && typeof data === "object" ? data : FALLBACK_NOTES;
  } catch {
    return FALLBACK_NOTES;
  }
}

async function serveIndex() {
  const [files, notes] = await Promise.all([listFiles(), loadNotes()]);
  const html = render(files, notes);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL}`,
    },
  });
}

function render(files, notes) {
  const total = files.reduce((n, f) => n + f.size, 0);
  const sample = files.length ? esc(files[0].name) : "cinit";

  const rows = files.length
    ? files.map((f, i) => scriptEntry(f, i, notes)).join("")
    : `<p class="empty">No scripts published on <span class="mono">${BRANCH}</span> yet.</p>`;

  return `<!DOCTYPE html>
<html lang="en" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DOMAIN} — script index</title>
<meta name="description" content="Shell scripts from ${REPO}, served from the Cloudflare edge. One curl away.">
<meta name="color-scheme" content="dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..600&family=Space+Grotesk:wght@400;500&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
:root {
  --paper: #000;
  --paper-raised: #0a0a0a;
  --ink: #cdc4ba;
  --ink-dim: #b0a9a0;
  --ink-muted: #958f87;
  --ink-faint: #7a756e;
  --line: rgba(205,196,186,.26);
  --line-soft: rgba(205,196,186,.13);
  --line-strong: rgba(205,196,186,.42);
  --tint5: rgba(205,196,186,.05);
  --bone: #cdc4ba;
  --ink-on-bone: #000;

  --f-display: "Fraunces", ui-serif, Georgia, serif;
  --f-sans: "Space Grotesk", system-ui, sans-serif;
  --f-mono: "Space Mono", ui-monospace, monospace;

  --max: 1080px;
  --gutter: clamp(1.15rem, 4vw, 3rem);
  --section-y: clamp(2rem, 5vw, 3.5rem);
  --radius: 2px;
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px;
  --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px;

  --move: .17s;
  --ease-out: cubic-bezier(.215,.61,.355,1);
  --grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='256'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='256' height='256' filter='url(%23n)'/%3E%3C/svg%3E");
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html { color-scheme: dark; }

body {
  background: var(--paper);
  color: var(--ink-dim);
  font-family: var(--f-sans);
  font-size: clamp(.92rem, .88rem + .2vw, 1rem);
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  overflow-x: hidden;
}

body:before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: none;
  background-image: var(--grain);
  background-size: 256px 256px;
  opacity: .055;
}

::selection { background: var(--ink); color: var(--paper); }

a { color: inherit; }

h1, h2, h3 {
  font-family: var(--f-display);
  font-weight: 400;
  letter-spacing: -.01em;
  line-height: .98;
  color: var(--ink);
  text-wrap: balance;
  font-variation-settings: "opsz" 144, "SOFT" 0, "WONK" 0;
}

.wrap { max-width: var(--max); margin-inline: auto; padding-inline: var(--gutter); width: 100%; }
.mono { font-family: var(--f-mono); }
.tnum { font-variant-numeric: tabular-nums; }

/* ── header ─────────────────────────────── */
.hdr {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 56px;
  z-index: 100;
  display: flex;
  align-items: center;
  transition: background var(--move), border-color var(--move);
  border-bottom: 1px solid transparent;
}
.hdr.solid {
  background: color-mix(in srgb, var(--paper) 90%, transparent);
  backdrop-filter: blur(8px);
  border-bottom-color: var(--line);
}
.hdr__in { display: flex; align-items: center; justify-content: space-between; }
.logo {
  display: flex; align-items: baseline; gap: var(--s2);
  text-decoration: none;
  color: var(--ink);
}
.logo__k { font-family: var(--f-display); font-size: 1.05rem; }
.logo__t {
  font-family: var(--f-mono);
  font-size: .75rem;
  letter-spacing: .04em;
  color: var(--ink-muted);
}
.hdr__right { display: flex; align-items: center; gap: var(--s5); }
.hdr-link {
  font-weight: 500;
  font-size: .66rem;
  letter-spacing: .18em;
  text-transform: uppercase;
  color: var(--ink-muted);
  text-decoration: none;
  position: relative;
  transition: color var(--move);
}
.hdr-link:after {
  content: "";
  position: absolute;
  left: 0; bottom: -3px;
  width: 100%; height: 1px;
  background: currentColor;
  transform: scaleX(0);
  transform-origin: left;
  transition: transform var(--move) var(--ease-out);
}
.hdr-link:hover { color: var(--ink); }
.hdr-link:hover:after { transform: scaleX(1); }

/* ── shared type ────────────────────────── */
.eyebrow {
  display: flex; align-items: center; gap: var(--s3);
  font-weight: 500;
  font-size: .66rem;
  letter-spacing: .22em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin-bottom: var(--s5);
}
.eyebrow__k { font-family: var(--f-display); font-size: .9rem; letter-spacing: 0; color: var(--ink); }
.eyebrow:after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}
.label {
  font-weight: 500;
  font-size: .625rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-muted);
}
.micro {
  font-weight: 500;
  font-size: .5625rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.lede {
  color: var(--ink-muted);
  max-width: 56ch;
  margin-top: var(--s4);
}

section { border-top: 1px solid var(--line); padding-block: var(--section-y); overflow: clip; position: relative; }

/* ── hero ───────────────────────────────── */
.hero {
  border-top: none;
  padding: calc(56px + var(--s6)) 0 var(--s7);
  position: relative;
}
.hero__grid { display: grid; grid-template-columns: 1fr; gap: var(--s6); }
.hero h1 {
  font-family: var(--f-mono);
  font-weight: 400;
  font-size: clamp(1.75rem, 1rem + 4.4vw, 3.4rem);
  letter-spacing: -.02em;
  line-height: 1;
  color: var(--ink);
}
.hero__live {
  display: inline-flex; align-items: center; gap: var(--s2);
  margin-bottom: var(--s4);
}
.dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--bone);
  animation: blink 1.5s infinite;
}
@keyframes blink { 0%,48% { opacity: 1 } 60%,to { opacity: .18 } }
.regfield {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--line) 1px, transparent 1.3px);
  background-size: 22px 22px;
  opacity: .5;
  pointer-events: none;
  mask-image: radial-gradient(120% 80% at 82% 30%, #000 15%, transparent 65%);
  -webkit-mask-image: radial-gradient(120% 80% at 82% 30%, #000 15%, transparent 65%);
}

/* ── spec table ─────────────────────────── */
.spec { margin-top: var(--s6); max-width: 520px; }
.spec__row {
  display: flex; align-items: baseline; gap: var(--s3);
  padding: var(--s2) 0;
  border-bottom: 1px solid var(--line-soft);
}
.spec__k {
  font-weight: 500;
  font-size: .6875rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-muted);
  flex-shrink: 0;
}
.spec__lead { flex: 1; border-bottom: 1px dotted var(--line-soft); transform: translateY(-.28em); }
.spec__v {
  font-family: var(--f-mono);
  font-size: .8rem;
  color: var(--ink);
  flex-shrink: 0;
}

/* ── code readout ───────────────────────── */
.readout {
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--s4);
  font-family: var(--f-mono);
  font-size: .76rem;
  line-height: 1.7;
  color: var(--ink-dim);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.prompt { color: var(--ink-faint); user-select: none; }
.comment { color: var(--ink-faint); }
.hl { color: var(--ink); }

/* ── scripts ────────────────────────────── */
.entry {
  border-bottom: 1px solid var(--line-soft);
  padding: var(--s6) 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--s4);
}
.entry:last-of-type { border-bottom: none; padding-bottom: 0; }
.entry__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; }
.entry__idx {
  font-family: var(--f-mono);
  font-size: .5625rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: var(--s2);
}
.entry__name {
  font-family: var(--f-display);
  font-size: clamp(1.5rem, 1.1rem + 1.6vw, 2.1rem);
  color: var(--ink);
}
.entry__meta { font-family: var(--f-mono); font-size: .7rem; color: var(--ink-faint); text-align: right; }
.entry__note { color: var(--ink-muted); max-width: 62ch; }
.cmd {
  display: flex; align-items: stretch; gap: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--paper-raised);
  transition: border-color var(--move);
}
.cmd:hover { border-color: var(--line-strong); }
.cmd__text {
  flex: 1;
  padding: var(--s3) var(--s4);
  font-family: var(--f-mono);
  font-size: .76rem;
  color: var(--ink);
  overflow-x: auto;
  white-space: nowrap;
}
.cmd__btn {
  flex-shrink: 0;
  border: none;
  border-left: 1px solid var(--line);
  background: transparent;
  color: var(--ink-muted);
  font-family: var(--f-sans);
  font-weight: 500;
  font-size: .625rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  padding: 0 var(--s4);
  cursor: pointer;
  transition: background var(--move), color var(--move);
}
.cmd__btn:hover { background: var(--tint5); color: var(--ink); }
.cmd__btn.done { color: var(--bone); }
.entry__links { display: flex; gap: var(--s5); }
.glink {
  font-weight: 500;
  font-size: .625rem;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-muted);
  text-decoration: none;
  position: relative;
  transition: color var(--move);
}
.glink:after {
  content: "";
  position: absolute;
  left: 0; bottom: -3px;
  width: 100%; height: 1px;
  background: currentColor;
  transform: scaleX(0);
  transform-origin: left;
  transition: transform var(--move) var(--ease-out);
}
.glink:hover { color: var(--ink); }
.glink:hover:after { transform: scaleX(1); }
.empty { color: var(--ink-faint); font-family: var(--f-mono); font-size: .8rem; }

/* ── plate with corner ticks ────────────── */
.plate {
  position: relative;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--s6);
  background: var(--paper-raised);
}
.tick { position: absolute; width: 12px; height: 12px; pointer-events: none; }
.tick:before, .tick:after { content: ""; position: absolute; background: var(--ink-faint); }
.tick:before { left: 0; top: 50%; width: 100%; height: 1px; }
.tick:after { top: 0; left: 50%; height: 100%; width: 1px; }
.tick--tl { top: 6px; left: 6px; }
.tick--tr { top: 6px; right: 6px; }
.tick--bl { bottom: 6px; left: 6px; }
.tick--br { bottom: 6px; right: 6px; }

/* ── two column ─────────────────────────── */
.two { display: grid; grid-template-columns: 1fr; gap: var(--s7); }
.stmt {
  font-family: var(--f-sans);
  font-size: clamp(1.2rem, 1rem + 1.4vw, 1.8rem);
  font-weight: 400;
  letter-spacing: -.01em;
  line-height: 1.2;
  color: var(--ink);
  max-width: 26ch;
}
.notes { display: grid; gap: var(--s5); }
.note__k { margin-bottom: var(--s1); }
.note p { color: var(--ink-muted); font-size: .92rem; }

/* ── footer ─────────────────────────────── */
.ftr { border-top: 1px solid var(--line); padding-top: var(--s7); overflow: clip; }
.ftr__word {
  font-family: var(--f-display);
  font-size: clamp(4rem, 22vw, 15rem);
  line-height: .8;
  color: transparent;
  -webkit-text-stroke: 1px var(--line);
  text-align: center;
  user-select: none;
  margin-bottom: calc(var(--s5) * -1);
}
.ftr__bar {
  border-top: 1px solid var(--line-soft);
  margin-top: var(--s6);
  padding: var(--s4) 0 var(--s6);
  display: flex; justify-content: space-between; gap: var(--s4);
  flex-wrap: wrap;
  font-family: var(--f-mono);
  font-size: .625rem;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.ftr__bar a { text-decoration: none; transition: color var(--move); }
.ftr__bar a:hover { color: var(--ink); }

@media (min-width: 780px) {
  .hero__grid { grid-template-columns: 1.15fr .85fr; align-items: start; gap: var(--s8); }
  .entry { grid-template-columns: 1fr; }
  .two { grid-template-columns: .95fr 1.05fr; }
}

@media (prefers-reduced-motion: reduce) {
  *, *:before, *:after { animation: none !important; transition-duration: .001ms !important; }
}
</style>
</head>
<body>

<header class="hdr" id="hdr">
  <div class="wrap hdr__in">
    <a class="logo" href="/">
      <span class="logo__k">源</span>
      <span class="logo__t">${DOMAIN}</span>
    </a>
    <div class="hdr__right">
      <a class="hdr-link" href="#scripts">Scripts</a>
      <a class="hdr-link" href="https://github.com/${REPO}">Source</a>
    </div>
  </div>
</header>

<main>
  <section class="hero">
    <div class="regfield"></div>
    <div class="wrap hero__grid">
      <div>
        <p class="eyebrow"><span class="eyebrow__k">源</span> Script index</p>
        <div class="hero__live">
          <span class="dot"></span>
          <span class="micro">Serving from the edge</span>
        </div>
        <h1>${DOMAIN}</h1>
        <p class="lede">Shell scripts from <span class="mono">${REPO}</span>, mirrored at the Cloudflare edge. Push to <span class="mono">${BRANCH}</span> and the file is live one curl later. No build step, no release tags.</p>

        <div class="spec">
          ${specRow("Source", REPO)}
          ${specRow("Branch", BRANCH)}
          ${specRow("Files", String(files.length).padStart(2, "0"))}
          ${specRow("Payload", fmtSize(total))}
          ${specRow("Edge cache", CACHE_TTL / 60 + " min")}
        </div>
      </div>

      <div>
        <p class="label" style="margin-bottom:var(--s3)">Usage</p>
        <div class="readout"><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/</span><span class="comment">&lt;file&gt;</span><span class="hl"> | sh</span></div>
        <p class="micro" style="margin-top:var(--s4);line-height:1.8">Every path below <span class="mono">/</span> maps straight onto the repository root.</p>
      </div>
    </div>
  </section>

  <section id="scripts">
    <div class="wrap">
      <p class="eyebrow"><span class="eyebrow__k">具</span> Published</p>
      <h2 class="stmt" style="margin-bottom:var(--s6)">Everything on the branch, one curl away.</h2>
      ${rows}
    </div>
  </section>

  <section id="how">
    <div class="wrap two">
      <div>
        <p class="eyebrow"><span class="eyebrow__k">道</span> How it works</p>
        <h2 class="stmt">The repository is the deployment.</h2>
      </div>
      <div class="notes">
        <div class="readout">GET https://${DOMAIN}/<span class="comment">&lt;file&gt;</span>
  <span class="comment">│</span>
  <span class="comment">├─</span> edge cache hit  <span class="comment">→ served, 0 hops</span>
  <span class="comment">└─</span> miss
       <span class="comment">└─</span> raw.githubusercontent.com/${REPO}/${BRANCH}/<span class="comment">&lt;file&gt;</span>
            <span class="comment">└─</span> cached ${CACHE_TTL / 60} min, then served</div>
        <div class="note">
          <p class="label note__k">No deploy step</p>
          <p>Commit a file to <span class="mono">${BRANCH}</span> and it is published under its own name. Nothing to rebuild, nothing to register, nothing to invalidate by hand.</p>
        </div>
        <div class="note">
          <p class="label note__k">Cached at the edge</p>
          <p>A hit never touches GitHub, so rate limits stay clear and a GitHub outage does not take the cached copy down. Changes land within ${CACHE_TTL / 60} minutes.</p>
        </div>
        <div class="note">
          <p class="label note__k">Describe it in meta.json</p>
          <p>Optional. Add an entry keyed by filename and the index above picks up the title, note and target on the next fetch.</p>
        </div>
      </div>
    </div>
  </section>

  <section id="care">
    <div class="wrap">
      <p class="eyebrow"><span class="eyebrow__k">見</span> Before you pipe</p>
      <div class="plate">
        <span class="tick tick--tl"></span><span class="tick tick--tr"></span>
        <span class="tick tick--bl"></span><span class="tick tick--br"></span>
        <h2 class="stmt" style="margin-bottom:var(--s5)">Read it before you run it.</h2>
        <p class="entry__note">Piping a URL into a shell hands it your machine. These scripts are mine and they are short on purpose — open the file, read it end to end, then decide. Drop the pipe to inspect first:</p>
        <div class="readout" style="margin-top:var(--s5)"><span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/${sample}</span>${" ".repeat(10)}<span class="comment"># print it</span>
<span class="prompt">$ </span><span class="hl">curl -fsSL https://${DOMAIN}/${sample} | sh</span>${" ".repeat(5)}<span class="comment"># then run it</span></div>
      </div>
    </div>
  </section>
</main>

<footer class="ftr">
  <div class="wrap">
    <div class="ftr__word">RAW</div>
    <div class="ftr__bar">
      <span>One source of truth · ${REPO}</span>
      <a href="https://github.com/${REPO}">github.com/${REPO} ↗</a>
      <span>源 · ${DOMAIN}</span>
    </div>
  </div>
</footer>

<script>
document.documentElement.classList.remove("no-js");

const hdr = document.getElementById("hdr");
const onScroll = () => hdr.classList.toggle("solid", window.scrollY > 8);
onScroll();
addEventListener("scroll", onScroll, { passive: true });

document.querySelectorAll("[data-copy]").forEach(btn => {
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const prev = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = prev; btn.classList.remove("done"); }, 1400);
    } catch {}
  });
});
</script>
</body>
</html>`;
}

function scriptEntry(file, i, notes) {
  const name = esc(file.name);
  const meta = (notes && notes[file.name]) || {};
  const title = esc(meta.title || name);
  const kanji = esc(meta.kanji || "・");
  const note = esc(meta.note || `Served straight from ${REPO} at ${BRANCH}.`);
  const target = meta.target ? esc(meta.target) : null;
  const cmd = `curl -fsSL https://${DOMAIN}/${name} | sh`;
  const idx = String(i).padStart(2, "0");

  return `
      <article class="entry">
        <div>
          <p class="entry__idx">${idx} // ${name.toUpperCase()}</p>
          <div class="entry__head">
            <h3 class="entry__name">${kanji} &nbsp;${title}</h3>
            <p class="entry__meta">${fmtSize(file.size)}${target ? `<br>${target}` : ""}</p>
          </div>
        </div>
        <p class="entry__note">${note}</p>
        <div class="cmd">
          <div class="cmd__text">${cmd}</div>
          <button class="cmd__btn" data-copy="${cmd}" type="button">Copy</button>
        </div>
        <div class="entry__links">
          <a class="glink" href="/${name}">View raw</a>
          <a class="glink" href="https://github.com/${REPO}/blob/${BRANCH}/${name}">On GitHub ↗</a>
        </div>
      </article>`;
}

function specRow(k, v) {
  return `<div class="spec__row">
            <span class="spec__k">${k}</span>
            <span class="spec__lead"></span>
            <span class="spec__v tnum">${v}</span>
          </div>`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
