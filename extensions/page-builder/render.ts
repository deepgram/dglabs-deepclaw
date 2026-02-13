import type {
  Page,
  Block,
  HeroBlock,
  CardsBlock,
  KeyValueBlock,
  TableBlock,
  ListBlock,
  MarkdownBlock,
  HtmlBlock,
} from "./types.js";

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Inline markdown renderer (no external deps)
// ---------------------------------------------------------------------------

function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let inList: "ul" | "ol" | null = null;

  const flushList = () => {
    if (inList) {
      out.push(inList === "ol" ? "</ol>" : "</ul>");
      inList = null;
    }
  };

  const inline = (t: string): string => {
    return esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  };

  for (const line of lines) {
    // Fenced code blocks
    if (line.startsWith("```")) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        out.push(
          `<pre class="md-code"${codeLang ? ` data-lang="${esc(codeLang)}"` : ""}><code>${esc(codeLines.join("\n"))}</code></pre>`,
        );
        inCode = false;
        codeLang = "";
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      flushList();
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushList();
      out.push("<hr>");
      continue;
    }

    // Headings
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${inline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(line)) {
      if (inList !== "ul") {
        flushList();
        out.push("<ul>");
        inList = "ul";
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      if (inList !== "ol") {
        flushList();
        out.push("<ol>");
        inList = "ol";
      }
      out.push(`<li>${inline(line.replace(/^\d+\.\s+/, ""))}</li>`);
      continue;
    }

    // Paragraph
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }

  // Close any open fenced block
  if (inCode) {
    out.push(`<pre class="md-code"><code>${esc(codeLines.join("\n"))}</code></pre>`);
  }
  flushList();

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Block renderers
// ---------------------------------------------------------------------------

function renderHero(b: HeroBlock): string {
  const accent = b.accent ?? "#13ef93";
  return `<section class="block-hero" style="border-top:4px solid ${esc(accent)}">
  <h1 class="hero-title">${esc(b.title)}</h1>
  ${b.subtitle ? `<p class="hero-subtitle">${esc(b.subtitle)}</p>` : ""}
</section>`;
}

function renderCards(b: CardsBlock): string {
  if (!b.items?.length) return `<p class="empty">No cards</p>`;
  const cards = b.items
    .map((c) => {
      const icon = c.icon ? `<span class="card-icon">${esc(c.icon)}</span>` : "";
      const title = c.link
        ? `<a href="${esc(c.link)}" target="_blank" rel="noopener">${esc(c.title)}</a>`
        : esc(c.title);
      return `<div class="card">${icon}<h3 class="card-title">${title}</h3><p class="card-body">${esc(c.body)}</p></div>`;
    })
    .join("\n  ");
  return `<div class="cards-grid">\n  ${cards}\n</div>`;
}

function renderKeyValue(b: KeyValueBlock): string {
  if (!b.items?.length) return `<p class="empty">No data</p>`;
  const rows = b.items
    .map(
      (kv) => `<div class="kv-key">${esc(kv.key)}</div><div class="kv-val">${esc(kv.value)}</div>`,
    )
    .join("\n  ");
  return `<div class="kv-grid">\n  ${rows}\n</div>`;
}

function renderTable(b: TableBlock): string {
  if (!b.headers?.length) return `<p class="empty">No table data</p>`;
  const thead = `<tr>${b.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody = b.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
    .join("\n    ");
  return `<table>\n  <thead>${thead}</thead>\n  <tbody>\n    ${tbody}\n  </tbody>\n</table>`;
}

function renderList(b: ListBlock): string {
  if (!b.items?.length) return `<p class="empty">No items</p>`;
  const tag = b.ordered ? "ol" : "ul";
  const items = b.items
    .map((item) => {
      if (b.checkbox) {
        const checked = item.checked ? " checked disabled" : " disabled";
        return `<li><label><input type="checkbox"${checked}> ${esc(item.text)}</label></li>`;
      }
      return `<li>${esc(item.text)}</li>`;
    })
    .join("\n  ");
  return `<${tag}${b.checkbox ? ' class="checklist"' : ""}>\n  ${items}\n</${tag}>`;
}

function renderMarkdownBlock(b: MarkdownBlock): string {
  return `<div class="md-content">${renderMarkdown(b.content)}</div>`;
}

function renderHtml(b: HtmlBlock): string {
  return `<div class="html-content">${b.content}</div>`;
}

function renderBlock(block: Block): string {
  let inner: string;
  switch (block.type) {
    case "hero":
      inner = renderHero(block);
      break;
    case "cards":
      inner = renderCards(block);
      break;
    case "key-value":
      inner = renderKeyValue(block);
      break;
    case "table":
      inner = renderTable(block);
      break;
    case "list":
      inner = renderList(block);
      break;
    case "markdown":
      inner = renderMarkdownBlock(block);
      break;
    case "html":
      inner = renderHtml(block);
      break;
    default:
      inner = `<pre>${esc(JSON.stringify(block, null, 2))}</pre>`;
  }

  // Section label
  const label =
    "label" in block && block.label ? `<h2 class="section-label">${esc(block.label)}</h2>\n` : "";

  // Collapsible wrapper
  if ("collapsed" in block && block.collapsed) {
    const summary = "label" in block && block.label ? esc(block.label) : block.type;
    return `<details class="block">\n<summary>${summary}</summary>\n${inner}\n</details>`;
  }

  return `<div class="block">\n${label}${inner}\n</div>`;
}

// ---------------------------------------------------------------------------
// Full page render
// ---------------------------------------------------------------------------

export function renderPage(page: Page): string {
  const blocks = page.blocks.map(renderBlock).join("\n");

  // Inline DeepClaw pixel-lobster logo (24px display)
  const logo = `<svg width="24" height="25" viewBox="0 0 600 633" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M279.023 632.667H24.0273C15.4906 632.667 11.2223 622.353 17.2171 616.308L181.476 450.952C183.298 449.129 185.744 448.122 188.286 448.122H280.99C352.64 448.122 413.26 392.043 415.418 320.422C417.624 245.971 357.724 184.76 283.819 184.76H184.497V307.201C184.497 312.478 180.181 316.795 174.905 316.795H9.59173C4.31628 316.795 0 312.478 0 307.201V9.76098C0 4.48415 4.31628 0.166748 9.59173 0.166748H283.819C459.78 0.166748 602.648 144.704 599.963 321.334C597.325 494.845 452.538 632.667 279.023 632.667Z" fill="#13ef93"/></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#101014">
  <title>${esc(page.title)} — DeepClaw</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #101014;
      --bg-elevated: #232329;
      --bg-accent: #1a1a1f;
      --bg-hover: #2c2c33;
      --text-strong: #fbfbff;
      --text: #e1e1e5;
      --text-muted: #949498;
      --text-muted-strong: #4e4e52;
      --border: #2c2c33;
      --border-strong: #4e4e52;
      --accent: #13ef93;
      --accent-hover: #a1f9d4;
      --accent-subtle: rgba(19, 239, 147, 0.15);
      --accent-blue: #149afb;
      --danger: #f04438;
      --warning: #fec84b;
      --success: #12b76a;
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --font-body: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    }

    body {
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--text);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* --- Header ---------------------------------------------------------- */
    .site-header {
      position: sticky;
      top: 0;
      z-index: 40;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.5rem;
      background: var(--bg);
      border-bottom: 1px solid var(--border);
    }
    .site-header .brand {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      text-decoration: none;
    }
    .site-header .brand-logo {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .site-header .brand-logo svg { width: 24px; height: auto; }
    .site-header .brand-text { display: flex; flex-direction: column; }
    .site-header .brand-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-strong);
      letter-spacing: 0.04em;
      line-height: 1.2;
    }
    .site-header .brand-sub {
      font-size: 10px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .site-header .page-id {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted-strong);
    }

    /* --- Main content ---------------------------------------------------- */
    .page {
      max-width: 860px;
      width: 100%;
      margin: 0 auto;
      padding: 2.5rem 1.5rem 3rem;
      flex: 1;
    }

    .page-title {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: -0.035em;
      color: var(--text-strong);
      margin-bottom: 0.25rem;
    }

    .page-subtitle {
      font-size: 1.1rem;
      color: var(--text-muted);
      margin-bottom: 2.5rem;
    }

    /* --- Footer ---------------------------------------------------------- */
    .site-footer {
      padding: 1rem 0;
      text-align: center;
      border-top: 1px solid var(--border);
      opacity: 0.4;
    }
    .site-footer span {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
    }

    /* --- Blocks ---------------------------------------------------------- */
    .block { margin-bottom: 2.5rem; }

    .section-label {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 0.75rem;
    }

    details.block {
      margin-bottom: 2.5rem;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }
    details.block > summary {
      cursor: pointer;
      padding: 0.75rem 1rem;
      background: var(--bg-elevated);
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 0.95rem;
    }
    details.block[open] > summary { border-bottom: 1px solid var(--border); }
    details.block > :not(summary) { padding: 1rem; }

    /* --- Hero ------------------------------------------------------------ */
    .block-hero {
      text-align: center;
      padding: 3rem 1rem 2rem;
      border-radius: var(--radius-lg);
      background: var(--bg-elevated);
    }
    .hero-title { font-size: 2.25rem; font-weight: 700; color: var(--text-strong); margin-bottom: 0.5rem; }
    .hero-subtitle { font-size: 1.15rem; color: var(--text-muted); }

    /* --- Cards ----------------------------------------------------------- */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 1rem;
    }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 1.25rem;
      transition: border-color 0.15s, transform 0.15s;
    }
    .card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
    .card-icon { font-size: 1.5rem; display: block; margin-bottom: 0.5rem; }
    .card-title { font-size: 1rem; font-weight: 600; margin-bottom: 0.4rem; }
    .card-title a { color: var(--accent); text-decoration: none; }
    .card-title a:hover { color: var(--accent-hover); text-decoration: underline; }
    .card-body { font-size: 0.9rem; color: var(--text-muted); }

    /* --- Key-value ------------------------------------------------------- */
    .kv-grid {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 0.5rem 1.5rem;
    }
    .kv-key { font-weight: 600; color: var(--text-muted); }
    .kv-val { color: var(--text); }

    /* --- Table ----------------------------------------------------------- */
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th {
      text-align: left;
      padding: 0.6rem 0.75rem;
      border-bottom: 2px solid var(--border);
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    td {
      padding: 0.55rem 0.75rem;
      border-bottom: 1px solid var(--border);
    }
    tbody tr:nth-child(even) { background: var(--bg-accent); }
    tbody tr:hover { background: var(--bg-hover); }

    /* --- List ------------------------------------------------------------ */
    ul, ol { padding-left: 1.5rem; }
    li { margin-bottom: 0.35rem; }
    .checklist { list-style: none; padding-left: 0; }
    .checklist li { display: flex; align-items: center; gap: 0.5rem; }
    .checklist input[type="checkbox"] {
      accent-color: var(--accent);
      width: 16px;
      height: 16px;
    }

    /* --- Markdown -------------------------------------------------------- */
    .md-content h1, .md-content h2, .md-content h3,
    .md-content h4, .md-content h5, .md-content h6 {
      margin-top: 1.2rem;
      margin-bottom: 0.5rem;
      color: var(--text-strong);
    }
    .md-content p { margin-bottom: 0.75rem; }
    .md-content a { color: var(--accent); text-decoration: none; }
    .md-content a:hover { color: var(--accent-hover); text-decoration: underline; }
    .md-content code {
      font-family: var(--font-mono);
      background: var(--bg-hover);
      padding: 0.15em 0.35em;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .md-content pre.md-code {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 1rem;
      overflow-x: auto;
      margin-bottom: 0.75rem;
    }
    .md-content pre.md-code code {
      background: none;
      padding: 0;
      font-size: 0.88rem;
      line-height: 1.5;
    }
    .md-content ul, .md-content ol { margin-bottom: 0.75rem; }
    .md-content strong { color: var(--text-strong); }
    .md-content hr { border: none; border-top: 1px solid var(--border); margin: 1.25rem 0; }

    /* --- HTML block ------------------------------------------------------- */
    .html-content { border-radius: var(--radius-md); overflow: hidden; }

    /* --- Misc ------------------------------------------------------------ */
    a { color: var(--accent); }
    a:hover { color: var(--accent-hover); }
    pre {
      font-family: var(--font-mono);
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    code { font-family: var(--font-mono); }
    ::selection { background: var(--accent-subtle); color: var(--text-strong); }

    @media (max-width: 600px) {
      .site-header { padding: 0 1rem; }
      .page { padding: 1.5rem 1rem 3rem; }
      .hero-title { font-size: 1.6rem; }
      .cards-grid { grid-template-columns: 1fr; }
      .kv-grid { grid-template-columns: 1fr; gap: 0.15rem 0; }
      .kv-key { margin-top: 0.5rem; }
      .site-header .brand-sub { display: none; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="brand">
      <div class="brand-logo">${logo}</div>
      <div class="brand-text">
        <div class="brand-title">DEEPCLAW</div>
        <div class="brand-sub">Page Builder</div>
      </div>
    </div>
    <span class="page-id">${esc(page.id)}</span>
  </header>
  <div class="page">
    <h1 class="page-title">${esc(page.title)}</h1>
    ${page.subtitle ? `<p class="page-subtitle">${esc(page.subtitle)}</p>` : ""}
    ${blocks}
  </div>
  <footer class="site-footer">
    <span>&copy; ${new Date().getFullYear()} Deepgram Labs</span>
  </footer>
  <script>
    (function() {
      var pageId = ${JSON.stringify(page.id)};
      var currentVersion = ${page.version};
      setInterval(function() {
        fetch("/pages/" + encodeURIComponent(pageId) + "/version")
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (data && data.version > currentVersion) {
              location.reload();
            }
          })
          .catch(function() {});
      }, 3000);
    })();
  </script>
</body>
</html>`;
}
