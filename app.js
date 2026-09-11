/* 设定工作台 · 前端逻辑
 * 双数据源：local（本地 server.mjs） / github（GitHub Contents API）
 */

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const CFG_KEY = "novel-workbench-config-v1";

const DEFAULT_CFG = {
  mode: "auto", // auto | local | github
  gh: { owner: "", repo: "", branch: "main", token: "", subdir: "" },
  ai: { baseUrl: "", model: "", apiKey: "" },
};

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CFG));
}

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return cloneDefault();
    const p = JSON.parse(raw);
    const base = cloneDefault();
    return {
      ...base,
      ...p,
      gh: { ...base.gh, ...(p.gh || {}) },
      ai: { ...base.ai, ...(p.ai || {}) },
    };
  } catch {
    return cloneDefault();
  }
}

function saveConfig() {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(config));
  } catch { /* 忽略 */ }
}

let config = loadConfig();
let activeMode = "local";

const state = {
  project: null,
  currentPath: "",
  content: "",
  blocks: [],
  view: "dash",
  aiTarget: null,
  aiCandidates: [],
  aiBusy: false,
  aiStatus: "",
  scrollTop: 0,
  fileShas: {},
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

async function api(path, options) {
  const res = await fetch(path, options);
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((typeof data === "object" ? data.error : data) || `请求失败 ${res.status}`);
  return data;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 按行替换（两种数据源共用） */
function applyLinePatch(content, startLine, endLine, newText) {
  const hadTrailing = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailing) lines.pop();
  const from = Math.max(0, Math.min(startLine, lines.length));
  const toRaw = endLine == null ? startLine : endLine;
  const to = Math.max(from - 1, Math.min(toRaw, lines.length - 1));
  const replacement = newText === "" ? [] : String(newText).split("\n");
  lines.splice(from, to - from + 1, ...replacement);
  return lines.join("\n") + (hadTrailing ? "\n" : "");
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast on${isError ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, isError ? 4200 : 2200);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code style="font-family:var(--mono);font-size:.92em;background:var(--bg-soft);border:1px solid var(--border-soft);padding:0 4px;border-radius:3px">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out;
}

function stripMd(text) {
  return String(text).replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.*?\)/g, "$1").replace(/<br\s*\/?>/gi, " ").trim();
}

/* ------------------------------------------------------------------ */
/* 数据源 · 本地服务                                                    */
/* ------------------------------------------------------------------ */

const LocalSource = {
  label: "本地服务",
  async ready() {
    try {
      const r = await fetch("/api/health", { method: "GET" });
      return r.ok;
    } catch {
      return false;
    }
  },
  async project() { return api("/api/project"); },
  async file(path) { return api(`/api/file?path=${encodeURIComponent(path)}`); },
  async patch(path, start, end, newText) {
    const data = await api("/api/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, startLine: start, endLine: end, newText }),
    });
    return { content: data.nextContent };
  },
  async aiConfig() {
    const c = await api("/api/ai/config");
    return { baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey, keyMask: c.keyMask };
  },
  async saveAiConfig(cfg) {
    const c = await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    return { baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey, keyMask: c.keyMask };
  },
  async aiRewrite(payload) { return api("/api/ai/rewrite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); },
  async canDirectAi() { return true; },
};

/* ------------------------------------------------------------------ */
/* 数据源 · GitHub                                                     */
/* ------------------------------------------------------------------ */

const GitHubSource = {
  label: "GitHub 仓库",
  get g() { return config.gh; },
  ready() {
    return Boolean(this.g.owner && this.g.repo && this.g.token);
  },
  repoUrl() {
    return `https://api.github.com/repos/${this.g.owner}/${this.g.repo}`;
  },
  headers() {
    const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.g.token) h.Authorization = `Bearer ${this.g.token}`;
    return h;
  },
  encPath(rel) {
    const full = this.g.subdir ? `${this.g.subdir.replace(/\/+$/, "")}/${rel}` : rel;
    return full.split("/").map(encodeURIComponent).join("/");
  },
  async req(url, options = {}) {
    const res = await fetch(url, { ...options, headers: { ...this.headers(), ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub ${res.status}`);
    return data;
  },
  async tree(recursive = true) {
    const data = await this.req(`${this.repoUrl()}/git/trees/${encodeURIComponent(this.g.branch)}?recursive=${recursive ? 1 : 0}`);
    return data.tree || [];
  },
  async read(rel) {
    const data = await this.req(`${this.repoUrl()}/contents/${this.encPath(rel)}?ref=${encodeURIComponent(this.g.branch)}`);
    return { content: b64decode(data.content || ""), sha: data.sha };
  },
  async write(rel, content, message, sha) {
    return this.req(`${this.repoUrl()}/contents/${this.encPath(rel)}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: b64encode(content),
        branch: this.g.branch,
        ...(sha ? { sha } : {}),
      }),
    });
  },
  async file(path) {
    const { content } = await this.read(path);
    return { path, content, size: new Blob([content]).size };
  },
  async patch(path, start, end, newText) {
    const { content, sha } = await this.read(path);
    const next = applyLinePatch(content, start, end, newText);
    await this.write(path, next, `编辑 ${path.split("/").pop()} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, sha);
    return { content: next };
  },
  /** 组装与本地模式同构的项目元数据 */
  async project() {
    const flat = await this.tree(true);
    const prefix = this.g.subdir ? `${this.g.subdir.replace(/\/+$/, "")}/` : "";
    const scoped = flat.filter((n) => n.path.startsWith(prefix));
    const rel = (p) => p.slice(prefix.length);
    const under = scoped.filter((n) => n.path !== prefix.slice(0, -1) && rel(n.path) !== "");

    // 构建树
    const root = [];
    const dirMap = new Map();
    const ensureDir = (parts) => {
      let arr = root;
      let acc = "";
      for (const part of parts) {
        acc = acc ? `${acc}/${part}` : part;
        let node = dirMap.get(acc);
        if (!node) {
          node = { type: "dir", name: part, path: acc, children: [] };
          dirMap.set(acc, node);
          arr.push(node);
        }
        arr = node.children;
      }
      return arr;
    };
    for (const n of under) {
      const r = rel(n.path);
      const parts = r.split("/");
      const name = parts.pop();
      const arr = ensureDir(parts);
      if (n.type === "blob") {
        if (!/\.(md|txt|json|ya?ml)$/i.test(name)) continue;
        arr.push({ type: "file", name, path: r, size: n.size || 0 });
      }
    }
    const sortTree = (nodes) => {
      nodes.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name, "zh-Hans-CN")));
      nodes.forEach((n) => n.children && sortTree(n.children));
    };
    sortTree(root);

    const has = (p) => under.some((n) => rel(n.path) === p);
    const readOpt = async (p) => {
      try {
        if (!has(p)) return null;
        return (await this.read(p)).content;
      } catch { return null; }
    };

    // 追踪
    let tracking = null;
    const trackRaw = await readOpt("追踪/_tracking-state.json");
    if (trackRaw) { try { tracking = JSON.parse(trackRaw); } catch { /* 忽略 */ } }

    // 伏笔
    const foreshadows = [];
    const fRaw = await readOpt("主线/表3-伏笔管理.md");
    if (fRaw) {
      for (const line of fRaw.split("\n")) {
        const m = line.match(/^\|\s*(V\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/);
        if (m) foreshadows.push({ id: m[1].trim(), content: stripMd(m[2]).slice(0, 120), status: stripMd(m[6]).trim() || "规划" });
      }
    }

    // 大纲
    const chapters = { planned: 0, written: 0, nights: [], writtenChars: 0 };
    const oRaw = await readOpt("大纲/章级大纲.md");
    if (oRaw) {
      for (const line of oRaw.split("\n")) {
        const n = line.match(/^##\s*第\s*(\d+)\s*夜\s*[·・]?\s*(.*)$/);
        if (n) chapters.nights.push({ night: Number(n[1]), title: n[2].trim() });
        const c = line.match(/^\|\s*(\d+)\s*\|/);
        if (c) chapters.planned = Math.max(chapters.planned, Number(c[1]));
      }
    }

    // 正文（云端只有 size，按 UTF-8 中文约 3 字节/字估算）
    const bodyFiles = under.filter((n) => n.type === "blob" && /^正文\/.*\.(md|txt)$/i.test(rel(n.path)));
    chapters.written = bodyFiles.length;
    chapters.writtenChars = Math.round(bodyFiles.reduce((s, n) => s + (n.size || 0), 0) / 3);

    let fileCount = 0;
    const walk = (ns) => ns.forEach((n) => (n.type === "file" ? (fileCount += 1) : walk(n.children)));
    walk(root);

    return {
      book: tracking?.book || this.g.subdir || `${this.g.owner}/${this.g.repo}`,
      root: `${this.g.owner}/${this.g.repo}@${this.g.branch}${this.g.subdir ? "/" + this.g.subdir : ""}`,
      tree: root,
      fileCount,
      tracking: tracking || {},
      pending: tracking?.pending_decisions || [],
      foreshadows,
      chapters,
      stage: tracking?.stage || "",
      updatedAt: tracking?.updated_at || "",
      positioning: (await readOpt("设定/题材定位.md")) || "",
    };
  },
  async aiConfig() {
    const a = config.ai;
    return { baseUrl: a.baseUrl, model: a.model, hasKey: Boolean(a.apiKey), keyMask: a.apiKey ? `${a.apiKey.slice(0, 4)}…${a.apiKey.slice(-4)}` : "" };
  },
  async saveAiConfig(cfg) {
    config.ai.baseUrl = cfg.baseUrl ?? config.ai.baseUrl;
    config.ai.model = cfg.model ?? config.ai.model;
    if (cfg.apiKey) config.ai.apiKey = cfg.apiKey;
    saveConfig();
    return this.aiConfig();
  },
  /** GitHub 模式下 AI 由浏览器直连（仅支持放行 CORS 的网关，如 OpenRouter） */
  async aiRewrite(payload) {
    const { baseUrl, model, apiKey } = config.ai;
    if (!baseUrl || !model || !apiKey) throw new Error("尚未配置 AI 接口（浏览器直连需选支持 CORS 的网关，如 OpenRouter）");
    const prompt = buildPrompt(payload);
    const n = Math.max(1, Math.min(3, Number(payload.count) || 1));
    const run = (temp) => fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: temp,
        messages: [
          { role: "system", content: "你是严谨的中文网文设定编辑，严格遵守文风禁令，只输出被要求的 Markdown 片段。" },
          { role: "user", content: prompt },
        ],
      }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`模型接口 ${r.status}`);
      const d = await r.json();
      return String(d?.choices?.[0]?.message?.content || "").trim();
    });
    const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => run(0.7 + i * 0.15)));
    const candidates = results.map((r) => (r.status === "fulfilled" ? r.value : ""));
    const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message);
    if (candidates.every((c) => !c)) throw new Error(errors[0] || "模型没有返回内容");
    return { candidates, errors };
  },
  async canDirectAi() {
    return Boolean(config.ai.baseUrl && config.ai.model && config.ai.apiKey);
  },
};

/* ------------------------------------------------------------------ */
/* 数据源路由                                                          */
/* ------------------------------------------------------------------ */

function source() {
  return activeMode === "github" ? GitHubSource : LocalSource;
}

async function resolveMode() {
  if (config.mode === "local") return "local";
  if (config.mode === "github") return "github";
  // auto
  if (await LocalSource.ready()) return "local";
  return GitHubSource.ready() ? "github" : "github";
}

/* ------------------------------------------------------------------ */
/* AI prompt（两种模式共用，本地模式也走前端构造）                          */
/* ------------------------------------------------------------------ */

const STYLE_RULES = [
  "禁否定式无画面句式：不像/从来不是/不是X而是Y/哪里是分明是/与其说不如说",
  "禁「很 X」式程度副词（很安静、很诡异）",
  "禁破折号滥用：密度 ≤3 处/千字；禁双破折号「——X——」",
  "禁章末升华抒情（别总结、别感慨、别拔高）",
  "禁时间调度词与旁白式转场",
  "禁用无来源的「被」字句（对话与独立独白豁免）",
  "禁属性介绍腔（把设定当说明书念）",
  "禁内心转述腔（他想，她明白，他知道）",
  "禁生造「不X不Y」四字结构",
  "禁叙述者收束（于是/就这样/一切都…）",
  "画面优先：可观察的细节替代定性结论，主角主观感受优先，听觉友好",
  "叙述详略可量化：重要处展开成动作分解，次要处一句带过",
].join("\n");

function buildPrompt({ instruction, text, context }) {
  const c = context || {};
  const L = [];
  L.push("你是长篇网文的设定/大纲编辑。请按要求改写给定的 Markdown 片段。");
  L.push("", "## 项目");
  L.push(c.book ? `《${c.book}》` : "（未提供书名）");
  if (c.positioning) {
    L.push("核心定位（节选）：", c.positioning.slice(0, 900));
  }
  if (c.filePath) {
    L.push("", "## 位置", `文件：${c.filePath}`);
    if (c.headingPath) L.push(`章节：${c.headingPath}`);
  }
  if (c.before) L.push("", "## 上文（仅供理解语境，不要改写）", c.before.slice(-1200));
  L.push("", "## 待改写文本", "```markdown", text, "```");
  if (c.after) L.push("", "## 下文（仅供理解语境，不要改写）", c.after.slice(0, 800));
  L.push("", "## 改写要求");
  L.push(instruction || "在保持原意与信息量不变的前提下，改写得更清晰、更有画面感。");
  L.push("", "## 硬约束");
  L.push("- 只输出改写后的 Markdown 片段本身，不要任何解释、前言、代码围栏");
  L.push("- 保持原有的 Markdown 结构（标题层级、表格列数、列表符号）；若是表格，必须保持列数与表头");
  L.push("- 与上文既有设定严格一致，不要引入新设定、新名字、新数值");
  L.push("- 遵守以下文风禁令（违反即不合格）：", STYLE_RULES);
  return L.join("\n");
}

/* ------------------------------------------------------------------ */
/* Markdown 块解析                                                      */
/* ------------------------------------------------------------------ */

const RE = {
  heading: /^(#{1,6})\s+/,
  table: /^\s*\|.*\|\s*$/,
  code: /^\s*(```|~~~)/,
  quote: /^\s*>\s?/,
  list: /^\s*([-*+]|\d+[.)])\s+/,
  hr: /^\s*(-{3,}|\*{3,}|_{3,})\s*$/,
  blank: /^\s*$/,
};

function parseBlocks(md) {
  const lines = md.split("\n");
  const isBlank = (s) => RE.blank.test(s);
  const isTable = (s) => RE.table.test(s);
  const isCode = (s) => RE.code.test(s);
  const isQuote = (s) => RE.quote.test(s);
  const isList = (s) => RE.list.test(s);
  const isHeading = (s) => RE.heading.test(s);
  const isHr = (s) => RE.hr.test(s);
  const isSpecial = (s) => isHeading(s) || isTable(s) || isCode(s) || isQuote(s) || isList(s) || isHr(s);

  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) { i += 1; continue; }
    const start = i;
    let type = "p";
    if (isHeading(lines[i])) type = "heading";
    else if (isTable(lines[i])) type = "table";
    else if (isCode(lines[i])) type = "code";
    else if (isQuote(lines[i])) type = "quote";
    else if (isList(lines[i])) type = "list";
    else if (isHr(lines[i])) type = "hr";

    let end = i;
    if (type === "table") {
      while (end + 1 < lines.length && isTable(lines[end + 1])) end += 1;
    } else if (type === "code") {
      const fence = lines[i].trim().slice(0, 3);
      while (end + 1 < lines.length) { end += 1; if (lines[end].trim().startsWith(fence)) break; }
    } else if (type === "quote") {
      while (end + 1 < lines.length && isQuote(lines[end + 1])) end += 1;
    } else if (type === "list") {
      while (end + 1 < lines.length) {
        const nxt = lines[end + 1];
        if (isList(nxt)) { end += 1; continue; }
        if (!isBlank(nxt) && /^\s{2,}\S/.test(nxt) && !isSpecial(nxt)) { end += 1; continue; }
        break;
      }
    } else if (type === "p") {
      while (end + 1 < lines.length && !isBlank(lines[end + 1]) && !isSpecial(lines[end + 1])) end += 1;
    }

    let trail = end;
    while (trail + 1 < lines.length && isBlank(lines[trail + 1])) trail += 1;

    const body = lines.slice(start, end + 1).join("\n");
    const raw = lines.slice(start, trail + 1).join("\n");
    blocks.push({ type, body, trailing: raw.slice(body.length), start, bodyEnd: end, end: trail });
    i = trail + 1;
  }
  return blocks;
}

function headingLevel(body) {
  const m = body.match(RE.heading);
  return m ? m[1].length : 0;
}

function parseTable(body) {
  const rows = body.split("\n").map((l) => l.trim());
  const cells = (line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const head = cells(rows[0] || "");
  return { head, sep: rows[1] || "", bodyRows: rows.slice(2).map(cells) };
}

function rowToMd(cells) {
  return `| ${cells.join(" | ")} |`;
}

/* ------------------------------------------------------------------ */
/* 顶部 / 侧栏                                                         */
/* ------------------------------------------------------------------ */

function renderChrome() {
  const p = state.project;
  if (!p) return;
  $("#brandName").textContent = p.book || "设定工作台";
  $("#brandSub").textContent = activeMode === "github"
    ? `GH · ${p.stage ? p.stage.replace("outline-draft-", "") : p.fileCount + " 文件"}`
    : (p.stage ? p.stage.replace("outline-draft-", "") : `${p.fileCount} 个文件`);
  document.title = `${p.book || "设定工作台"} · 设定工作台`;
}

function fileIcon(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".json")) return "◆";
  if (n.includes("表")) return "▤";
  if (n.includes("大纲")) return "☰";
  if (n.includes("题材") || n.includes("世界观")) return "◈";
  return "·";
}

function renderTree() {
  const host = $("#tree");
  const p = state.project;
  if (!p) { host.innerHTML = ""; return; }
  const html = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      if (n.type === "dir") {
        const hasFile = (function any(x) { return x.some((c) => c.type === "file" || (c.children && any(c.children))); })(n.children || []);
        if (!hasFile) continue;
        html.push(`<div class="group" style="padding-left:${10 + depth * 8}px">${escapeHtml(n.name)}</div>`);
        walk(n.children, depth + 1);
      } else {
        const on = n.path === state.currentPath ? " on" : "";
        const kb = n.size ? `${Math.max(1, Math.round(n.size / 1024))}k` : "";
        html.push(`<div class="item${on}" data-path="${escapeHtml(n.path)}" style="padding-left:${10 + depth * 10}px">
          <span class="mark"></span>
          <span style="overflow:hidden;text-overflow:ellipsis">${fileIcon(n.name)} ${escapeHtml(n.name)}</span>
          <span class="meta">${kb}</span>
        </div>`);
      }
    }
  };
  walk(p.tree || [], 0);
  host.innerHTML = html.join("");
  host.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.path)));
}

/* ------------------------------------------------------------------ */
/* 概览                                                                */
/* ------------------------------------------------------------------ */

function renderDash() {
  const p = state.project;
  const m = $("#main");
  if (!p) { m.innerHTML = `<div class="empty">加载中…</div>`; return; }

  const c = p.chapters || {};
  const planned = c.planned || 36;
  const written = c.written || 0;
  const chars = c.writtenChars || 0;
  const target = p.tracking?.word_target || 80000;
  const pct = target ? Math.min(100, Math.round((chars / target) * 100)) : 0;
  const approx = activeMode === "github" && chars > 0 ? "≈" : "";

  const ranges = { 1: "1–4", 2: "5–9", 3: "10–14", 4: "15–19", 5: "20–24", 6: "25–29", 7: "30–34" };
  const nights = (c.nights || []).map((n) => `<div class="night" data-file="大纲/章级大纲.md">
      <span class="n">第 ${n.night} 夜</span>
      <span class="t">${escapeHtml(n.title || "")}</span>
      <span class="c">${ranges[n.night] || ""} 章</span>
    </div>`).join("");

  const fchips = (p.foreshadows || []).map((f) => {
    const st = f.status.includes("悬") ? "susp" : f.status.includes("收") ? "done" : "plan";
    return `<span class="fchip ${st}" title="${escapeHtml(f.content)}"><b>${escapeHtml(f.id)}</b>${escapeHtml(f.status || "规划")}</span>`;
  }).join("");

  const todos = (p.pending || []).map((t) => `<li>${escapeHtml(typeof t === "string" ? t : JSON.stringify(t))}</li>`).join("");

  const quickFiles = [
    ["设定/题材定位.md", "题材定位"],
    ["设定/世界观与技能体系.md", "世界观·技能"],
    ["大纲/副本一-规则体系.md", "规则体系"],
    ["大纲/章级大纲.md", "章级大纲"],
    ["主线/表3-伏笔管理.md", "伏笔表"],
    ["主线/表2-角色知识状态.md", "角色知识"],
    ["主线/表1-主线总纲与锚点.md", "主线锚点"],
    ["主线/钩子矩阵.md", "钩子矩阵"],
  ];

  const modeHint = activeMode === "github"
    ? `<span class="badge gh" title="${escapeHtml(p.root || "")}">GitHub 云端</span>`
    : `<span class="badge local">本地</span>`;

  m.innerHTML = `
    <div class="dash">
      <h1>${escapeHtml(p.book || "")} ${modeHint}</h1>
      <p class="lede">
        ${escapeHtml(p.tracking?.genre || "")}
        ${p.tracking?.core_play ? `<br>${escapeHtml(String(p.tracking.core_play).slice(0, 130))}` : ""}
      </p>

      <div class="metrics">
        <div class="metric"><div class="k">章节进度</div><div class="v">${written}<small>/ ${planned} 章</small></div></div>
        <div class="metric"><div class="k">正文体量</div><div class="v">${approx}${chars}<small>/ ${target} 字</small></div></div>
        <div class="metric"><div class="k">完成度</div><div class="v">${pct}<small>%</small></div></div>
        <div class="metric"><div class="k">文件</div><div class="v">${p.fileCount}<small>个</small></div></div>
      </div>

      <div class="sec">
        <h2>七夜结构</h2>
        <div class="nights">${nights || '<div class="empty">未解析到大纲</div>'}</div>
      </div>

      <div class="sec">
        <h2>伏笔状态（${(p.foreshadows || []).length}）</h2>
        <div class="flist">${fchips || '<span class="fchip">未解析到伏笔表</span>'}</div>
      </div>

      <div class="sec">
        <h2>待定案（${(p.pending || []).length}）</h2>
        <ul class="todo">${todos || "<li>暂无</li>"}</ul>
      </div>

      <div class="sec">
        <h2>快速进入</h2>
        <div class="quick">
          ${quickFiles.map(([f, label]) => `<button class="qbtn" data-file="${f}">${label}</button>`).join("")}
        </div>
      </div>
    </div>
  `;

  m.querySelectorAll("[data-file]").forEach((el) => el.addEventListener("click", () => openFile(el.dataset.file)));
  m.scrollTop = 0;
}

/* ------------------------------------------------------------------ */
/* 文档                                                                */
/* ------------------------------------------------------------------ */

async function openFile(path) {
  try {
    const data = await source().file(path);
    state.currentPath = path;
    state.content = data.content;
    state.blocks = parseBlocks(data.content);
    state.view = "doc";
    setTab("doc");
    renderTree();
    renderDoc();
    $("#crumb").innerHTML = `<b>${escapeHtml(path)}</b> · ${state.blocks.length} 块`;
  } catch (err) {
    toast(`打开失败：${err.message}`, true);
  }
}

function renderDoc() {
  const m = $("#main");
  const html = [`<div class="doc">
    <div class="doc-head">
      <span class="p">${escapeHtml(state.currentPath)}</span>
      <span class="act">
        <span style="font-size:11px;color:var(--text-faint)">${state.blocks.length} 块</span>
        <button class="mini" id="reloadBtn">重新载入</button>
      </span>
    </div>`];

  state.blocks.forEach((b, idx) => {
    html.push(`<div class="insert-rail" data-insert="${idx}"><i></i><span>+ 插入</span><i></i></div>`);
    html.push(renderBlock(b, idx));
  });
  html.push(`<div class="insert-rail" data-insert="${state.blocks.length}"><i></i><span>+ 插入到末尾</span><i></i></div></div>`);

  m.innerHTML = html.join("");
  bindDocEvents();
  m.scrollTop = state.scrollTop;
}

function renderBlock(b, idx) {
  const tools = `<div class="tools">
    <button class="ai" data-act="ai" title="AI 改写这一段">✦</button>
    <button data-act="up" title="上移">↑</button>
    <button data-act="down" title="下移">↓</button>
    <button data-act="insert" title="在下方插入">＋</button>
    <button data-act="del" title="删除">✕</button>
  </div>`;

  let inner = "";
  let cls = "";

  if (b.type === "heading") {
    cls = `h${headingLevel(b.body)}`;
    inner = inlineMd(b.body.replace(RE.heading, ""));
  } else if (b.type === "hr") {
    cls = "hr";
    inner = `<div style="height:1px;background:var(--border-soft)"></div>`;
  } else if (b.type === "quote") {
    cls = "quote";
    inner = b.body.split("\n").map((l) => inlineMd(l.replace(RE.quote, ""))).join("<br>");
  } else if (b.type === "list") {
    cls = "list";
    const lines = b.body.split("\n");
    const ordered = /^\s*\d/.test(lines[0]);
    const tag = ordered ? "ol" : "ul";
    inner = `<${tag}>${lines.map((l) => `<li>${inlineMd(l.replace(RE.list, ""))}</li>`).join("")}</${tag}>`;
  } else if (b.type === "code") {
    cls = "code";
    const lines = b.body.split("\n");
    inner = `<pre>${escapeHtml(lines.slice(1, Math.max(1, lines.length - 1)).join("\n"))}</pre>`;
  } else if (b.type === "table") {
    cls = "table";
    inner = renderTable(b, idx);
  } else {
    cls = "p";
    inner = escapeHtml(b.body).split("\n").map(inlineMd).join("<br>");
  }

  return `<div class="block ${cls}" data-idx="${idx}" data-type="${b.type}">${tools}<div class="blk-body">${inner}</div></div>`;
}

function renderTable(b, idx) {
  const { head, bodyRows } = parseTable(b.body);
  const th = head.map((h) => `<th>${inlineMd(h)}</th>`).join("");
  const trs = bodyRows.map((cells, r) => {
    const tds = cells.map((c, ci) => `<td contenteditable="true" data-row="${r}" data-col="${ci}">${inlineMd(c)}</td>`).join("");
    return `<tr data-row="${r}">${tds}<td style="width:1px;border:none;padding:0">
      <div class="rowtools">
        <button data-ra="up" data-row="${r}" title="上移">↑</button>
        <button data-ra="down" data-row="${r}" title="下移">↓</button>
        <button data-ra="add" data-row="${r}" title="下方插入行">＋</button>
        <button data-ra="rm" data-row="${r}" title="删除行">✕</button>
      </div></td></tr>`;
  }).join("");
  return `<table class="md"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function bindDocEvents() {
  const m = $("#main");
  const reload = m.querySelector("#reloadBtn");
  if (reload) reload.addEventListener("click", () => openFile(state.currentPath));

  m.querySelectorAll(".block").forEach((el) => {
    const idx = Number(el.dataset.idx);
    el.querySelectorAll(".tools button").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.act;
        if (act === "ai") openAiPanel(idx);
        if (act === "up") moveBlock(idx, -1);
        if (act === "down") moveBlock(idx, 1);
        if (act === "insert") insertBlockAfter(idx);
        if (act === "del") deleteBlock(idx);
      });
    });
    const body = el.querySelector(".blk-body");
    if (body && !["table", "hr"].includes(el.dataset.type)) {
      body.addEventListener("dblclick", () => startEditBlock(idx));
    }
  });

  m.querySelectorAll("table.md").forEach((table) => {
    const idx = Number(table.closest(".block").dataset.idx);
    table.querySelectorAll("td[contenteditable]").forEach((td) => {
      td.addEventListener("focus", () => { td.dataset.orig = td.textContent; });
      td.addEventListener("blur", () => {
        if (td.dataset.orig === td.textContent) return;
        saveTableCell(idx, Number(td.dataset.row), table);
      });
      td.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); td.blur(); }
        if (ev.key === "Escape") { td.textContent = td.dataset.orig || ""; td.blur(); }
      });
    });
    table.querySelectorAll(".rowtools button").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        tableRowAction(idx, Number(btn.dataset.row), btn.dataset.ra);
      });
    });
  });

  m.querySelectorAll(".insert-rail").forEach((el) => {
    el.addEventListener("click", () => insertAt(Number(el.dataset.insert)));
  });
}

/* ------------------------------------------------------------------ */
/* 编辑                                                                */
/* ------------------------------------------------------------------ */

async function patchLines(startLine, endLine, newText) {
  const data = await source().patch(state.currentPath, startLine, endLine, newText);
  state.content = data.content;
  state.blocks = parseBlocks(data.content);
  state.scrollTop = $("#main").scrollTop;
  renderDoc();
  $("#crumb").innerHTML = `<b>${escapeHtml(state.currentPath)}</b> · ${state.blocks.length} 块`;
  refreshProjectQuiet();
}

async function refreshProjectQuiet() {
  try {
    state.project = await source().project();
    renderChrome();
    renderTree();
  } catch { /* 忽略 */ }
}

function startEditBlock(idx) {
  const b = state.blocks[idx];
  const el = $(`.block[data-idx="${idx}"]`);
  if (!el || el.classList.contains("editing")) return;
  const raw = b.type === "hr" ? "---" : b.body;
  el.classList.add("editing");
  el.querySelector(".blk-body").innerHTML = `
    <textarea class="editor-area${["code", "table"].includes(b.type) ? " mono" : ""}">${escapeHtml(raw)}</textarea>
    <div class="edit-hint">
      <span><kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> 保存</span>
      <span><kbd>Esc</kbd> 取消</span>
      <span>换行会保留原始 Markdown</span>
    </div>`;
  const ta = el.querySelector("textarea");
  ta.style.height = `${Math.min(560, Math.max(72, ta.scrollHeight + 6))}px`;
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const save = async () => {
    const val = ta.value;
    if (val === raw) { renderDoc(); return; }
    try {
      toast(activeMode === "github" ? "提交中…" : "保存中…");
      await patchLines(b.start, b.bodyEnd, val);
      toast(activeMode === "github" ? "已提交到 GitHub" : "已保存");
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  };
  ta.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); save(); }
    if (ev.key === "Escape") { ev.preventDefault(); renderDoc(); }
  });
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(560, Math.max(72, ta.scrollHeight + 6))}px`;
  });
}

async function deleteBlock(idx) {
  const b = state.blocks[idx];
  if (!confirm("删除这一段？")) return;
  try {
    await patchLines(b.start, b.end, "");
    toast("已删除");
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
}

async function moveBlock(idx, dir) {
  const b = state.blocks[idx];
  const other = state.blocks[idx + dir];
  if (!other) { toast("已经到头了"); return; }
  const [first, second] = dir < 0 ? [b, other] : [other, b];
  const merged = `${first.body}${second.trailing}\n${second.body}${first.trailing}`;
  try {
    await patchLines(first.start, second.end, merged.replace(/\n$/, ""));
    toast("已移动");
  } catch (err) {
    toast(`移动失败：${err.message}`, true);
  }
}

function insertBlockAfter(idx) {
  const b = state.blocks[idx];
  insertAt(b ? b.end + 1 : 0, idx);
}

function insertAt(lineNo, afterIdx) {
  const anchor = afterIdx != null ? $(`.block[data-idx="${afterIdx}"]`) : null;
  const host = document.createElement("div");
  host.className = "block editing";
  host.style.margin = "2px -10px";
  host.innerHTML = `
    <textarea class="editor-area" placeholder="输入新段落（支持 Markdown）"></textarea>
    <div class="edit-hint"><span><kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> 插入</span><span><kbd>Esc</kbd> 取消</span></div>`;
  if (anchor && anchor.nextSibling) anchor.parentNode.insertBefore(host, anchor.nextSibling);
  else $("#main").querySelector(".doc").appendChild(host);

  const ta = host.querySelector("textarea");
  ta.style.height = "78px";
  ta.focus();
  const commit = async () => {
    const val = ta.value.trim();
    if (!val) { host.remove(); return; }
    try {
      await patchLines(lineNo, lineNo - 1, `${val}\n`);
      toast("已插入");
    } catch (err) {
      toast(`插入失败：${err.message}`, true);
      host.remove();
    }
  };
  ta.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") { ev.preventDefault(); commit(); }
    if (ev.key === "Escape") { ev.preventDefault(); host.remove(); }
  });
  ta.addEventListener("blur", () => { if (!ta.value.trim()) host.remove(); });
}

async function saveTableCell(idx, rowIdx, table) {
  const b = state.blocks[idx];
  const cells = [...table.querySelectorAll(`td[data-row="${rowIdx}"]`)]
    .sort((a, c) => Number(a.dataset.col) - Number(c.dataset.col))
    .map((td) => td.textContent.trim());
  const lineNo = b.start + 1 + 1 + rowIdx;
  try {
    await patchLines(lineNo, lineNo, rowToMd(cells));
    toast("已保存");
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

async function tableRowAction(idx, rowIdx, act) {
  const b = state.blocks[idx];
  const { head, bodyRows } = parseTable(b.body);
  const rowLine = b.start + 2 + rowIdx;
  const cells = bodyRows[rowIdx] || head.map(() => "");
  try {
    if (act === "rm") {
      if (!confirm("删除这一行？")) return;
      await patchLines(rowLine, rowLine, "");
    } else if (act === "add") {
      await patchLines(rowLine + 1, rowLine, `${rowToMd(head.map(() => " "))}\n`);
    } else if (act === "up" || act === "down") {
      const target = act === "up" ? rowIdx - 1 : rowIdx + 1;
      if (target < 0 || target >= bodyRows.length) { toast("已经到头了"); return; }
      const other = bodyRows[target];
      const lo = Math.min(rowLine, b.start + 2 + target);
      const hi = Math.max(rowLine, b.start + 2 + target);
      const first = act === "up" ? cells : other;
      const second = act === "up" ? other : cells;
      await patchLines(lo, hi, `${rowToMd(first)}\n${rowToMd(second)}`);
    }
  } catch (err) {
    toast(`操作失败：${err.message}`, true);
  }
}

/* ------------------------------------------------------------------ */
/* AI 抽屉                                                             */
/* ------------------------------------------------------------------ */

const AI_PRESETS = [
  { label: "更精炼", instruction: "压缩到原来七成篇幅：删掉一切可有可无的修饰，信息密度提高，但不得丢失任何设定信息。" },
  { label: "更具体", instruction: "展开得更具体：补可观察的细节、动作分解与具体量度，把概括性表述替换成能看见的现场。信息量只增不减。" },
  { label: "更狠（加压迫感）", instruction: "加强压迫感与恐怖质感：具体化异常细节，让不安来自可观察的现场，而不是形容词。" },
  { label: "补细节", instruction: "在不改变任何结论的前提下，补足可核实的具体细节（数量、时间、动作、可观察物）。" },
  { label: "去 AI 味", instruction: "按文风禁令逐条清洗：重点消除否定式句式（不是A而是B）、「很X」、属性介绍腔、内心转述腔、叙述者收束。" },
  { label: "三个方向", instruction: "给出三个不同改写方向，分别侧重：A 信息密度优先；B 口语节奏与幽默优先；C 最短最狠。", count: 3 },
];

function headingPathOf(idx) {
  const path = [];
  for (let i = idx - 1; i >= 0; i -= 1) {
    const b = state.blocks[i];
    if (b.type !== "heading") continue;
    const lv = headingLevel(b.body);
    if (!path.length || lv < path[path.length - 1].lv) path.push({ lv, text: b.body.replace(RE.heading, "").trim() });
    if (lv === 1) break;
  }
  return path.reverse().map((p) => p.text).join(" › ");
}

function openAiPanel(idx) {
  const b = state.blocks[idx];
  if (!b) return;
  state.aiTarget = {
    idx,
    start: b.start,
    bodyEnd: b.bodyEnd,
    type: b.type,
    text: b.body,
    before: state.blocks.slice(Math.max(0, idx - 3), idx).map((x) => x.body).join("\n\n"),
    after: state.blocks.slice(idx + 1, idx + 3).map((x) => x.body).join("\n\n"),
    headingPath: headingPathOf(idx),
  };
  state.aiCandidates = [];
  state.aiStatus = "";
  $("#aiLoc").textContent = `${state.currentPath} : ${b.start + 1}`;
  renderAiPanel();
  $("#aiPanel").classList.add("open");
}

function closeAiPanel() { $("#aiPanel").classList.remove("open"); }

function renderAiPanel() {
  const t = state.aiTarget;
  const body = $("#aiBody");
  if (!t) {
    body.innerHTML = `<div class="note">在文档里把鼠标移到某一段上，点 <b>✦</b>，就可以让 AI 改写这一段。</div>`;
    return;
  }

  const presets = AI_PRESETS.map((p, i) => `<button class="chip" data-preset="${i}">${escapeHtml(p.label)}</button>`).join("");
  const cands = state.aiCandidates.map((c, i) => `
    <div class="cand">
      <div class="ch">
        <span class="n">候选 ${i + 1}</span><span class="sp"></span>
        <button data-copy="${i}">复制</button>
        <button class="pri" data-apply="${i}">替换原文</button>
      </div>
      <div class="cb">${escapeHtml(c)}</div>
    </div>`).join("");

  const aiKey = activeMode === "github" ? (config.ai.apiKey ? "已配置" : "") : "";
  const hintLocal = `已配置：<b>${escapeHtml(state.aiConfig?.model || config.ai.model || "")}</b>，可直接在界面内生成。`;
  const hintNone = activeMode === "github"
    ? `云端模式：浏览器直连模型需要网关放行跨域（OpenRouter 等）；否则用「复制 Prompt」把提示词贴到对话里让 Agent 改写。`
    : `未配置 API。可先「复制 Prompt」贴到对话里让 Agent 改写，再贴回来；或在「设置」里填 OpenAI 兼容接口。`;

  body.innerHTML = `
    <div class="ai-target">${escapeHtml(t.text.slice(0, 900))}${t.text.length > 900 ? "\n…" : ""}</div>
    <div class="ai-label">改写方向</div>
    <div class="chips" id="presetChips">${presets}</div>
    <div class="ai-label">补充要求（可选）</div>
    <textarea class="ai-input" id="aiInstruction" placeholder="例如：把这段改得更像便利店的真实夜班口吻，别用书面语"></textarea>
    <div class="note">${(state.aiConfig?.hasKey || aiKey) ? hintLocal : hintNone}</div>
    <div class="row">
      <button class="btn wide" id="copyPrompt">复制 Prompt</button>
      <button class="btn primary wide" id="runAi" ${(state.aiConfig?.hasKey || aiKey) ? "" : "disabled"}>一键生成</button>
    </div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="multiCand"> 出 3 个候选</label>
      <span class="spacer"></span>
      <span style="font-size:11px;color:var(--text-faint)">${state.aiBusy ? '<span class="spinner"></span> 生成中…' : escapeHtml(state.aiStatus)}</span>
    </div>
    <div class="cands">${cands}</div>
  `;

  let activePreset = null;
  body.querySelectorAll("[data-preset]").forEach((el) => {
    el.addEventListener("click", () => {
      const p = AI_PRESETS[Number(el.dataset.preset)];
      body.querySelectorAll("[data-preset]").forEach((x) => x.classList.remove("on"));
      el.classList.add("on");
      activePreset = p;
      $("#multiCand").checked = Boolean(p.count && p.count > 1);
      const inst = $("#aiInstruction");
      if (!inst.value.trim()) inst.placeholder = p.instruction;
    });
  });
  $("#copyPrompt").addEventListener("click", () => copyPrompt(activePreset));
  $("#runAi").addEventListener("click", () => runAi(activePreset));

  body.querySelectorAll("[data-copy]").forEach((el) => el.addEventListener("click", async () => {
    await navigator.clipboard.writeText(state.aiCandidates[Number(el.dataset.copy)]).then(
      () => toast("候选已复制"), () => toast("复制失败", true));
  }));
  body.querySelectorAll("[data-apply]").forEach((el) => el.addEventListener("click", async () => {
    try {
      await patchLines(t.start, t.bodyEnd, state.aiCandidates[Number(el.dataset.apply)]);
      toast(activeMode === "github" ? "已替换并提交" : "已替换");
      closeAiPanel();
    } catch (err) {
      toast(`替换失败：${err.message}`, true);
    }
  }));
}

function collectInstruction(activePreset) {
  const custom = $("#aiInstruction")?.value.trim() || "";
  const presetText = activePreset?.instruction || "";
  if (custom && presetText) return `${presetText}\n${custom}`;
  return custom || presetText || "在保持原意与信息量不变的前提下，改写得更清晰、更有画面感。";
}

function aiContextPayload() {
  const t = state.aiTarget;
  return {
    book: state.project?.book || "",
    filePath: state.currentPath,
    headingPath: t?.headingPath || "",
    before: t?.before || "",
    after: t?.after || "",
    positioning: state.project?.positioning || "",
  };
}

async function copyPrompt(activePreset) {
  const t = state.aiTarget;
  if (!t) return;
  try {
    const prompt = buildPrompt({
      text: t.text,
      instruction: collectInstruction(activePreset),
      context: aiContextPayload(),
    });
    await navigator.clipboard.writeText(prompt);
    toast("Prompt 已复制，可贴到对话里让 Agent 改写");
  } catch (err) {
    toast(`生成 Prompt 失败：${err.message}`, true);
  }
}

async function runAi(activePreset) {
  const t = state.aiTarget;
  if (!t) return;
  const count = $("#multiCand")?.checked ? 3 : 1;
  state.aiBusy = true;
  state.aiStatus = "生成中…";
  renderAiPanel();
  try {
    const { candidates } = await source().aiRewrite({
      text: t.text,
      instruction: collectInstruction(activePreset),
      context: aiContextPayload(),
      count,
    });
    state.aiCandidates = candidates.filter(Boolean);
    state.aiStatus = "";
    state.aiBusy = false;
    renderAiPanel();
    toast(`生成 ${state.aiCandidates.length} 个候选`);
  } catch (err) {
    state.aiBusy = false;
    state.aiStatus = "";
    renderAiPanel();
    toast(`生成失败：${err.message}`, true);
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

async function renderSettings() {
  const m = $("#main");
  const g = config.gh;
  const a = config.ai;
  const localOk = await LocalSource.ready();

  m.innerHTML = `
    <div class="settings">
      <h1>设置</h1>
      <p class="lede">数据源决定「改哪里」。本地模式读写你电脑上的文件；GitHub 模式直接读写云端仓库（每次保存 = 一次 commit，手机也能改）。</p>

      <div class="sec">
        <h2>数据源</h2>
        <div class="field">
          <label>当前模式</label>
          <div class="chips" id="modeChips">
            <button class="chip ${config.mode === "auto" ? "on" : ""}" data-mode="auto">自动（${localOk ? "检测到本地服务" : "无本地服务"}）</button>
            <button class="chip ${config.mode === "local" ? "on" : ""}" data-mode="local" ${localOk ? "" : "disabled"}>本地服务</button>
            <button class="chip ${config.mode === "github" ? "on" : ""}" data-mode="github">GitHub 仓库</button>
          </div>
        </div>

        <div class="grid2">
          <div class="field"><label>Owner</label><input id="ghOwner" placeholder="drkingon" value="${escapeHtml(g.owner)}" /></div>
          <div class="field"><label>Repository</label><input id="ghRepo" placeholder="novel-settings" value="${escapeHtml(g.repo)}" /></div>
          <div class="field"><label>Branch</label><input id="ghBranch" placeholder="main" value="${escapeHtml(g.branch)}" /></div>
          <div class="field"><label>内容目录（仓库内的书目录）</label><input id="ghSubdir" placeholder="规则怪谈我只信对照组" value="${escapeHtml(g.subdir)}" /></div>
        </div>

        <div class="field">
          <label>Personal Access Token ${g.token ? "（已保存，留空则不改动）" : ""}</label>
          <input id="ghToken" type="password" placeholder="${g.token ? "••••••••" : "github_pat_..."}" />
          <div class="hint">仅存本机浏览器 localStorage，不会发往除 api.github.com 以外的任何地方。Fine-grained token 只需该仓库的 <b>Contents: Read and write</b>。</div>
        </div>

        <div class="row" style="margin-top:16px">
          <button class="btn primary" id="saveGh">保存并连接</button>
          <button class="btn" id="testGh">测试连接</button>
          <button class="btn danger" id="clearCred">清除本机凭据</button>
          <span class="spacer"></span>
          <span style="font-size:11.5px;color:var(--text-faint)" id="ghStatus"></span>
        </div>
        <div class="hint" style="margin-top:10px">
          在公共电脑上用过之后，点「清除本机凭据」把 Token 从这台浏览器里抹掉。Token 只存在本机 localStorage，不会上传。
        </div>
      </div>

      <div class="sec">
        <h2>AI 接口（可选）</h2>
        <div class="grid2">
          <div class="field"><label>Base URL</label><input id="aiBaseUrl" placeholder="https://openrouter.ai/api/v1" value="${escapeHtml(a.baseUrl)}" /></div>
          <div class="field"><label>Model</label><input id="aiModel" placeholder="deepseek/deepseek-chat-v3" value="${escapeHtml(a.model)}" /></div>
        </div>
        <div class="field">
          <label>API Key ${a.apiKey ? "（已保存，留空则不改动）" : ""}</label>
          <input id="aiKey" type="password" placeholder="${a.apiKey ? "••••••••" : "sk-..."}" />
          <div class="hint">
            本地模式由本地服务转发，任何网关都行。<b>云端模式是浏览器直连</b>，只有放行跨域的网关可用（OpenRouter 支持）。
            不配也能用「复制 Prompt」这条路。
          </div>
        </div>
        <div class="row" style="margin-top:16px">
          <button class="btn primary" id="saveAi">保存 AI 配置</button>
          <span class="spacer"></span>
          <span style="font-size:11.5px;color:var(--text-faint)" id="aiStatus"></span>
        </div>
      </div>

      <div class="sec">
        <h2>快捷键</h2>
        <div class="note" style="border-style:solid">
          <b>双击</b>段落 → 编辑；<kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> 保存，<kbd>Esc</kbd> 取消<br>
          <b>悬停</b>段落 → <b>✦</b>（AI 改写）、↑↓（移动）、＋（插入）、✕（删除）<br>
          表格：点单元格直接改；行尾浮出按钮可增删行、上下移
        </div>
      </div>
    </div>
  `;

  m.querySelectorAll("[data-mode]").forEach((el) => el.addEventListener("click", async () => {
    if (el.disabled) return;
    config.mode = el.dataset.mode;
    saveConfig();
    await boot(true);
  }));

  $("#saveGh").addEventListener("click", async () => {
    config.gh.owner = $("#ghOwner").value.trim();
    config.gh.repo = $("#ghRepo").value.trim();
    config.gh.branch = $("#ghBranch").value.trim() || "main";
    config.gh.subdir = $("#ghSubdir").value.trim();
    const tk = $("#ghToken").value.trim();
    if (tk) config.gh.token = tk;
    saveConfig();
    activeMode = await resolveMode();
    if (activeMode === "github" && !GitHubSource.ready()) {
      $("#ghStatus").textContent = "配置不完整";
      return;
    }
    await boot(true);
    toast("已保存并连接");
  });

  $("#testGh").addEventListener("click", async () => {
    const bak = { ...config.gh };
    config.gh.owner = $("#ghOwner").value.trim() || config.gh.owner;
    config.gh.repo = $("#ghRepo").value.trim() || config.gh.repo;
    config.gh.branch = $("#ghBranch").value.trim() || "main";
    config.gh.subdir = $("#ghSubdir").value.trim();
    const tk = $("#ghToken").value.trim();
    if (tk) config.gh.token = tk;
    $("#ghStatus").innerHTML = '<span class="spinner"></span> 连接中…';
    try {
      const p = await GitHubSource.project();
      $("#ghStatus").textContent = `连接正常：${p.fileCount} 个文件、${p.foreshadows.length} 条伏笔`;
    } catch (err) {
      $("#ghStatus").textContent = "";
      toast(`连接失败：${err.message}`, true);
    }
    Object.assign(config.gh, bak);
    saveConfig();
  });

  $("#clearCred").addEventListener("click", () => {
    if (!confirm("清除本机保存的 GitHub Token 与 AI Key？清除后需要重新填写。")) return;
    config.gh.token = "";
    config.ai.apiKey = "";
    saveConfig();
    toast("已清除本机凭据");
    renderSettings();
  });

  $("#saveAi").addEventListener("click", async () => {
    const payload = {
      baseUrl: $("#aiBaseUrl").value.trim(),
      model: $("#aiModel").value.trim(),
      apiKey: $("#aiKey").value.trim(),
    };
    if (activeMode === "local") {
      try {
        state.aiConfig = await LocalSource.saveAiConfig(payload);
        toast("AI 配置已保存");
        $("#aiStatus").textContent = state.aiConfig.hasKey ? "已就绪" : "未配置 key";
      } catch (err) {
        toast(`保存失败：${err.message}`, true);
      }
    } else {
      state.aiConfig = await GitHubSource.saveAiConfig(payload);
      toast("AI 配置已保存到本机浏览器");
      $("#aiStatus").textContent = state.aiConfig.hasKey ? "已就绪" : "未配置 key";
    }
  });
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function setTab(view) {
  document.querySelectorAll(".tab[data-view]").forEach((el) => el.classList.toggle("on", el.dataset.view === view));
  if (view === "dash") $("#crumb").textContent = "概览";
  if (view === "settings") $("#crumb").textContent = "设置";
}

async function switchView(view) {
  state.view = view;
  setTab(view);
  if (view === "dash") renderDash();
  else if (view === "doc") {
    if (state.currentPath) renderDoc();
    else $("#main").innerHTML = `<div class="empty">从左侧选一个文件开始编辑</div>`;
  } else if (view === "settings") await renderSettings();
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot(silent = false) {
  try {
    activeMode = await resolveMode();
    state.project = await source().project();
    state.aiConfig = await source().aiConfig().catch(() => ({}));
    renderChrome();
    renderTree();
    renderDash();
    setTab("dash");
    if (!silent) $("#crumb").textContent = "概览";
  } catch (err) {
    $("#main").innerHTML = `<div class="empty">
      加载失败：${escapeHtml(err.message)}<br><br>
      ${activeMode === "github" ? "请到「设置」检查 GitHub 仓库配置与 Token。" : "请确认本地服务已启动。"}
      <br><br><button class="qbtn" onclick="switchView('settings')">打开设置</button>
    </div>`;
  }
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && $("#aiPanel").classList.contains("open")) closeAiPanel();
});

document.querySelectorAll(".tab[data-view]").forEach((el) => el.addEventListener("click", () => switchView(el.dataset.view)));
$("#aiToggle").addEventListener("click", () => {
  const panel = $("#aiPanel");
  if (panel.classList.contains("open")) closeAiPanel();
  else { renderAiPanel(); panel.classList.add("open"); }
});
$("#aiClose").addEventListener("click", closeAiPanel);
$("#brand").addEventListener("click", () => switchView("dash"));

boot();
