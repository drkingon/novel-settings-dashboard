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
  aiCandidateLabels: null,
  aiBusy: false,
  aiStatus: "",
  usePipeline: false,
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

/**
 * 流式生成（POST /api/ai/raw/stream，SSE）。
 * 服务端策略：只要模型还在持续吐字就不算超时（首字给 5 分钟、之后连续 3 分钟无新字才判卡死），
 * 因此长文生成不会像旧的固定 240s 墙钟那样被误判失败；
 * 真的中断了也会把已生成的内容回传（done.partial=true），不会整段丢稿。
 * @returns {Promise<{text:string, chars?:number, elapsed?:number, partial?:boolean, note?:string, resultPath?:string}>}
 */
async function streamRawGenerate({ prompt, temperature = 0.85, max_tokens = 4096, path = "", onText, onStatus, onTick, onDone }) {
  // 在线版（GitHub 模式）直接从静态页打开，没有本地服务端；
  // 本地服务没起来或版本较旧时也一样。这些情况退回「浏览器直连模型」，
  // 虽然拿不到逐字流式，但功能不会直接报 404 挂掉。
  const directCall = async (why) => {
    if (onStatus) onStatus(why);
    const { candidates } = await source().aiRewrite({
      text: prompt,
      instruction: "按上面的完整要求执行并只输出成果本身。",
      context: {},
      count: 1,
    });
    const text = (candidates && candidates[0]) || "";
    if (onText) onText(text, text);
    const res = { text, chars: text.length, partial: false, fallback: true };
    if (onDone) onDone(res, text);
    return res;
  };
  if (activeMode === "github") return await directCall("在线版：改用浏览器直连模型（无逐字进度）");

  let resp;
  try {
    resp = await fetch("/api/ai/raw/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, temperature, max_tokens, ...(path ? { path } : {}) }),
    });
  } catch (err) {
    return await directCall(`本地服务不可用（${err.message}），改用浏览器直连模型`);
  }
  if (resp.status === 404) return await directCall("本地服务版本较旧（缺少 /api/ai/raw/stream），改用浏览器直连模型");
  if (!resp.ok || !resp.body) {
    const d = await resp.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "", outcome = null, failed = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
      if (ev.type === "status") { if (onStatus) onStatus(ev.data); }
      else if (ev.type === "text") { acc += ev.data; if (onText) onText(ev.data, acc); }
      else if (ev.type === "tick") { if (onTick) onTick(ev.data || {}); }
      else if (ev.type === "done") { outcome = ev.data || {}; }
      else if (ev.type === "error") { failed = (ev.data && ev.data.note) || "未知错误"; }
    }
  }
  if (failed) throw new Error(failed);
  const text = (outcome && outcome.content) || acc;
  if (onDone) onDone(outcome || {}, text);
  return { text, ...(outcome || {}) };
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

/** 在内容里按"原文"定位块的新行号（并发编辑后重新定位用） */
function locateByAnchor(content, anchorText) {
  if (!anchorText) return null;
  const lines = content.split("\n");
  const needle = String(anchorText).split("\n");
  if (!needle.length || !needle[0]) return null;
  outer:
  for (let i = 0; i + needle.length <= lines.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (lines[i + j] !== needle[j]) continue outer;
    }
    return { start: i, end: i + needle.length - 1 };
  }
  return null;
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
    return { baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey, keyMask: c.keyMask, autoUnload: c.autoUnload };
  },
  async saveAiConfig(cfg) {
    const c = await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    });
    return { baseUrl: c.baseUrl, model: c.model, hasKey: c.hasKey, keyMask: c.keyMask, autoUnload: c.autoUnload };
  },
  async aiRewrite(payload) { return api("/api/ai/rewrite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); },
  async aiPipeline(payload) { return api("/api/ai/pipeline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }); },
  async writeFile(path, content) {
    await api("/api/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    return { path };
  },
  async listModels(opts) {
    return api("/api/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts || {}),
    });
  },
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
    if (!res.ok) {
      const err = new Error(data.message ? `GitHub: ${data.message}` : `GitHub ${res.status}`);
      err.status = res.status;
      throw err;
    }
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
  /**
   * 保存：读-改-写，带乐观锁。
   * 若期间被别处改过（409），自动重读、用 anchor（原文）重新定位、再试一次。
   * 这是借鉴股票工作台「409 重试路径」的做法：不让并发编辑静默丢改动。
   */
  async patch(path, start, end, newText, anchor) {
    let attempt = 0;
    for (;;) {
      const { content, sha } = await this.read(path);
      let s = start;
      let e = end;
      if (attempt > 0 && anchor) {
        const loc = locateByAnchor(content, anchor);
        if (loc) { s = loc.start; e = loc.end; }
      }
      const next = applyLinePatch(content, s, e, newText);
      try {
        await this.write(path, next, `编辑 ${path.split("/").pop()} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, sha);
        return { content: next, retried: attempt > 0 };
      } catch (err) {
        if (err.status === 409 && attempt < 2) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        if (err.status === 409) {
          throw new Error("这个文件刚被别处改过（可能是另一台设备），已自动重试仍未成功。请「重新载入」后再改。");
        }
        throw err;
      }
    }
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
    return {
      baseUrl: a.baseUrl, model: a.model,
      hasKey: Boolean(a.apiKey),
      keyMask: a.apiKey ? `${a.apiKey.slice(0, 4)}…${a.apiKey.slice(-4)}` : "",
      isLocal: isLocalUrl(a.baseUrl),
      roles: a.roles || {},
    };
  },
  async saveAiConfig(cfg) {
    config.ai.baseUrl = cfg.baseUrl ?? config.ai.baseUrl;
    config.ai.model = cfg.model ?? config.ai.model;
    if (cfg.apiKey) config.ai.apiKey = cfg.apiKey;
    if (cfg.roles && typeof cfg.roles === "object") config.ai.roles = cfg.roles;
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
        max_tokens: 4096,
        // 本地推理机（llama.cpp 等）需关闭思考模式，否则正文为空；云端网关不认该参数，不发送
        ...(isLocalUrl(baseUrl) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
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
  /** 云端模式：浏览器直连两阶段流水线（要求两个角色都配好 Key 且网关放行跨域） */
  async aiPipeline(payload) {
    const roles = config.ai.roles || {};
    const d = roles.draft, c = roles.condense;
    if (!d?.baseUrl || !d?.model || !d?.apiKey) throw new Error("初稿模型未配置（云端直连需 Key）");
    if (!c?.baseUrl || !c?.model || !c?.apiKey) throw new Error("浓缩模型未配置（云端直连需 Key）");
    const draftPrompt = buildDraftPrompt({ instruction: payload.instruction, text: payload.text, context: payload.context });
    const draft = await ghRoleCall(d, draftPrompt, 0.9);
    let finalText = "", condenseError = "";
    try {
      const condPrompt = buildCondensePrompt({ instruction: "", draft, context: payload.context });
      finalText = await ghRoleCall(c, condPrompt, 0.35);
    } catch (e) { condenseError = e.message; }
    if (!finalText) return { draft, final: draft, degraded: true, condenseError };
    return { draft, final: finalText, degraded: false };
  },
  async canDirectAi() {
    return Boolean(config.ai.baseUrl && config.ai.model && config.ai.apiKey);
  },
  /** 云端模式：浏览器直连拉取模型列表（要求网关放行跨域） */
  async listModels(opts) {
    const baseUrl = String(opts?.baseUrl || config.ai.baseUrl || "").trim();
    const apiKey = String(opts?.apiKey || config.ai.apiKey || "").trim();
    if (!baseUrl) throw new Error("缺少 Base URL");
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`${res.status} 拉取模型列表失败（云端直连需网关放行跨域）`);
    const d = await res.json().catch(() => ({}));
    const raw = d?.data || d?.models || [];
    const rich = raw.map((m) => {
      if (typeof m === "string") return { id: m, name: "", ctx: null, price: null };
      const id = m.id || m.name || "";
      if (!id) return null;
      const name = (typeof m.name === "string" && m.name && m.name !== id) ? m.name : "";
      const ctx = Number(m.context_length || m.top_provider?.context_length) || null;
      const p = Number(m.pricing?.prompt);
      const price = Number.isFinite(p) && p > 0 ? p * 1e6 : null;
      return { id, name, ctx, price };
    }).filter(Boolean);
    rich.sort((a, b) => a.id.localeCompare(b.id));
    return {
      models: rich.map((m) => m.id),
      rich,
      local: isLocalUrl(baseUrl),
    };
  },
};

/* ------------------------------------------------------------------ */
/* 数据源路由                                                          */
/* ------------------------------------------------------------------ */

/** 云端模式：浏览器直连调用某个角色的模型 */
async function ghRoleCall(role, prompt, temperature) {
  const res = await fetch(`${role.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${role.apiKey}` },
    body: JSON.stringify({
      model: role.model, temperature,
      max_tokens: 4096,
      // 本地推理机（llama.cpp 等）需关闭思考模式，否则正文为空；云端网关不认该参数，不发送
      ...(isLocalUrl(role.baseUrl) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      messages: [
        { role: "system", content: "你是严谨的中文网文编辑，严格遵守文风禁令，只输出被要求的 Markdown 片段。" },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`模型接口 ${res.status}`);
  const d = await res.json();
  const content = String(d?.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new Error("模型没有返回内容");
  return content;
}

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

/** 初稿阶段 prompt（浏览器端，供云端直连流水线使用） */
function buildDraftPrompt({ instruction, text, context, note }) {
  const c = context || {};
  const L = [];
  L.push("你是长篇网文的写手。请基于下面的要点 / 大纲 / 设定，写出一段完整、有画面感的初稿。");
  L.push("", "## 项目", c.book ? `《${c.book}》` : "（未提供书名）");
  if (c.positioning) L.push("核心定位（节选）：", c.positioning.slice(0, 900));
  if (c.filePath) { L.push("", "## 位置", `文件：${c.filePath}`); if (c.headingPath) L.push(`章节：${c.headingPath}`); }
  if (c.before) L.push("", "## 上文（仅供理解语境，不要改写）", c.before.slice(-1500));
  L.push("", "## 写作要点 / 待展开内容", text);
  if (note) L.push("", "## 额外要求", note);
  L.push("", "## 初稿要求", instruction || "充分展开情节，写出具体动作、对话、环境细节与人物心理；保持与上文设定一致；先求完整、有料，不必过度精简。");
  L.push("", "## 硬约束");
  L.push("- 只输出正文本身，不要任何解释、前言、代码围栏、标题");
  L.push("- 与既有设定严格一致，不要引入新设定、新名字、新数值");
  L.push("- 遵守以下文风禁令（违反即不合格）：", STYLE_RULES);
  return L.join("\n");
}

/** 浓缩阶段 prompt（浏览器端，供云端直连流水线使用） */
function buildCondensePrompt({ instruction, draft, context, note }) {
  const c = context || {};
  const L = [];
  L.push("你是资深网文编辑。下面是一段初稿，请把它浓缩、润色成最终稿。");
  L.push("", "## 项目", c.book ? `《${c.book}》` : "（未提供书名）");
  if (c.positioning) L.push("核心定位（节选）：", c.positioning.slice(0, 600));
  if (c.after) L.push("", "## 下文（仅供理解语境）", c.after.slice(0, 600));
  L.push("", "## 初稿", "```markdown", draft, "```");
  if (note) L.push("", "## 浓缩重点", note);
  L.push("", "## 浓缩要求", instruction || "保留全部关键情节、设定、人物动机与细节描写，输出成连贯的叙事正文；只去掉重复、口头禅和纯粹水词；保持原有的画面感、对话与人物语气，让节奏更紧凑、语言更克制有力。不要改成提纲、摘要或碎片句式。");
  L.push("", "## 硬约束");
  L.push("- 只输出最终稿本身，不要任何解释、前言、代码围栏、标题");
  L.push("- 不得更改既定设定、人物名字、关键数值");
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
        const isDraft = /^正文\//.test(n.path);
        const meta = (isDraft && typeof n.chars === "number")
          ? `${n.chars} 字`
          : (n.size ? `${Math.max(1, Math.round(n.size / 1024))}k` : "");
        html.push(`<div class="item${on}" data-path="${escapeHtml(n.path)}" style="padding-left:${10 + depth * 10}px">
          <span class="mark"></span>
          <span style="overflow:hidden;text-overflow:ellipsis">${fileIcon(n.name)} ${escapeHtml(n.name)}</span>
          <span class="meta">${meta}</span>
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
  const docChars = (state.content || "").replace(/\s/g, "").length;
  const html = [`<div class="doc">
    <div class="doc-head">
      <span class="p">${escapeHtml(state.currentPath)}</span>
      <span class="act">
        <span style="font-size:11px;color:var(--text-faint)">${state.blocks.length} 块 · <b style="color:var(--accent)">${docChars}</b> 字</span>
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

async function patchLines(startLine, endLine, newText, anchor) {
  const data = await source().patch(state.currentPath, startLine, endLine, newText, anchor);
  state.content = data.content;
  state.blocks = parseBlocks(data.content);
  state.scrollTop = $("#main").scrollTop;
  renderDoc();
  $("#crumb").innerHTML = `<b>${escapeHtml(state.currentPath)}</b> · ${state.blocks.length} 块`;
  refreshProjectQuiet();
  if (data.retried) toast("文件刚被别处改过，已自动重新定位并保存");
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
      await patchLines(b.start, b.bodyEnd, val, raw);
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
  state.aiCandidateLabels = null;
  state.aiStatus = "";
  state.usePipeline = pipelineReady();
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
  const labels = state.aiCandidateLabels || state.aiCandidates.map((_, i) => `候选 ${i + 1}`);
  const cands = state.aiCandidates.map((c, i) => `
    <div class="cand">
      <div class="ch">
        <span class="n">${escapeHtml(labels[i] || `候选 ${i + 1}`)}</span><span class="sp"></span>
        <button data-copy="${i}">复制</button>
        <button class="pri" data-apply="${i}">替换原文</button>
      </div>
      <div class="cb">${escapeHtml(c)}</div>
    </div>`).join("");

  const ready = aiReady() || pipelineReady();
  const pipe = pipelineReady();
  const hintLocal = `已配置：<b>${escapeHtml(state.aiConfig?.model || config.ai.model || "")}</b>${isLocalUrl(state.aiConfig?.baseUrl || config.ai.baseUrl) ? "（本地端点）" : ""}，可直接在界面内生成。`;
  const hintPipe = `已配置双模型（初稿 + 浓缩），勾选下方「流水线」可一段过两道：先由初稿模型展开，再由浓缩模型收口。`;
  const hintNone = activeMode === "github"
    ? `云端模式：浏览器直连需要网关放行跨域（OpenRouter、或给 Ollama 设 OLLAMA_ORIGINS=*）；否则用「复制 Prompt」把提示词贴到对话里让 Agent 改写。`
    : `尚未配置可用模型。到「设置 → AI 接口」选一个预设（本地 Ollama 或云端均可）；也可以一直用「复制 Prompt」。`;

  body.innerHTML = `
    <div class="ai-target">${escapeHtml(t.text.slice(0, 900))}${t.text.length > 900 ? "\n…" : ""}</div>
    <div class="ai-label">改写方向</div>
    <div class="chips" id="presetChips">${presets}</div>
    <div class="ai-label">补充要求（可选）</div>
    <textarea class="ai-input" id="aiInstruction" placeholder="例如：把这段改得更像便利店的真实夜班口吻，别用书面语"></textarea>
    <div class="note">${ready ? (pipe ? hintPipe : hintLocal) : hintNone}</div>
    <div class="row">
      <button class="btn wide" id="copyPrompt">复制 Prompt</button>
      <button class="btn primary wide" id="runAi" ${ready ? "" : "disabled"}>一键生成</button>
    </div>
    <div class="row">
      <label class="switch"><input type="checkbox" id="multiCand"> 出 3 个候选</label>
      ${pipe ? `<label class="switch"><input type="checkbox" id="usePipeline" ${state.usePipeline ? "checked" : ""}> 初稿→浓缩 流水线</label>` : ""}
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
      await patchLines(t.start, t.bodyEnd, state.aiCandidates[Number(el.dataset.apply)], t.text);
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
  const usePipe = Boolean($("#usePipeline")?.checked) && pipelineReady();
  if (usePipe) state.usePipeline = true;
  const count = $("#multiCand")?.checked ? 3 : 1;
  state.aiBusy = true;
  state.aiStatus = usePipe ? "流水线生成中（WebNovel 水版 → Gemma 精简）…" : "生成中…";
  renderAiPanel();
  try {
    if (usePipe) {
      const r = await runPipeline({
        text: t.text,
        instruction: collectInstruction(activePreset),
        context: aiContextPayload(),
      });
      state.aiCandidates = [r.final, r.draft].filter(Boolean);
      state.aiCandidateLabels = r.degraded
        ? ["水版（精简失败，已退回）", "水版"]
        : ["精简版（Gemma 浓缩）", "水版（WebNovel 初稿，参考）"];
      state.aiStatus = r.degraded ? `浓缩失败${r.condenseError ? "：" + r.condenseError : ""}，已退回初稿` : "";
      state.aiBusy = false;
      renderAiPanel();
      toast(r.degraded ? "浓缩模型未返回，已退回初稿" : "流水线生成完成（浓缩稿 + 初稿）");
    } else {
      const { candidates } = await source().aiRewrite({
        text: t.text,
        instruction: collectInstruction(activePreset),
        context: aiContextPayload(),
        count,
      });
      state.aiCandidates = candidates.filter(Boolean);
      state.aiCandidateLabels = null;
      state.aiStatus = "";
      state.aiBusy = false;
      renderAiPanel();
      toast(`生成 ${state.aiCandidates.length} 个候选`);
    }
  } catch (err) {
    state.aiBusy = false;
    state.aiStatus = "";
    renderAiPanel();
    toast(`生成失败：${err.message}`, true);
  }
}

/* ------------------------------------------------------------------ */
/* 写作视图（整合 oh-story 的写作流程）                                  */
/* ------------------------------------------------------------------ */

const SKILL_DIR = "/Users/iikuma/WorkBuddy/写作/skills";
const WORD_RANGE = "2200–2500";

/** 从章级大纲解析章节表 */
function parseChaptersFromOutline(md) {
  const lines = String(md).split("\n");
  const chapters = [];
  let night = null;
  let nightTitle = "";
  for (const line of lines) {
    const n = line.match(/^##\s*第\s*(\d+)\s*夜\s*[·・]?\s*(.*?)(?:（|\(|$)/);
    if (n) { night = Number(n[1]); nightTitle = n[2].trim(); continue; }
    const c = line.match(/^\|\s*(\d{1,3})\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/);
    if (!c) continue;
    const no = Number(c[1]);
    if (no < 1 || no > 300) continue;
    const func = c[2].trim();
    if (!func || func.includes("---")) continue;
    const hook = c[4].trim();
    const ht = hook.match(/^(信息差|情绪|预告|对话|悬念)/);
    chapters.push({
      no,
      night,
      nightTitle,
      func,
      beat: c[3].trim(),
      hook,
      hookType: ht ? ht[1] : "",
    });
  }
  return chapters;
}

function flattenTree(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === "file") out.push(n.path);
    else if (n.children) flattenTree(n.children, out);
  }
  return out;
}

function chapterFileName(no, title) {
  const nnn = String(no).padStart(3, "0");
  const clean = String(title || "").replace(/[\\/:*?"<>|\s]/g, "").slice(0, 12) || "章";
  return `正文/第${nnn}章_${clean}.md`;
}

async function loadChapters(force = false) {
  if (state.chapters && !force) return state.chapters;
  const outline = await source().file("大纲/章级大纲.md");
  const list = parseChaptersFromOutline(outline.content);
  const files = flattenTree(state.project?.tree || []);
  for (const ch of list) {
    const nnn = String(ch.no).padStart(3, "0");
    ch.outlinePath = files.find((p) => new RegExp(`^大纲/细纲_第${nnn}章`).test(p)) || null;
    ch.draftPath = files.find((p) => new RegExp(`^正文/第${nnn}章`).test(p)) || null;
    ch.hasOutline = Boolean(ch.outlinePath);
    ch.hasDraft = Boolean(ch.draftPath);
  }
  state.chapters = list;
  return list;
}

async function renderWriting() {
  const m = $("#main");
  m.innerHTML = `<div class="empty">读取大纲…</div>`;
  try {
    const chapters = await loadChapters(true);
    if (!chapters.length) {
      m.innerHTML = `<div class="empty">
        没能从「大纲/章级大纲.md」解析出章节。<br><br>
        请确认该文件里有 <code>| 章号 | 功能 | 关键节拍 | 章末钩子 |</code> 格式的表格。
      </div>`;
      return;
    }
    renderWritingUI();
  } catch (err) {
    m.innerHTML = `<div class="empty">读取失败：${escapeHtml(err.message)}</div>`;
  }
}

function renderWritingUI() {
  const m = $("#main");
  const chapters = state.chapters;
  const done = chapters.filter((c) => c.hasDraft).length;
  const outlined = chapters.filter((c) => c.hasOutline).length;
  const sel = state.selectedChapter;

  const rows = chapters.map((c) => {
    const on = sel === c.no ? " on" : "";
    const flags = [
      c.night ? `<span class="flag night">第${c.night}夜</span>` : "",
      c.hookType ? `<span class="flag hook">${escapeHtml(c.hookType)}</span>` : "",
      c.hasOutline ? `<span class="flag ok">细纲</span>` : `<span class="flag todo">无细纲</span>`,
      c.hasDraft ? `<span class="flag ok">正文</span>` : `<span class="flag todo">未写</span>`,
    ].join("");
    return `<div class="ch${on}" data-ch="${c.no}">
      <div class="no">${String(c.no).padStart(2, "0")}</div>
      <div class="body">
        <div class="title">${escapeHtml(c.func || "（未命名）")}</div>
        <div class="beat">${escapeHtml(c.beat || "")}</div>
      </div>
      <div class="flags">${flags}</div>
      <button class="ch-create" data-create="${c.no}" title="打开创作台">创作 ›</button>
    </div>`;
  }).join("");

  const detail = sel ? renderChapterDetail(chapters.find((c) => c.no === sel)) : "";

  m.innerHTML = `
    <div class="writing">
      <div class="w-head">
        <h1>写作</h1>
        <span class="sub">${escapeHtml(state.project?.book || "")}</span>
      </div>
      <p class="w-lede">每章一个单元：出细纲 → 写正文 → 去 AI 味 → 审查。点章节展开操作，Prompt 会把大纲节拍、设定、伏笔、角色知识状态、文风禁令一并打包。</p>

      <div class="w-stats">
        <span class="w-stat"><b>${chapters.length}</b>章规划</span>
        <span class="w-stat"><b>${outlined}</b>章有细纲</span>
        <span class="w-stat"><b>${done}</b>章已写正文</span>
      </div>

      <div class="w-note">
        <b>创作流程</b>：点任一章的 <b>「创作 ›」</b>（或展开后点「创作」）→ 右侧滑出<b>创作台</b>，按 oh-story 流程走：①出细纲 → ②写正文 → <b>③扩写</b>（不足字数时分块扩写）→ ④去 AI 味 → ⑤审查。<br>
        创作台内可<b>粘贴我给你的 prompt</b>，也可点「打包」自动生成；执行方式：<b>生成本章</b>（当前配置模型直出）、<b>流水线</b>（水版 → 精简）、<b>交给助手</b>（弹出菜单：立即执行＝API 流式实时出字并落盘 / 加入队列＝整点由助手执行）。结果落在下方编辑区，<b>可直接手改</b>，⌘/Ctrl+S 保存。
      </div>

      <div class="ch-list">${rows}</div>
      ${detail}
    </div>
  `;

  m.querySelectorAll(".ch").forEach((el) => {
    el.addEventListener("click", async () => {
      const no = Number(el.dataset.ch);
      state.selectedChapter = state.selectedChapter === no ? null : no;
      renderWritingUI();
      if (state.selectedChapter) {
        const d = m.querySelector(".ch-detail");
        if (d) d.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  });
  // 行内「创作」按钮：直接开右侧创作台，不展开详情
  m.querySelectorAll("[data-create]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const ch = state.chapters.find((c) => c.no === Number(btn.dataset.create));
      if (ch) openWritingDrawer(ch, "draft");
    });
  });
  bindChapterDetail();
}

function renderChapterDetail(ch) {
  if (!ch) return "";
  const nnn = String(ch.no).padStart(3, "0");
  const draftName = ch.draftPath ? ch.draftPath.split("/").pop() : chapterFileName(ch.no, ch.func).split("/").pop();
  return `
    <div class="ch-detail">
      <div class="dh">
        <span class="t">第 ${ch.no} 章 · ${escapeHtml(ch.func || "")}</span>
        <span class="sp"></span>
        <span class="flag night">${ch.night ? `第 ${ch.night} 夜 · ${escapeHtml(ch.nightTitle || "")}` : "—"}</span>
      </div>
      <div class="db">
        <div class="rowline"><span class="k">关键节拍</span><span class="v">${escapeHtml(ch.beat || "—")}</span></div>
        <div class="rowline"><span class="k">章末钩子</span><span class="v">${escapeHtml(ch.hook || "—")}</span></div>
        <div class="rowline"><span class="k">细纲</span><span class="v">${ch.hasOutline ? `<b>${escapeHtml(ch.outlinePath)}</b>` : "还没出（先跑「出本章细纲」）"}</span></div>
        <div class="rowline"><span class="k">正文</span><span class="v">${ch.hasDraft ? `<b>${escapeHtml(ch.draftPath)}</b>` : `还没写（将写入 ${escapeHtml(draftName)}）`}</span></div>
      </div>
      <div class="ops">
        <button class="op primary" data-op="create"><span>创作 ›</span><span class="k">打开右侧创作台</span></button>
        <button class="op" data-op="copy-outline"><span>出本章细纲</span><span class="k">复制 Prompt</span></button>
        <button class="op" data-op="copy-draft"><span>写本章正文</span><span class="k">复制 Prompt</span></button>
        <button class="op" data-op="copy-deslop"><span>去 AI 味</span><span class="k">复制 Prompt</span></button>
        <button class="op" data-op="copy-review"><span>审查本章</span><span class="k">复制 Prompt</span></button>
        <span style="flex:1"></span>
        <button class="op" data-op="gen-outline" data-gen="outline"><span>一键出细纲</span></button>
        <button class="op" data-op="open-draft"><span>打开正文</span></button>
      </div>
      <div id="draftBox"></div>
    </div>
  `;
}

/* ---------------------------------------------------------------- */
/* 创作抽屉（右侧）                                                    */
/* ---------------------------------------------------------------- */

const WRITING_STEPS = [
  { key: "outline", n: "①", name: "出细纲" },
  { key: "draft", n: "②", name: "写正文" },
  { key: "expand", n: "③", name: "扩写" },
  { key: "deslop", n: "④", name: "去 AI 味" },
  { key: "review", n: "⑤", name: "审查" },
];

/** 各任务的编辑器标题 */
function taskLabel(t) {
  if (t === "outline") return "细纲";
  if (t === "review") return "审查报告";
  if (t === "deslop") return "改稿";
  if (t === "expand") return "正文（扩写）";
  return "正文";
}

/** 各任务的默认落盘路径 */
function drawerSavePath(ch, task) {
  const nnn = String(ch.no).padStart(3, "0");
  if (task === "outline") return `大纲/细纲_第${nnn}章.md`;
  if (task === "review") return `追踪/审查_第${nnn}章.md`;
  return ch.draftPath || chapterFileName(ch.no, ch.func);
}

/** 打开某章的创作抽屉 */
async function openWritingDrawer(ch, task = "draft") {
  document.getElementById("wdDrawer")?.remove();
  const drawer = document.createElement("aside");
  drawer.id = "wdDrawer";
  drawer.className = "wd";
  drawer.innerHTML = `
    <div class="wd-head">
      <div class="wd-crumb">
        <span class="bk">${escapeHtml(state.project?.book || "（未载入）")}</span>
        <span class="sep">›</span>
        <span class="bk">${ch.night ? `第 ${ch.night} 夜 · ${escapeHtml(ch.nightTitle || "")}` : "未分夜"}</span>
        <span class="sep">›</span>
        <span class="bk cur">第 ${ch.no} 章</span>
      </div>
      <div class="wd-title">
        <span class="no">${String(ch.no).padStart(2, "0")}</span>
        <h2>${escapeHtml(ch.func || "（未命名章节）")}</h2>
        <span class="wd-badges">
          <span class="flag ${ch.hasOutline ? "ok" : "todo"}" id="wdBadgeOutline">${ch.hasOutline ? "有细纲" : "无细纲"}</span>
          <span class="flag ${ch.hasDraft ? "ok" : "todo"}" id="wdBadgeDraft">${ch.hasDraft ? "有正文" : "未写正文"}</span>
        </span>
        <span class="sp"></span>
        <button class="wd-x" id="wdClose" title="关闭（Esc）">✕</button>
      </div>
      <div class="wd-meta">
        <div class="mi"><span class="k">关键节拍</span><span class="v">${escapeHtml(ch.beat || "—")}</span></div>
        <div class="mi"><span class="k">章末钩子</span><span class="v">${escapeHtml((ch.hookType ? `[${ch.hookType}] ` : "") + (ch.hook || "—"))}</span></div>
      </div>
    </div>

    <nav class="wd-steps" id="wdSteps">
      ${WRITING_STEPS.map((s) => `<button class="wstep${s.key === task ? " on" : ""}" data-task="${s.key}"><b>${s.n}</b>${s.name}</button>`).join("")}
    </nav>

    <section class="wd-sec">
      <div class="wd-sh">
        <span class="lbl">Prompt</span>
        <span class="hint">可粘贴我给你的 prompt；或点「打包」按本章上下文自动生成</span>
        <span class="sp"></span>
        <button class="mini" id="wdPack">打包</button>
        <button class="mini" id="wdCopy">复制</button>
      </div>
      <textarea id="wdPrompt" class="wd-prompt" spellcheck="false" placeholder="把 prompt 粘贴到这里，或点「打包」生成…"></textarea>
    </section>

    <section class="wd-sec">
      <div class="wd-sh">
        <span class="lbl">AI 执行</span>
        <span class="hint" id="wdRunHint">本地模型（11440）</span>
        <span class="sp"></span>
        <button class="btn primary" id="wdRun" ${aiReady() ? "" : "disabled"}>生成本章</button>
        <button class="btn" id="wdPipe" ${aiReady() && task === "draft" ? "" : "disabled"}>流水线（水版→精简）</button>
        ${activeMode === "github" ? "" : `<button class="btn" id="wdAgent">交给助手 ▾</button>
        <div class="wd-pop" id="wdAgentPop" hidden>
          <div class="wd-pop-t">立即执行（API 流式）</div>
          <div class="wd-pop-hint" id="wdApiHint">检测模型配置…</div>
          <div class="wd-pop-btns">
            <button class="btn primary" id="wdStreamNow">立即执行（流式）</button>
          </div>
          <div class="wd-pop-sep">或交给队列（整点扫描）</div>
          <label class="wd-pop-i"><input type="radio" name="wdm" value="default">默认（跟随 WorkBuddy 当前模型）</label>
          <label class="wd-pop-i"><input type="radio" name="wdm" value="lite">快速（lite，省而快）</label>
          <label class="wd-pop-i"><input type="radio" name="wdm" value="reasoning">深度推理（reasoning，适合正文）</label>
          <div class="wd-pop-btns">
            <button class="btn" id="wdQueueIt">加入队列（整点）</button>
          </div>
          <div class="wd-pop-foot" id="wdCliHint">检测本机 CLI 执行器…</div>
        </div>`}
      </div>
    </section>

    <section class="wd-sec" id="wdExpandBox" ${task === "expand" ? "" : "hidden"}>
      <div class="wd-sh">
        <span class="lbl">扩写</span>
        <span class="hint">按块扩写编辑区里的文本，情节不变、只做展开</span>
        <span class="sp"></span>
        <span class="hint">目标</span>
        <input id="wdExpandTarget" class="wd-num" type="number" min="300" max="30000" step="100" value="${Number(config.expandTarget) || 4000}" title="目标字数（非空白字符）" />
        <span class="hint">字</span>
        <button class="btn primary" id="wdExpandRun">开始扩写（流式）</button>
      </div>
    </section>

    <section class="wd-sec" id="wdRunBox" hidden>
      <div class="wd-sh"><span class="lbl">执行进度</span><span class="hint" id="wdRunState">…</span><span class="sp"></span><span class="wc" id="wdRunChars">0 字</span></div>
      <div class="wd-runlog" id="wdRunLog"></div>
    </section>

    <section class="wd-sec grow">
      <div class="wd-sh">
        <span class="lbl" id="wdEdLabel">${taskLabel(task)}</span>
        <span class="hint">直接编辑；⌘/Ctrl+S 保存</span>
        <span class="sp"></span>
        <span class="wc" id="wdCount">0 字</span>
        <button class="mini" id="wdRestore" hidden>恢复上次内容</button>
        <button class="mini" id="wdLoad">载入已存正文</button>
        <button class="mini" id="wdClear">清空</button>
      </div>
      <textarea id="wdEditor" class="wd-editor" spellcheck="false" placeholder="生成结果会出现在这里，也可以直接手写…"></textarea>
    </section>

    <section class="wd-sec" id="wdQueueBox">
      <div class="wd-sh"><span class="lbl">任务队列</span><span class="hint">整点扫描 · 约 8 秒刷新</span><span class="sp"></span><button class="mini" id="wdQueueRefresh">刷新</button></div>
      <div class="wd-queue" id="wdQueueList"></div>
    </section>

    <footer class="wd-foot">
      <input id="wdPath" class="wd-path" value="${escapeHtml(drawerSavePath(ch, task))}" onfocus="this.select()" />
      <button class="btn primary" id="wdSave">保存</button>
      <span class="wd-status" id="wdStatus"></span>
    </footer>
  `;
  document.body.appendChild(drawer);

  const q = (s) => drawer.querySelector(s);
  const promptEl = q("#wdPrompt");
  const editorEl = q("#wdEditor");
  const statusEl = q("#wdStatus");
  const countEl = q("#wdCount");
  let curTask = task;
  let genSnapshot = null;          // 生成前编辑器快照，用于「恢复上次内容」
  const taskContent = {};          // 各步骤编辑器内容缓存（切换步骤不丢）
  let lastSaved = "";              // 上次落盘/载入的内容，用于未保存判断

  const setStatus = (t, isErr) => { statusEl.textContent = t || ""; statusEl.classList.toggle("err", Boolean(isErr)); };
  const updCount = () => { const n = editorEl.value.replace(/\s/g, "").length; countEl.textContent = `${n} 字`; };

  // 按当前任务载入对应文件内容（不再无条件把正文灌进编辑器）
  const loadEditorForTask = async (t) => {
    const path = drawerSavePath(ch, t);
    let content = "";
    try {
      const f = await source().file(path);
      if (f?.content) content = f.content;
    } catch { /* 读取失败不阻塞 */ }
    if (!content && taskContent[t]) content = taskContent[t];
    editorEl.value = content;
    lastSaved = content;
    updCount();
    return content;
  };
  const loaded = await loadEditorForTask(curTask);
  if (loaded) setStatus(`已载入 ${drawerSavePath(ch, curTask)}`);

  const pack = async () => {
    try {
      setStatus("正在打包上下文…");
      const p = await buildChapterPrompt(ch, curTask, { local: true });
      promptEl.value = p;
      setStatus(`已打包（${p.length} 字）`);
    } catch (err) {
      setStatus(`打包失败：${err.message}`, true);
    }
  };

  const switchTask = async (t) => {
    if (t === curTask) return;
    taskContent[curTask] = editorEl.value; // 缓存当前步骤内容
    curTask = t;
    drawer.querySelectorAll(".wstep").forEach((b) => b.classList.toggle("on", b.dataset.task === t));
    q("#wdPipe").disabled = !(aiReady() && t === "draft");
    q("#wdPath").value = drawerSavePath(ch, t);
    promptEl.value = "";
    setStatus("");
    const expandBoxEl = q("#wdExpandBox");
    if (expandBoxEl) expandBoxEl.hidden = t !== "expand";
    const edLabelEl = q("#wdEdLabel");
    if (edLabelEl) edLabelEl.textContent = taskLabel(t);
    await loadEditorForTask(t);
  };

  const run = async (mode) => {
    const p = promptEl.value.trim();
    if (!p) { setStatus("先粘贴或打包一个 prompt", true); return; }
    const btn = mode === "pipe" ? q("#wdPipe") : q("#wdRun");
    const runBox = q("#wdRunBox"), runLog = q("#wdRunLog"), runState = q("#wdRunState"), runChars = q("#wdRunChars");
    const log = (t) => {
      if (!runLog) return;
      const d = document.createElement("div");
      d.className = "wd-runline"; d.textContent = t;
      runLog.appendChild(d);
      while (runLog.children.length > 60) runLog.firstChild.remove();
      runLog.scrollTop = runLog.scrollHeight;
    };
    const before = editorEl.value;   // 生成前内容：用于快照保护 + 流式期间拼接展示
    if (before.trim()) { genSnapshot = before; q("#wdRestore").hidden = false; }
    btn.disabled = true;
    if (runBox) { runBox.hidden = false; if (runLog) runLog.innerHTML = ""; }
    if (runChars) runChars.textContent = "0 字";
    try {
      let out = "", partialNote = "";
      if (mode === "pipe") {
        if (runState) runState.textContent = "流水线：WebNovel 写水版 → Gemma 精简…";
        setStatus("流水线：WebNovel 写水版 → Gemma 精简…");
        const r = await runPipeline({ text: p, instruction: "本阶段是水版，请充分铺开、先求完整有料。", context: {} });
        out = r.final || r.draft || "";
        if (r.draft) promptEl.dataset.water = r.draft;
      } else {
        // 流式：边生成边填编辑器，看得见活着；中断也保住已生成的字
        if (runState) runState.textContent = "流式生成中（持续吐字即正常，不再按总时长判超时）…";
        setStatus("流式生成中…");
        let lastPaint = 0;
        const r = await streamRawGenerate({
          prompt: p,
          temperature: 0.85,
          max_tokens: 4096,
          path: q("#wdPath") ? q("#wdPath").value.trim() : drawerSavePath(ch, curTask),
          onText: (_d, acc) => {
            editorEl.value = before.trim() ? `${before}\n\n${acc}` : acc;
            updCount();
            const now = Date.now();
            if (now - lastPaint > 400) { lastPaint = now; if (runChars) runChars.textContent = `${acc.length} 字`; }
          },
          onStatus: (s) => { log(`▸ ${s}`); if (runState) runState.textContent = s; },
          onTick: (t) => { if (runChars) runChars.textContent = `${(t && t.chars) || 0} 字 · ${(t && t.elapsed) || 0}s`; },
        });
        out = r.text || "";
        if (r.partial) { partialNote = r.note || "生成被中断，已保留部分内容"; log(`⚠ ${partialNote}`); }
      }
      if (!out) throw new Error("模型返回空内容");
      editorEl.value = out;   // 流式期间已实时填充，这里统一收口
      updCount();
      if (runChars) runChars.textContent = `${out.length} 字`;
      if (partialNote) {
        if (runState) runState.textContent = `已保留 ${out.length} 字（生成中断）`;
        setStatus(`生成中断，已保留 ${out.length} 字；可直接编辑或重试`, true);
        toast(`生成中断，已保留 ${out.length} 字`, true);
      } else {
        if (runState) runState.textContent = `完成（${out.length} 字）`;
        setStatus(`生成完成（${out.length} 字）；原内容可点「恢复上次内容」还原`);
        toast("已生成，可直接编辑后保存");
      }
    } catch (err) {
      if (runState) runState.textContent = `失败：${err.message}`;
      log(`✗ ${err.message}`);
      setStatus(`失败：${err.message}`, true);
      toast(`生成失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  };

  const esc = (e) => { if (e.key === "Escape" && document.body.contains(drawer)) close(); };
  const close = () => {
    if (editorEl.value.trim() && editorEl.value !== lastSaved) {
      if (!confirm("编辑器有未保存的内容，确定关闭并丢弃？")) return;
    }
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
    document.removeEventListener("keydown", esc);
    drawer.classList.add("out");
    setTimeout(() => drawer.remove(), 180);
  };

  q("#wdClose").addEventListener("click", close);
  drawer.addEventListener("click", (e) => { if (e.target === drawer) close(); });
  document.addEventListener("keydown", esc);
  editorEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); q("#wdSave").click(); }
  });
  editorEl.addEventListener("input", updCount);
  drawer.querySelectorAll(".wstep").forEach((b) => b.addEventListener("click", () => switchTask(b.dataset.task)));
  q("#wdPack").addEventListener("click", pack);
  q("#wdCopy").addEventListener("click", async () => {
    if (!promptEl.value) await pack();
    await navigator.clipboard.writeText(promptEl.value);
    setStatus("已复制 prompt");
  });
  q("#wdRun").addEventListener("click", () => run("single"));
  q("#wdPipe").addEventListener("click", () => run("pipe"));
  const agentBtn = q("#wdAgent");
  let queueTimer = null;
  let refreshQueue = async () => {};   // 队列面板刷新（在 agent 块里赋值，供扩写等其它块复用）
  if (agentBtn) {
    const pop = q("#wdAgentPop");
    const runBox = q("#wdRunBox"), runLog = q("#wdRunLog"), runState = q("#wdRunState"), runChars = q("#wdRunChars");
    const addLog = (t) => {
      if (!runLog) return;
      const d = document.createElement("div");
      d.className = "wd-runline"; d.textContent = t;
      runLog.appendChild(d);
      while (runLog.children.length > 60) runLog.firstChild.remove();
      runLog.scrollTop = runLog.scrollHeight;
    };

    // 队列面板（8 秒轮询，抽屉关闭即停）
    const qList = q("#wdQueueList");
    refreshQueue = async function () {
      if (!qList) return;
      try {
        const d = await api("/api/agent/queue");
        const ico = { pending: "⏳", claimed: "🔄", done: "✅", failed: "❌" };
        const stale = d.items.some((i) => i.status === "pending" && Date.now() - new Date(i.createdAt).getTime() > 75 * 60000);
        qList.innerHTML = (d.items.length ? d.items.map((i) =>
          `<div class="wd-qline"><span class="wd-qico">${ico[i.status] || "·"}</span><span class="wd-qtxt">第${i.chapter}章 ${escapeHtml(i.taskName || i.task || "")} · ${escapeHtml(i.model || "default")} · ${escapeHtml(i.status || "")}${i.resultPath ? ` · ${escapeHtml(i.resultPath)}` : ""}${i.status === "failed" && i.note ? ` · ${escapeHtml(String(i.note).slice(0, 60))}` : ""}</span></div>`
        ).join("") : `<div class="wd-qempty">队列空</div>`)
        + (stale ? `<div class="wd-qstale">⚠ 有任务排队超过 75 分钟：调度器疑似卡点，到对话里说「跑队列任务」可立即执行</div>` : "");
      } catch { qList.innerHTML = `<div class="wd-qempty">队列不可用（本地服务未连）</div>`; }
    };
    q("#wdQueueRefresh").addEventListener("click", () => refreshQueue());
    refreshQueue();
    queueTimer = setInterval(refreshQueue, 8000);

    // 弹窗：模型选择 + 执行器检测
    const radios = pop.querySelectorAll('input[name="wdm"]');
    radios.forEach((r) => {
      r.checked = r.value === (config.agentModel || "default");
      r.addEventListener("change", () => { config.agentModel = r.value; saveConfig(); });
    });
    const cliHint = pop.querySelector("#wdCliHint");
    const apiHint = pop.querySelector("#wdApiHint");
    const streamBtn = pop.querySelector("#wdStreamNow");
    const refreshCli = async () => {
      // 模型配置提示（用「设置」里的主模型）
      const m = state.aiConfig?.model || config.ai.model || "";
      const b = state.aiConfig?.baseUrl || config.ai.baseUrl || "";
      apiHint.innerHTML = m
        ? `使用当前配置的模型：<b>${escapeHtml(m)}</b>${isLocalUrl(b) ? "（本地/局域网端点）" : "（云端）"}；结果会实时写入下方编辑器并自动落盘`
        : `尚未配置模型：到「设置 → AI 模型」填好地址与模型名后再用（也可用「加入队列」交给我）`;
      streamBtn.disabled = !m;
      // 本机 CLI 执行器（需自备，未预装）
      cliHint.textContent = "检测本机 CLI 执行器…";
      try {
        const st = await api("/api/agent/status");
        cliHint.innerHTML = st.cli?.ok
          ? `本机 CLI 执行器：${escapeHtml(st.cli.name || "CLI")} ${escapeHtml(st.cli.version || "")}（可在 config.json 用 agent.args 自定义参数）`
          : `未检测到本机 CLI 执行器（需自备账号，本项目不预装、不消耗第三方额度）`;
      } catch { cliHint.textContent = ""; }
    };
    const togglePop = () => { pop.hidden = !pop.hidden; if (!pop.hidden) { refreshCli(); refreshQueue(); } };
    agentBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePop(); });
    pop.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) pop.hidden = true; });
    const chosenModel = () => pop.querySelector('input[name="wdm"]:checked')?.value || "default";

    // 加入队列
    pop.querySelector("#wdQueueIt").addEventListener("click", async () => {
      try {
        await api("/api/agent/queue", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chapter: ch.no, task: curTask, instruction: "", model: chosenModel() }),
        });
        pop.hidden = true;
        setStatus("已加入队列：整点扫描执行，成稿自动落盘");
        toast("已加入助手队列");
        refreshQueue();
      } catch (err) {
        setStatus(`投递失败：${err.message}`, true);
        toast(`投递失败：${err.message}`, true);
      }
    });

    // 立即执行（API 流式：用「设置」里已配置的模型实时生成）
    pop.querySelector("#wdStreamNow").addEventListener("click", async () => {
      pop.hidden = true;
      runBox.hidden = false; runLog.innerHTML = "";
      runState.textContent = "准备中…"; runChars.textContent = "0 字";
      streamBtn.disabled = true; agentBtn.disabled = true;
      try {
        if (!promptEl.value.trim()) await pack();
        const prompt = promptEl.value.trim();
        if (!prompt) throw new Error("prompt 为空，先在抽屉里点「打包」");
        const targetPath = q("#wdPath").value.trim() || drawerSavePath(ch, curTask);
        const before = editorEl.value;
        runState.textContent = "流式生成中…";
        let acc = "", lastPaint = 0;

        const resp = await fetch("/api/agent/stream", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chapter: ch.no, task: curTask, prompt, path: targetPath }),
        });
        if (!resp.ok || !resp.body) {
          const d = await resp.json().catch(() => ({}));
          throw new Error(d.error || `HTTP ${resp.status}`);
        }
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "", resultPath = "", failed = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.type === "status") { addLog(`▸ ${ev.data}`); runState.textContent = ev.data; }
            else if (ev.type === "log") addLog(`… ${ev.data}`);
            else if (ev.type === "tick") { runChars.textContent = `${ev.data?.chars ?? acc.length} 字 · ${ev.data?.elapsed ?? 0}s`; }
            else if (ev.type === "text") {
              acc += ev.data;
              editorEl.value = (before.trim() ? before + "\n\n" : "") + acc;
              updCount();
              const now = Date.now();
              if (now - lastPaint > 500) { lastPaint = now; runChars.textContent = `${acc.length} 字`; }
            } else if (ev.type === "done") {
              resultPath = ev.data?.resultPath || targetPath;
              runState.textContent = `完成（${ev.data?.elapsed ?? "?"} 秒 · ${ev.data?.chars ?? acc.length} 字）`;
            } else if (ev.type === "error") {
              failed = ev.data?.note || "未知错误";
              runState.textContent = `失败：${failed}`;
            }
          }
        }
        if (failed) throw new Error(failed);
        runChars.textContent = `${acc.length} 字`;
        if (acc) {
          if (before.trim()) { genSnapshot = before; q("#wdRestore").hidden = false; }
          editorEl.value = acc; lastSaved = acc; updCount();
          const isOutline = /细纲/.test(resultPath);
          const dBadge = q("#wdBadgeDraft"), oBadge = q("#wdBadgeOutline");
          if (isOutline) { oBadge.className = "flag ok"; oBadge.textContent = "有细纲"; }
          else { dBadge.className = "flag ok"; dBadge.textContent = "有正文"; }
          q("#wdPath").value = resultPath;
          addLog(`✓ 已落盘：${resultPath}`);
          setStatus(`执行完成：${resultPath}`);
          toast("生成完成，已实时写入并落盘");
        }
        await loadChapters(true);
        renderWritingUI();
      } catch (err) {
        runState.textContent = `失败：${err.message}`;
        addLog(`✗ ${err.message}`);
        toast(`立即执行失败：${err.message}`, true);
      } finally {
        streamBtn.disabled = false; agentBtn.disabled = false;
        refreshQueue();
      }
    });
  }
  q("#wdLoad").addEventListener("click", async () => {
    const path = drawerSavePath(ch, curTask);
    try {
      const f = await source().file(path);
      editorEl.value = f?.content || "";
      lastSaved = editorEl.value;
      updCount();
      setStatus(`已载入 ${path}`);
    } catch (err) { setStatus(`载入失败：${err.message}`, true); }
  });
  q("#wdClear").addEventListener("click", () => {
    if (editorEl.value && !confirm("清空编辑器内容？")) return;
    editorEl.value = ""; updCount();
  });
  q("#wdRestore").addEventListener("click", () => {
    if (genSnapshot == null) return;
    editorEl.value = genSnapshot; updCount();
    q("#wdRestore").hidden = true;
    setStatus("已恢复生成前的内容");
  });
  q("#wdSave").addEventListener("click", async () => {
    const path = q("#wdPath").value.trim();
    if (!path) { setStatus("填保存路径", true); return; }
    if (!editorEl.value.trim()) { setStatus("内容为空", true); return; }
    try {
      if (curTask === "deslop") {
        // 去 AI 味：覆盖前先备份原文件
        try {
          const orig = await source().file(path);
          if (orig?.content) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            await source().writeFile(`${path}.bak-${stamp}.md`, orig.content);
          }
        } catch { /* 原文件不存在则无需备份 */ }
      }
      await source().writeFile(path, editorEl.value);
      lastSaved = editorEl.value;
      // 保存后即时刷新抽屉内章状态徽标
      const isOutline = /细纲/.test(path);
      const dBadge = q("#wdBadgeDraft"), oBadge = q("#wdBadgeOutline");
      if (isOutline) { oBadge.className = "flag ok"; oBadge.textContent = "有细纲"; }
      else { dBadge.className = "flag ok"; dBadge.textContent = "有正文"; }
      setStatus(`已保存 ${path}`);
      toast(`已保存：${path}`);
      await loadChapters(true);
      renderWritingUI();
    } catch (err) {
      setStatus(`保存失败：${err.message}`, true);
      toast(`保存失败：${err.message}`, true);
    }
  });

  // 扩写（分块扩写 + 流式进度）：把编辑区里的文本扩写到目标字数
  const expandRunBtn = q("#wdExpandRun");
  const expandTargetEl = q("#wdExpandTarget");
  if (expandTargetEl) {
    expandTargetEl.addEventListener("change", () => {
      config.expandTarget = Math.max(300, Math.min(30000, Number(expandTargetEl.value) || 4000));
      expandTargetEl.value = config.expandTarget;
      saveConfig();
    });
  }
  if (expandRunBtn) expandRunBtn.addEventListener("click", async () => {
    const before = editorEl.value;
    if (!before.trim()) { setStatus("先载入或生成正文，再扩写", true); return; }
    const target = Math.max(300, Math.min(30000, Number(expandTargetEl?.value) || 4000));
    const targetPath = q("#wdPath").value.trim() || drawerSavePath(ch, curTask);
    runBox.hidden = false; runLog.innerHTML = "";
    runState.textContent = "扩写准备中…";
    runChars.textContent = `${before.replace(/\s/g, "").length} 字 → 目标 ${target}`;
    expandRunBtn.disabled = true;
    try {
      const resp = await fetch("/api/ai/expand", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: before, targetChars: target, path: targetPath, chapter: ch.no, instruction: "" }),
      });
      if (!resp.ok || !resp.body) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "", resultPath = "", failed = "", finalChars = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "status") { addLog(`▸ ${ev.data}`); runState.textContent = ev.data; }
          else if (ev.type === "log") addLog(`… ${ev.data}`);
          else if (ev.type === "chunk") runState.textContent = `第 ${ev.data.pass} 轮 · 第 ${ev.data.index}/${ev.data.total} 块（本块 ${ev.data.cur} → 约 ${ev.data.aim} 字）`;
          else if (ev.type === "text") addLog(`· ${ev.data}`);
          else if (ev.type === "progress") { finalChars = ev.data.chars; runChars.textContent = `${ev.data.chars} 字 / 目标 ${ev.data.target}`; }
          else if (ev.type === "done") {
            resultPath = ev.data?.resultPath || targetPath;
            finalChars = ev.data?.chars || finalChars;
            runState.textContent = `完成：${ev.data?.fromChars} → ${ev.data?.chars} 字（${ev.data?.passes} 轮 · ${ev.data?.elapsed}s）`;
          } else if (ev.type === "error") failed = ev.data?.note || "未知错误";
        }
      }
      if (failed) throw new Error(failed);
      runChars.textContent = `${finalChars} 字`;
      try {
        const f = await source().file(resultPath);
        if (f?.content) {
          if (before.trim()) { genSnapshot = before; q("#wdRestore").hidden = false; }
          editorEl.value = f.content; lastSaved = f.content; updCount();
        }
      } catch {}
      addLog(`✓ 已落盘：${resultPath}（原文件已备份为 .bak-时间戳）`);
      const dBadge = q("#wdBadgeDraft");
      dBadge.className = "flag ok"; dBadge.textContent = "有正文";
      q("#wdPath").value = resultPath;
      setStatus(`扩写完成：${finalChars} 字 · ${resultPath}`);
      toast(`扩写完成（${finalChars} 字）`);
      await loadChapters(true);
      renderWritingUI();
    } catch (err) {
      runState.textContent = `失败：${err.message}`;
      addLog(`✗ ${err.message}`);
      toast(`扩写失败：${err.message}`, true);
    } finally {
      expandRunBtn.disabled = false;
      refreshQueue();
    }
  });

  requestAnimationFrame(() => drawer.classList.add("in"));
  await pack();
  editorEl.focus();
}

function bindChapterDetail() {
  const m = $("#main");
  const ch = state.chapters.find((c) => c.no === state.selectedChapter);
  if (!ch) return;

  const handle = async (op) => {
    if (op === "create") return openWritingDrawer(ch, "draft");
    if (op === "open-draft") {
      if (ch.draftPath) openFile(ch.draftPath);
      else toast("这一章还没写正文");
      return;
    }
    if (op === "copy-outline") return copyChapterPrompt(ch, "outline");
    if (op === "copy-draft") return copyChapterPrompt(ch, "draft");
    if (op === "copy-deslop") return copyChapterPrompt(ch, "deslop");
    if (op === "copy-review") return copyChapterPrompt(ch, "review");
    if (op === "gen-outline") return genChapter(ch, "outline");
  };

  m.querySelectorAll(".op").forEach((btn) => {
    btn.addEventListener("click", () => handle(btn.dataset.op));
  });
}

/* ── 上下文收集 ─────────────────────────────────────────────────── */

async function collectWriteContext(ch) {
  const readOpt = async (p) => {
    try { return (await source().file(p)).content; } catch { return ""; }
  };
  const [positioning, world, foreshadow, knowledge, hooks, rulebook] = await Promise.all([
    readOpt("设定/题材定位.md"),
    readOpt("设定/世界观与技能体系.md"),
    readOpt("主线/表3-伏笔管理.md"),
    readOpt("主线/表2-角色知识状态.md"),
    readOpt("主线/钩子矩阵.md"),
    readOpt("大纲/副本一-规则体系.md"),
  ]);

  let prevTail = "";
  if (ch.no > 1) {
    const nnn = String(ch.no - 1).padStart(3, "0");
    const files = flattenTree(state.project?.tree || []);
    const prev = files.find((p) => new RegExp(`^正文/第${nnn}章`).test(p));
    if (prev) {
      const c = await readOpt(prev);
      prevTail = c.replace(/\s+$/, "").slice(-900);
    }
  }

  // 只取本章相关的伏笔行与钩子行，避免 prompt 过长
  const pickLines = (md, keyword) => String(md).split("\n")
    .filter((l) => l.startsWith("|") && (l.includes(keyword) || keyword === ""))
    .slice(0, 8).join("\n");

  return {
    positioning: String(positioning).slice(0, 1600),
    world: String(world).slice(0, 1600),
    rulebook: String(rulebook).slice(0, 1400),
    foreshadow: ch.no ? pickLines(foreshadow, `第 ${ch.no} `) || String(foreshadow).slice(0, 1400) : "",
    knowledge: String(knowledge).slice(0, 1600),
    hooks: pickLines(hooks, `| ${ch.no} |`) || "",
    prevTail,
  };
}

/* ── Prompt 模板 ────────────────────────────────────────────────── */

const RAW_PACK_TASKS = {
  outline: {
    name: "出本章细纲",
    refs: [
      "story-long-write/references/workflow-setup.md :: Phase 3 大纲搭建 · 中途补纲/扩纲小流程",
      "story-long-write/references/outline-methods.md",
      "story-long-write/references/long-chapter-hooks.md",
    ],
    deliver: (ch, nnn) => `产出写入 \`大纲/细纲_第${nnn}章.md\`（沿用本项目已有细纲的格式；本项目大纲在 \`大纲/章级大纲.md\`）。`,
    extra: "细纲要落到可写：场景、事件顺序、情绪落点、章末钩子、该埋/该收伏笔。默认停在细纲交付，不要顺手写正文。",
  },
  draft: {
    name: "写本章正文",
    refs: [
      "story-long-write/references/workflow-chapter.md :: 单章写作流程 1–13 步 + Phase 5 质量检查",
      "story-long-write/references/long-format.md",
      "story-long-write/references/writing-craft.md",
      "story-long-write/references/long-chapter-quality.md",
      "story-long-write/references/long-chapter-hooks.md",
      "story-long-write/references/long-suspense.md :: 仅悬疑/异常线索章加读",
    ],
    deliver: (ch, nnn) => `正文写入 \`正文/第${nnn}章_章名.md\`（章名自拟，≤12 字，不加书名号）。`,
    extra: "写完同一轮内跑去 AI 味自检，清零 blocking 项后再交。报告：实际字数、命中的禁令与修正、本章钩子落在哪一段。",
  },
  deslop: {
    name: "去 AI 味",
    refs: [
      "story-deslop/SKILL.md",
      "story-long-write/references/anti-ai-writing.md",
    ],
    deliver: () => "原文件覆盖前先备份（`_vN` 版本化），改后写入原文位置。",
    extra: "先跑扫描定位，再按「最毒句式速查 + 禁用词」逐条改写；给出「原句 → 问题 → 改后」判定表，不要只报数字。",
  },
  review: {
    name: "审查本章",
    refs: ["story-review/SKILL.md"],
    deliver: () => "输出审查结论，不要直接改正文（待确认后再改）。",
    extra: "按多视角审查：主线一致性、角色知识状态越界、伏笔埋收、钩子兑现、文风违规、信息增量。",
  },
};

async function buildChapterPrompt(ch, task, opts = {}) {
  const t = RAW_PACK_TASKS[task];
  const nnn = String(ch.no).padStart(3, "0");
  const ctx = await collectWriteContext(ch);
  const book = state.project?.book || "";
  const root = state.project?.root || "";
  // 节选内容里的标题降两级，避免与 prompt 自身层级混淆
  const demote = (s) => String(s || "").replace(/^(#{1,6})\s/gm, (m, h) => `${"#".repeat(Math.min(6, h.length + 2))} `);

  const L = [];
  L.push(`你是《${book}》的长篇网文写作执行者。任务：**${t.name}（第 ${ch.no} 章）**。`);
  L.push("");
  if (opts.local) {
    // 本地模型没有文件权限，读不到 reference 路径 → 换成蒸馏好的写作要点
    L.push("## 执行方式（本地模型，无文件权限）");
    L.push("你读不到任何外部文档；写作方法论已蒸馏为以下要点，必须遵守：");
    L.push("- 只输出成果本身，不要解释、前言、代码围栏、收尾客套");
    L.push("- 正文 2200–2500 字；单场景优先写「动作 + 对话 + 环境细节」，情绪不直说，靠行为与物证落地");
    L.push("- 每个信息点只出现一次；不重复解释设定；回忆压缩到两句以内，不写大段「他想起」");
    L.push("- 对话必须有信息增量或张力，禁寒暄垫场；人物区分靠用词与节奏，不靠语气标签");
    L.push("- 章末必须落在「章末钩子」上：不收束、不总结、不升华、不预告");
    L.push("- 人名、数值、伏笔状态与下方各节严格一致；「角色知识状态」里谁不知道的事，谁的视角就绝不能说破");
  } else {
    L.push("## 第一步：先读 reference（强制，先读后写，不得跳过）");
    t.refs.forEach((r) => {
      const [p, note] = r.split(" :: ");
      L.push(`- ${SKILL_DIR}/${p}${note ? `（${note}）` : ""}`);
    });
  }
  L.push("");
  L.push("## 项目");
  L.push(`书名：${book}`);
  L.push(`项目目录：${root}`);
  if (ch.night) L.push(`章节归属：第 ${ch.night} 夜 · ${ch.nightTitle || ""}`);
  L.push("");
  L.push(`## 第 ${ch.no} 章 · 大纲锚点（不得偏离）`);
  L.push(`- 功能：${ch.func || "—"}`);
  L.push(`- 关键节拍：${ch.beat || "—"}`);
  L.push(`- 章末钩子（${ch.hookType || "未标"}）：${ch.hook || "—"}`);
  L.push("");
  if (ctx.positioning) {
    L.push("## 题材定位（节选）");
    L.push(demote(ctx.positioning));
    L.push("");
  }
  if (ctx.world) {
    L.push("## 世界观与技能（节选）");
    L.push(demote(ctx.world));
    L.push("");
  }
  if (ctx.rulebook) {
    L.push("## 副本规则体系（节选 · 本书的核心机制）");
    L.push(demote(ctx.rulebook));
    L.push("");
  }
  if (ctx.foreshadow) {
    L.push("## 本章相关伏笔");
    L.push(demote(ctx.foreshadow));
    L.push("");
  }
  if (ctx.knowledge) {
    L.push("## 角色知识状态（谁知道什么 / 谁绝不能知道什么）");
    L.push(demote(ctx.knowledge));
    L.push("");
  }
  if (ctx.hooks) {
    L.push("## 钩子矩阵（相邻章禁同型）");
    L.push(demote(ctx.hooks));
    L.push("");
  }
  if (ctx.prevTail) {
    L.push("## 上一章结尾（衔接用，不要重复写这段）");
    L.push("```");
    L.push(ctx.prevTail);
    L.push("```");
    L.push("");
  }
  L.push("## Constraint Lock（原样锁定，禁止越界）");
  L.push(`- 字数：${WORD_RANGE} 字（按本项目章级大纲惯例）`);
  L.push(`- 必发生：${ch.beat || "见关键节拍"}`);
  L.push("- 禁止发生：把顾客当敌人处理（本书铁律——只靠服务通关，禁打斗、禁用工具箱道具伤害顾客）");
  L.push(`- 本章停笔点：${ch.hook || "见章末钩子"}`);
  L.push("");
  L.push("## 文风禁令（违反即不合格）");
  L.push(STYLE_RULES);
  L.push("");
  L.push("## 交付");
  L.push(`1. ${t.deliver(ch, nnn)}`);
  L.push(`2. ${t.extra}`);
  return L.join("\n");
}

/** 哪些任务的成果可以直接落盘：细纲 / 正文 */
function promptSaveTarget(ch, task) {
  const nnn = String(ch.no).padStart(3, "0");
  if (task === "outline") return `大纲/细纲_第${nnn}章.md`;
  if (task === "draft") return `正文/第${nnn}章_未命名.md`;
  return null;
}

/** Prompt 运行弹窗：本地精简版可直接用本地大模型执行；完整版可复制贴给 Agent */
async function openPromptRunDialog(ch, task, fullPrompt) {
  // 注意：本函数下方声明了局部 const $（作用域覆盖整个函数体），
  // 此处必须用 document.querySelector；写成 $() 会命中「暂时性死区」而抛
  // ReferenceError: Cannot access '$' before initialization（表现为「打包失败」）。
  document.querySelector("#pvOverlay")?.remove();
  const t = RAW_PACK_TASKS[task];
  const savePath = promptSaveTarget(ch, task);
  let localPrompt;
  try { localPrompt = await buildChapterPrompt(ch, task, { local: true }); }
  catch { localPrompt = fullPrompt; }

  const overlay = document.createElement("div");
  overlay.id = "pvOverlay";
  overlay.className = "pv-overlay";
  overlay.innerHTML = `
    <div class="pv-dialog">
      <div class="pv-h">
        <span>${escapeHtml(t.name)} · 第 ${ch.no} 章</span>
        <span class="spacer"></span>
        <button class="mini" id="pvClose">关闭 ✕</button>
      </div>
      <div class="pv-sub">
        本地模型<b>没有文件权限</b>，读不到 reference 路径——默认给「本地精简版」（写作要点已内联，书内设定本就在提示词里）。
        也可切「完整版」复制后贴到对话里，由 Agent 按 oh-story 流程精读 references 后执行（质量更高）。
      </div>
      <div class="chips" id="pvVariant">
        <button class="chip on" data-v="local">本地精简版（可直接执行）</button>
        <button class="chip" data-v="full">完整版（贴给 Agent）</button>
      </div>
      <textarea id="pvPrompt" class="pv-prompt" spellcheck="false"></textarea>
      <div class="pv-actions">
        <button class="btn primary" id="pvRun" ${aiReady() ? "" : "disabled"}>用本地大模型执行</button>
        ${task === "draft" ? `<button class="btn" id="pvPipe">流水线：WebNovel 水版 → Gemma 精简</button>` : ""}
        <button class="btn" id="pvCopy">复制当前版本</button>
        <span class="spacer"></span>
        <span class="pv-status" id="pvStatus"></span>
      </div>
      ${task === "draft" ? `<div class="pv-sub">流水线两阶段都走 <code>11440</code>：先以 <code>model=webnovel</code> 写水版正文，再以 <code>model=gemma</code> 浓缩成精简版（服务端按请求里的 model 字段切换后端）。切换模型可能触发重新加载，耗时比单次调用长。</div>` : ""}
      <div class="pv-result" id="pvResult" hidden>
        <div class="pv-rh">
          <span id="pvResultTitle">结果</span>
          <span class="pv-count" id="pvCount"></span>
          <span class="spacer"></span>
          <button class="mini" id="pvCopyDraft" hidden>复制水版</button>
          <button class="mini" id="pvCopyResult">复制结果</button>
          ${savePath ? `<button class="mini primary" id="pvSave">保存到文件</button>` : ""}
        </div>
        ${savePath ? `<div class="pv-path"><label>保存路径</label><input id="pvPath" value="${escapeHtml(savePath)}" /></div>` : ""}
        <div class="pv-raw" id="pvRaw"></div>
        <details class="pv-draft" id="pvDraftWrap" hidden>
          <summary>查看水版初稿（WebNovel 产出，仅供参考）</summary>
          <div class="pv-raw" id="pvDraftRaw"></div>
        </details>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const promptEl = $("#pvPrompt");
  const statusEl = $("#pvStatus");
  promptEl.value = localPrompt;

  const close = () => overlay.remove();
  $("#pvClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape" && document.body.contains(overlay)) { close(); document.removeEventListener("keydown", esc); }
  });

  overlay.querySelectorAll("[data-v]").forEach((el) => el.addEventListener("click", () => {
    overlay.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("on", x === el));
    promptEl.value = el.dataset.v === "local" ? localPrompt : fullPrompt;
  }));

  $("#pvCopy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(promptEl.value);
    statusEl.textContent = `已复制（${promptEl.value.length} 字）`;
  });

  $("#pvRun").addEventListener("click", async () => {
    const btn = $("#pvRun");
    btn.disabled = true;
    statusEl.innerHTML = '<span class="spinner"></span> 流式生成中…（持续吐字即正常，不再按总时长判超时）';
    $("#pvResult").hidden = true;
    try {
      const pathEl = $("#pvPath");
      const targetPath = pathEl ? pathEl.value.trim() : "";
      let lastPaint = 0;
      const r = await streamRawGenerate({
        prompt: promptEl.value,
        temperature: 0.85,
        max_tokens: 4096,
        path: targetPath,
        onText: (_d, acc) => {
          const now = Date.now();
          if (now - lastPaint > 400) {
            lastPaint = now;
            statusEl.innerHTML = `<span class="spinner"></span> 生成中… ${acc.length} 字`;
          }
        },
        onTick: (t) => {
          statusEl.innerHTML = `<span class="spinner"></span> 生成中… ${(t && t.chars) || 0} 字 · ${(t && t.elapsed) || 0}s`;
        },
      });
      const out = String(r.text || "");
      if (!out) throw new Error("模型返回空内容");
      $("#pvRaw").textContent = out;
      $("#pvResultTitle").textContent = r.partial ? "结果（生成中断，已保留部分内容）" : "结果";
      $("#pvCount").textContent = `${out.length} 字`;
      $("#pvDraftWrap").hidden = true;
      $("#pvCopyDraft").hidden = true;
      $("#pvResult").hidden = false;
      if (r.partial) {
        statusEl.textContent = `已保留 ${out.length} 字（生成中断：${r.note || ""}）`;
        toast(`生成中断，已保留 ${out.length} 字`, true);
      } else {
        statusEl.textContent = "";
        toast("生成完成，请检查后保存或复制");
      }
    } catch (err) {
      statusEl.textContent = `失败：${err.message}`;
      toast(`执行失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  $("#pvPipe")?.addEventListener("click", async () => {
    const btn = $("#pvPipe");
    btn.disabled = true;
      statusEl.innerHTML = '<span class="spinner"></span> 流水线：WebNovel 正在写水版…';
      try {
        const r = await runPipeline({
          text: promptEl.value,
          instruction: "按上面的完整要求写一章正文；本阶段是「水版」，请充分铺开、先求完整有料。",
          context: {},
        });
        $("#pvRaw").textContent = r.final || "";
        $("#pvResultTitle").textContent = "精简版（Gemma 浓缩）";
        $("#pvCount").textContent = `${(r.final || "").length} 字`;
      const wrap = $("#pvDraftWrap");
      if (r.draft) {
        $("#pvDraftRaw").textContent = r.draft;
        wrap.hidden = false;
        $("#pvCopyDraft").hidden = false;
      } else {
        wrap.hidden = true;
        $("#pvCopyDraft").hidden = true;
      }
      $("#pvResult").hidden = false;
      statusEl.textContent = "";
      toast("流水线完成（精简版 + 水版），请检查后保存");
    } catch (err) {
      statusEl.textContent = `失败：${err.message}`;
      toast(`流水线失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  $("#pvCopyDraft")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#pvDraftRaw").textContent);
    toast("水版已复制");
  });

  $("#pvCopyResult")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#pvRaw").textContent);
    toast("结果已复制");
  });

  $("#pvSave")?.addEventListener("click", async () => {
    const path = $("#pvPath").value.trim();
    const content = $("#pvRaw").textContent;
    if (!path || !content) return;
    try {
      await source().writeFile(path, content);
      toast(`已保存：${path}`);
      statusEl.textContent = `已保存 ${path}`;
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  });

  promptEl.focus();
}

async function copyChapterPrompt(ch, task) {
  try {
    toast("正在打包上下文…");
    const prompt = await buildChapterPrompt(ch, task);
    await navigator.clipboard.writeText(prompt);
    toast(`已复制「${RAW_PACK_TASKS[task].name}」Prompt（${prompt.length} 字）`);
    await openPromptRunDialog(ch, task, prompt);
  } catch (err) {
    toast(`打包失败：${err.message}`, true);
  }
}

async function genChapter(ch, task) {
  const pipeline = config.ai.usePipeline && pipelineReady();
  if (!pipeline && !aiReady()) {
    toast("还没有可用模型：到「设置 → AI 接口」选预设（本地 Ollama 或云端均可），或改用「复制 Prompt」", true);
    return;
  }
  const box = $("#draftBox");
  if (box) box.innerHTML = `<div class="draft-box"><div class="dh2"><span class="spinner"></span> ${pipeline ? "流水线生成中（WebNovel 水版 → Gemma 精简）…" : "生成中…"}（正文较长，请稍候）</div></div>`;
  try {
    if (pipeline) {
      // 两阶段都在 11440：初稿角色 model=webnovel 写水版，浓缩角色 model=gemma 出精简版
      const spec = await buildChapterPrompt(ch, task, { local: true });
      const r = await runPipeline({
        text: spec,
        instruction: "按下面的完整要求写一章正文；本阶段是「水版」，请充分铺开、先求完整有料。",
        context: {},
      });
      const text = r.final || r.draft;
      state.draftBuffer = { ch, task, text, draft: r.draft, degraded: r.degraded };
      renderDraftBox(ch, text, r.draft);
      toast(r.degraded ? "精简失败，已退回水版" : "流水线完成（精简版 + 水版）");
    } else {
      const prompt = await buildChapterPrompt(ch, task);
      const { candidates } = await source().aiRewrite({
        text: prompt,
        instruction: "按上面的完整要求执行并只输出成果本身。",
        context: {},
        count: 1,
      });
      const text = (candidates && candidates[0]) || "";
      state.draftBuffer = { ch, task, text };
      renderDraftBox(ch, text);
      toast("生成完成，确认后保存");
    }
  } catch (err) {
    if (box) box.innerHTML = "";
    toast(`生成失败：${err.message}`, true);
  }
}

function renderDraftBox(ch, text, draft) {
  const box = $("#draftBox");
  if (!box || !state.draftBuffer) return;
  const taskName = RAW_PACK_TASKS[state.draftBuffer.task]?.name || "生成";
  const draftHtml = draft
    ? `<details class="draft-ref"><summary>查看初稿（流水线阶段一产出，仅供参考）</summary><div class="draft-raw">${escapeHtml(draft)}</div></details>`
    : "";
  box.innerHTML = `
    <div class="draft-box">
      <div class="dh2">
        <span>${escapeHtml(taskName)}结果${state.draftBuffer.degraded ? "（浓缩失败，已退回初稿）" : ""}</span>
        <span class="sp"></span>
        <span id="draftCount">${text.length} 字</span>
        <button class="mini" id="saveDraft">保存到文件</button>
        <button class="mini" id="discardDraft">丢弃</button>
      </div>
      <textarea id="draftText">${escapeHtml(text)}</textarea>
      ${draftHtml}
    </div>`;
  const ta = $("#draftText");
  ta.addEventListener("input", () => {
    const c = $("#draftCount");
    if (c) c.textContent = `${ta.value.length} 字`;
  });
  $("#discardDraft").addEventListener("click", () => { box.innerHTML = ""; });
  $("#saveDraft").addEventListener("click", async () => {
    const { ch: c, task } = state.draftBuffer;
    const content = ta.value;
    const path = task === "outline"
      ? `大纲/细纲_第${String(c.no).padStart(3, "0")}章.md`
      : chapterFileName(c.no, c.func);
    try {
      await source().writeFile(path, content);
      toast(`已保存到 ${path}`);
      box.innerHTML = "";
      await refreshProjectQuiet();
      await renderWriting();
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

/** 本地/局域网端点判断（本地模型通常不需要 Key） */
function isLocalUrl(url) {
  try {
    const h = new URL(String(url)).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "127.0.0.1" || h === "::1"
      || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  } catch {
    return false;
  }
}

/** 当前配置是否可用于生成（本地端点无需 Key） */
function aiReady() {
  const isGh = activeMode === "github";
  const base = (isGh ? config.ai.baseUrl : (state.aiConfig?.baseUrl || config.ai.baseUrl)) || "";
  const model = (isGh ? config.ai.model : (state.aiConfig?.model || config.ai.model)) || "";
  const hasKey = isGh ? Boolean(config.ai.apiKey) : Boolean(state.aiConfig?.hasKey || config.ai.apiKey);
  return Boolean(base && model && (hasKey || isLocalUrl(base)));
}

/** 某个角色（draft / condense）是否已可用（本地端点无需 Key） */
function roleReady(role) {
  const isGh = activeMode === "github";
  const r = isGh ? (config.ai.roles?.[role]) : (state.aiConfig?.roles?.[role]);
  const base = r?.baseUrl || "";
  const model = r?.model || "";
  const hasKey = isGh ? Boolean(r?.apiKey) : Boolean(r?.hasKey || r?.apiKey);
  return Boolean(base && model && (hasKey || isLocalUrl(base)));
}

/** 两阶段流水线是否可用（需同时配好初稿与浓缩两个模型） */
function pipelineReady() { return roleReady("draft") && roleReady("condense"); }

/**
 * 流水线统一入口（全部走 11440 单端口）：
 * 阶段一用初稿角色（model=webnovel，灌水机写水版正文）→ 阶段二用浓缩角色（model=gemma，浓缩成精简版）。
 * 服务端按请求里的 model 字段切换后端模型，故两阶段都打同一个 11440 端口。
 */
async function runPipeline(payload) {
  return source().aiPipeline(payload);
}

/** 常见服务商预设：一键填 Base URL + 常用模型名 */
const AI_PROVIDERS = [
  { label: "Ollama（本机 127.0.0.1）", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:14b", local: true },
  { label: "llama.cpp（局域网 PC）", baseUrl: "http://192.168.31.211:11440/v1", model: "gemma", local: true },
  { label: "LM Studio（本地）", baseUrl: "http://localhost:1234/v1", model: "", local: true },
  { label: "llama.cpp（本地）", baseUrl: "http://localhost:8080/v1", model: "", local: true },
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-chat-v3" },
  { label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-72B-Instruct" },
  { label: "Moonshot", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-32k" },
  { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
];

/** 渲染一个「角色模型」卡片（初稿 / 浓缩） */
function roleCardHtml(role, title, sub, v) {
  v = v || {};
  return `
  <div class="role-card" data-role="${role}">
    <div class="role-h">${title} <span class="role-sub">${sub}</span></div>
    <div class="chips role-presets">
      ${AI_PROVIDERS.map((p, i) => `<button class="chip" data-role="${role}" data-aip="${i}">${escapeHtml(p.label)}</button>`).join("")}
    </div>
    <div class="grid2">
      <div class="field"><label>Base URL</label><input data-f="baseUrl" placeholder="http://192.168.31.211:11434/v1" value="${escapeHtml(v.baseUrl || "")}" /></div>
      <div class="field">
        <label>Model <span style="font-weight:400;color:var(--text-faint)">手填，或拉取列表后从下拉选</span></label>
        <input data-f="model" list="${role}Models" placeholder="例如 qwen2.5:32b" value="${escapeHtml(v.model || "")}" />
        <datalist id="${role}Models"></datalist>
        <select class="model-pick" data-f="modelPick" hidden></select>
      </div>
    </div>
    <div class="field">
      <label>API Key ${v.apiKey ? "（已保存，留空则不改动）" : "（本地地址可留空）"}</label>
      <input data-f="apiKey" type="password" placeholder="${v.apiKey ? "••••••••" : "本地地址可留空"}" />
    </div>
    <div class="row">
      <button class="btn" data-f="test">测试连接</button>
      <button class="btn" data-f="list">拉取模型列表</button>
      <span class="spacer"></span>
      <span class="role-status" data-f="status" style="font-size:11.5px;color:var(--text-faint)"></span>
    </div>
  </div>`;
}

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
        <h2>AI 模型（初稿 / 浓缩 两阶段）</h2>
        <div class="hint" style="margin-bottom:14px">
          推理机统一在 <code>192.168.31.211:11440</code>（OpenAI 兼容）。<b>服务端按请求里的 model 字段切换后端模型</b>：
          写水版填 <code>webnovel</code>、出精简版填 <code>gemma</code>。先点预设「llama.cpp（局域网 PC）」填好地址，再「拉取模型列表」从下拉选模型名。
          两栏地址相同、只差模型名——填好初稿那栏后点「复制到浓缩」一键带过去。<br>
          想用云端模型：点预设 <b>OpenRouter</b>（<code>https://openrouter.ai/api/v1</code>）+ 填 <code>sk-or-</code> 开头的 Key，「拉取模型列表」会列出全部云端模型（带上下文长度与价格），下拉直接选。本地端点 Key 可留空。
        </div>

        ${roleCardHtml("draft", "① 初稿模型", "负责把要点 / 大纲展开成完整初稿", a.roles?.draft)}
        ${roleCardHtml("condense", "② 浓缩模型", "负责把初稿浓缩、润色成最终稿", a.roles?.condense)}

        <div class="row" style="margin-top:6px">
          <label class="switch"><input type="checkbox" id="usePipelineGen" ${config.ai.usePipeline ? "checked" : ""}> 默认用「初稿 → 浓缩」流水线生成新章节</label>
        </div>

        ${activeMode === "github" ? "" : `<div class="row" style="margin-top:10px">
          <label class="switch"><input type="checkbox" id="autoUnload" ${(state.aiConfig?.autoUnload ?? config.ai.autoUnload ?? true) ? "checked" : ""}> 本地模型<b>用后自动释放显存</b>（省显存/省电；下次调用需冷启动约 40 秒）</label>
          <span class="spacer"></span>
          <button class="btn" id="unloadNow">立即释放显存</button>
        </div>
        <div class="hint" style="margin-top:8px">
          释放显存＝向推理机 <code>POST /admin/unload</code>（llama.cpp 支持）。流水线两阶段之间不会释放，避免反复冷启动；本地模型空闲约 10 分钟也会自动下线。
        </div>`}

        <div class="hint" style="margin-top:12px">
          流水线两阶段都走同一个 <code>11440</code> 端口：<b>初稿</b>填 <code>webnovel</code>（灌水机，写水版正文）→ <b>浓缩</b>填 <code>gemma</code>（浓缩成精简版）。服务端按请求里的 model 字段切换后端模型。<br>
          切换模型会触发重新加载，一次流水线（水版 + 精简）比单次调用慢，请耐心等。
        </div>

        <div class="row" style="margin-top:16px">
          <button class="btn primary" id="saveAi">保存配置</button>
          <button class="btn" id="copyToOther">把「初稿」地址复制到「浓缩」</button>
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

  // 每个角色卡片：预设一键填充 + 测试 + 拉取列表
  m.querySelectorAll(".role-card").forEach((card) => {
    const role = card.dataset.role;
    const statusEl = () => card.querySelector('[data-f="status"]');
    card.querySelectorAll("[data-aip]").forEach((el) => el.addEventListener("click", () => {
      const p = AI_PROVIDERS[Number(el.dataset.aip)];
      card.querySelector('[data-f="baseUrl"]').value = p.baseUrl;
      const mv = card.querySelector('[data-f="model"]');
      if (!mv.value.trim() && p.model) mv.value = p.model;
      card.querySelectorAll("[data-aip]").forEach((x) => x.classList.remove("on"));
      el.classList.add("on");
      statusEl().textContent = p.local ? "本地端点 · Key 可留空" : "需要 API Key";
    }));
    const doList = async (fill) => {
      const baseUrl = card.querySelector('[data-f="baseUrl"]').value.trim();
      const apiKey = card.querySelector('[data-f="apiKey"]').value.trim();
      if (!baseUrl) { toast("先填 Base URL", true); return; }
      statusEl().innerHTML = '<span class="spinner"></span> 连接中…';
      try {
        const { models, rich, local } = await source().listModels({ baseUrl, apiKey });
        if (fill && models.length) {
          const items = (Array.isArray(rich) && rich.length)
            ? rich
            : models.map((id) => ({ id, name: "", ctx: null, price: null }));
          const optHtml = items.map((mo) => {
            const bits = [];
            if (mo.ctx) bits.push(`${Math.round(mo.ctx / 1000)}k 上下文`);
            if (mo.price != null) bits.push(`$${mo.price >= 1 ? mo.price.toFixed(2) : mo.price.toFixed(3)}/1M`);
            const label = [mo.name || mo.id, bits.length ? `（${bits.join(" · ")}）` : ""].join(" ").trim();
            return `<option value="${escapeHtml(mo.id)}">${escapeHtml(label)}</option>`;
          }).join("");
          card.querySelector(`#${role}Models`).innerHTML = optHtml;
          const pick = card.querySelector('[data-f="modelPick"]');
          pick.innerHTML = `<option value="">—— 从模型列表选择 ——</option>${optHtml}`;
          pick.hidden = false;
          const mv = card.querySelector('[data-f="model"]');
          if (!mv.value.trim()) mv.value = models[0];
        }
        statusEl().textContent = models.length
          ? `连通 · ${models.length} 个模型${local ? "（本地）" : ""}，下拉可选`
          : "连通（未列出模型，可手填模型名）";
        toast(models.length ? `发现 ${models.length} 个模型` : "已连通");
      } catch (err) {
        statusEl().textContent = "";
        toast(`连接失败：${err.message}`, true);
      }
    };
    card.querySelector('[data-f="test"]').addEventListener("click", () => doList(false));
    card.querySelector('[data-f="list"]').addEventListener("click", () => doList(true));
    const pickEl = card.querySelector('[data-f="modelPick"]');
    pickEl.addEventListener("change", () => {
      if (pickEl.value) card.querySelector('[data-f="model"]').value = pickEl.value;
    });
  });

  // 把「初稿」栏的地址 / Key 复制到「浓缩」栏
  // 默认用流水线生成章节（持久化到 config.ai.usePipeline）
  $("#usePipelineGen").addEventListener("change", (e) => {
    config.ai.usePipeline = e.target.checked;
    saveConfig();
    toast(e.target.checked ? "已开启流水线生成" : "已关闭流水线生成");
  });

  // 用后自动释放显存（存服务端）+ 立即释放按钮
  const autoUnloadEl = $("#autoUnload");
  if (autoUnloadEl) autoUnloadEl.addEventListener("change", async (e) => {
    try {
      await source().saveAiConfig({ autoUnload: e.target.checked });
      config.ai.autoUnload = e.target.checked;
      saveConfig();
      if (state.aiConfig) state.aiConfig.autoUnload = e.target.checked;
      toast(e.target.checked ? "已开启：本地模型用后自动释放显存" : "已关闭：用后不释放显存");
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(`保存失败：${err.message}`, true);
    }
  });
  const unloadNowEl = $("#unloadNow");
  if (unloadNowEl) unloadNowEl.addEventListener("click", async () => {
    unloadNowEl.disabled = true;
    try {
      const r = await api("/api/ai/unload", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast("已通知推理机释放显存");
      $("#aiStatus").textContent = `显存已释放 · ${r.endpoint || ""}`;
    } catch (err) {
      toast(`释放失败：${err.message}`, true);
    } finally {
      unloadNowEl.disabled = false;
    }
  });

  $("#copyToOther").addEventListener("click", () => {
    const src = m.querySelector('.role-card[data-role="draft"] [data-f="baseUrl"]').value.trim();
    const key = m.querySelector('.role-card[data-role="draft"] [data-f="apiKey"]').value.trim();
    if (!src) { toast("先在「初稿」栏填好地址", true); return; }
    m.querySelector('.role-card[data-role="condense"] [data-f="baseUrl"]').value = src;
    const ck = m.querySelector('.role-card[data-role="condense"] [data-f="apiKey"]');
    if (!ck.value.trim() && key) ck.value = key;
    toast("已复制地址到「浓缩」栏");
  });

  $("#saveAi").addEventListener("click", async () => {
    const readRole = (role) => {
      const c = m.querySelector(`.role-card[data-role="${role}"]`);
      return {
        baseUrl: c.querySelector('[data-f="baseUrl"]').value.trim(),
        model: c.querySelector('[data-f="model"]').value.trim(),
        apiKey: c.querySelector('[data-f="apiKey"]').value.trim(),
      };
    };
    const payload = {
      baseUrl: state.aiConfig?.baseUrl || config.ai.baseUrl || "",
      model: state.aiConfig?.model || config.ai.model || "",
      apiKey: "", // 不覆盖全局 key；角色各自带自己的
      roles: { draft: readRole("draft"), condense: readRole("condense") },
    };
    // 前端侧同步保存（供下次进入设置页读取）
    config.ai.roles = payload.roles;
    saveConfig();
    const summarize = (cfg) => {
      const r = cfg?.roles || {};
      const fmt = (x) => x ? (x.hasKey || x.model ? x.model || "已配" : "未配") : "未配";
      return `初稿：${fmt(r.draft)} ｜ 浓缩：${fmt(r.condense)}`;
    };
    if (activeMode === "local") {
      try {
        state.aiConfig = await LocalSource.saveAiConfig(payload);
        toast("AI 配置已保存");
        $("#aiStatus").textContent = summarize(state.aiConfig);
      } catch (err) {
        toast(`保存失败：${err.message}`, true);
      }
    } else {
      state.aiConfig = await GitHubSource.saveAiConfig(payload);
      toast("AI 配置已保存到本机浏览器");
      $("#aiStatus").textContent = summarize(state.aiConfig);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function setTab(view) {
  document.querySelectorAll(".tab[data-view]").forEach((el) => el.classList.toggle("on", el.dataset.view === view));
  if (view === "dash") $("#crumb").textContent = "概览";
  if (view === "writing") $("#crumb").textContent = "写作";
  if (view === "settings") $("#crumb").textContent = "设置";
}

async function switchView(view) {
  state.view = view;
  setTab(view);
  if (view === "dash") renderDash();
  else if (view === "writing") await renderWriting();
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

/* 全局约定：点击浮层外部（空白处）一律收起 —— 覆盖 AI 改写面板、抽屉内菜单、prompt 弹窗等所有浮层 */
document.addEventListener("click", (ev) => {
  const panel = $("#aiPanel");
  if (panel && panel.classList.contains("open")
    && !panel.contains(ev.target)
    && !ev.target.closest("#aiToggle")
    && !ev.target.closest("[data-act='ai']")) {
    closeAiPanel();
  }
});
$("#brand").addEventListener("click", () => switchView("dash"));

boot();
