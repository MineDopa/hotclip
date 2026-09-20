/**
 * LongCut 前端。
 *
 * 设计原则：**单一数据源**。
 *   state.marked（哪些句子要剪掉）是唯一事实，文本行、时间轴色条、预览跳删、
 *   导出清单全部从它派生。任何视图都不自己存状态 —— 这样"你看到的"和
 *   "导出算出来的"必然一致。
 */

const $ = (id) => document.getElementById(id);

const state = {
  videoPath: "",
  durationSec: 0,
  segments: [],      // TranscriptSegment[]
  marked: new Set(), // 要剪掉的句子 id
  pickerDir: "D:\\FFOutput",
  anchor: null,      // Shift 选段的锚点句子 id
  saveTimer: null,
};

/* ------------------------------------------------------------------ 工具 */

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = s % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${ss} 秒`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opt);
  return r.json().catch(() => ({ error: `服务返回异常（HTTP ${r.status}）` }));
}

function showStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
}

function hideStatus() {
  $("status").classList.add("hidden");
}

/* ------------------------------------------ 派生视图数据（都从 marked 算） */

/** 标记的删除区间（未合并）。 */
function markSpans() {
  const out = [];
  for (const seg of state.segments) {
    if (state.marked.has(seg.id)) out.push({ startSec: seg.startSec, endSec: seg.endSec });
  }
  return out;
}

/** 合并重叠 / 相邻的删除区间：避免播放时在相邻两段之间连跳两次。 */
function mergedMarks() {
  const spans = markSpans().sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.startSec <= last.endSec + 0.001) last.endSec = Math.max(last.endSec, s.endSec);
    else out.push({ ...s });
  }
  return out;
}

/** 剪完还剩多久。 */
function keptDuration() {
  const total = state.durationSec || (state.segments.at(-1)?.endSec ?? 0);
  return total - mergedMarks().reduce((a, m) => a + (m.endSec - m.startSec), 0);
}

/* ------------------------------------------------------------------ 渲染 */

function renderLines() {
  const frag = document.createDocumentFragment();
  for (const seg of state.segments) {
    const div = document.createElement("div");
    div.className = "line" + (state.marked.has(seg.id) ? " cut" : "");
    div.dataset.id = String(seg.id);
    div.innerHTML =
      `<span class="tc">${fmtClock(seg.startSec)}</span>` +
      `<span class="tx">${esc(seg.text)}</span>`;
    frag.appendChild(div);
  }
  const box = $("lines");
  box.innerHTML = "";
  box.appendChild(frag);
}

function renderTimeline() {
  const total = state.durationSec || (state.segments.at(-1)?.endSec ?? 1);
  const tl = $("timeline");
  // 先清掉旧的覆盖块（保留 cursor）
  tl.querySelectorAll(".tl-cut").forEach((e) => e.remove());
  for (const m of mergedMarks()) {
    const d = document.createElement("div");
    d.className = "tl-cut";
    d.style.left = `${(m.startSec / total) * 100}%`;
    d.style.width = `${((m.endSec - m.startSec) / total) * 100}%`;
    tl.appendChild(d);
  }
  renderStats();
}

function renderStats() {
  const total = state.durationSec || (state.segments.at(-1)?.endSec ?? 0);
  const cut = mergedMarks().reduce((a, m) => a + (m.endSec - m.startSec), 0);
  const n = state.marked.size;
  $("stats").textContent =
    `原片 ${fmtDur(total)} → 成片 ${fmtDur(total - cut)}` +
    `（剪掉 ${fmtDur(cut)}，共 ${n} 句）`;
}

/* ------------------------------------------------------------ 标记的操作 */

function setMarked(seg, on) {
  if (on) state.marked.add(seg.id);
  else state.marked.delete(seg.id);
}

function onLineClick(e) {
  const row = e.target.closest(".line");
  if (!row) return;
  const id = Number(row.dataset.id);
  const seg = state.segments.find((s) => s.id === id);
  if (!seg) return;

  // 点时间码＝跳到这句（不改标记）
  if (e.target.classList.contains("tc")) {
    const v = $("video");
    v.currentTime = seg.startSec;
    v.pause();
    return;
  }

  if (e.shiftKey && state.anchor !== null) {
    // Shift+点：把锚点到这句之间的全部标为剪掉
    const a = state.segments.findIndex((s) => s.id === state.anchor);
    const b = state.segments.findIndex((s) => s.id === id);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    for (let i = lo; i <= hi; i++) state.marked.add(state.segments[i].id);
  } else {
    setMarked(seg, !state.marked.has(id));
    state.anchor = id;
  }

  renderLines();
  renderTimeline();
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveMarks, 600);
}

async function saveMarks() {
  if (!state.videoPath) return;
  const r = await api("/api/marks", {
    videoPath: state.videoPath,
    marks: markSpans(),
  });
  if (r.error) showStatus(`标记保存失败：${r.error}`, true);
}

/* ---------------------------------------------------------- 预览跳过已剪 */

function installSkipDeleted() {
  const v = $("video");
  const jumpIfCut = () => {
    if (!$("skip-deleted").checked) return;
    if (v.paused) return; // 暂停时允许停在任意位置查看
    const t = v.currentTime;
    for (const m of mergedMarks()) {
      if (t >= m.startSec - 1e-6 && t < m.endSec - 0.05) {
        v.currentTime = m.endSec + 0.01;
        return;
      }
    }
  };
  v.addEventListener("timeupdate", jumpIfCut);
  v.addEventListener("play", jumpIfCut);
}

function installCursor() {
  const v = $("video");
  const total = () => state.durationSec || (state.segments.at(-1)?.endSec ?? 1);
  const tick = () => {
    $("tl-cursor").style.left = `${(v.currentTime / total()) * 100}%`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* -------------------------------------------------------------- 打开素材 */

async function openVideo(videoPath) {
  if (!videoPath) return;
  state.videoPath = videoPath;
  $("path").value = videoPath;
  hideStatus();
  $("workspace").classList.add("hidden");
  $("export-result").classList.add("hidden");
  showStatus("读取素材信息…");

  const r = await api("/api/open", { videoPath });
  if (r.error) return showStatus(r.error, true);

  const priorMarks = r.session?.marks ?? [];
  pollTask(r.taskId, priorMarks);
}

async function pollTask(taskId, priorMarks) {
  const r = await api(`/api/task?id=${taskId}`);
  if (r.error) return showStatus(r.error, true);

  if (r.status === "running") {
    showStatus(`${r.message}（已 ${r.elapsedSec} 秒）`);
    setTimeout(() => pollTask(taskId, priorMarks), 1500);
    return;
  }
  if (r.status === "error") return showStatus(`转写失败：${r.message}`, true);

  // 完成
  const t = r.transcript;
  state.segments = t.segments ?? [];
  state.durationSec = t.durationSec || (state.segments.at(-1)?.endSec ?? 0);
  state.marked = new Set();
  state.anchor = null;

  // 还原上次的标记：整句落在某个删除区间内的句子 = 标剪
  for (const seg of state.segments) {
    const covered = priorMarks.some(
      (m) => m.startSec <= seg.startSec + 0.05 && m.endSec >= seg.endSec - 0.05
    );
    if (covered) state.marked.add(seg.id);
  }

  $("video").src = `/api/media?p=${encodeURIComponent(state.videoPath)}`;
  renderLines();
  renderTimeline();
  $("workspace").classList.remove("hidden");
  hideStatus();
  if (state.marked.size > 0) {
    showStatus(`已还原 ${state.marked.size} 句历史标记，可继续调整`);
  }
}

/* ------------------------------------------------------------ 素材浏览 */

async function listDir(dir) {
  const r = await api(`/api/list?dir=${encodeURIComponent(dir)}`);
  if (r.error) return showStatus(`列目录失败：${r.error}`, true);
  state.pickerDir = r.dir;
  $("picker-dir").textContent = r.dir;
  const dirs = $("picker-dirs");
  const files = $("picker-files");
  dirs.innerHTML = (r.dirs ?? [])
    .map((d) => `<li class="dir" data-p="${esc(d)}">📁 ${esc(d.split("\\").pop())}</li>`)
    .join("");
  files.innerHTML = (r.files ?? [])
    .map((f) => `<li class="file" data-p="${esc(f)}">${esc(f.split("\\").pop())}</li>`)
    .join("");
  if (!r.files?.length && !r.dirs?.length) files.innerHTML = `<li class="dir">（空目录）</li>`;
  $("picker").classList.remove("hidden");
}

/* ---------------------------------------------------------------- 导出 */

async function doExport() {
  const formats = [];
  if ($("f-draft").checked) formats.push("draft");
  if ($("f-edl").checked) formats.push("edl");
  if ($("f-srt").checked) formats.push("srt");
  if ($("f-mp4").checked) formats.push("mp4");
  if (formats.length === 0) return showStatus("至少勾选一种导出格式", true);

  const box = $("export-result");
  box.classList.remove("hidden", "error");
  box.textContent = "导出中…（MP4 需要重编码，长视频会久一点）";

  const r = await api("/api/export", { videoPath: state.videoPath, formats });
  if (r.error) {
    box.classList.add("error");
    box.textContent = `导出失败：${r.error}`;
    return;
  }
  box.innerHTML =
    `完成：原片 ${fmtDur(r.kept + r.removed)} → 成片 ${fmtDur(r.kept)}（剪掉 ${fmtDur(r.removed)}）<br>` +
    (r.files ?? []).map((f) => `• <code>${esc(f)}</code>`).join("<br>") +
    `<br><span style="color:#7b8b84">剪映草稿文件夹拷进剪映草稿目录即可打开；EDL 在 PR 里「文件 → 导入」重链源片。</span>`;
}

/* ---------------------------------------------------------------- 绑定 */

$("btn-open").addEventListener("click", () => openVideo($("path").value.trim()));
$("path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") openVideo($("path").value.trim());
});

$("btn-list").addEventListener("click", () => listDir(state.pickerDir));
$("picker-close").addEventListener("click", () => $("picker").classList.add("hidden"));
$("picker-up").addEventListener("click", () => {
  const cur = state.pickerDir.replace(/[\\/]+$/, "");
  const parent = cur.replace(/\\[^\\]+$/, "");
  if (!parent || parent === cur) return; // 已经在盘符根
  // 注意 "D:" 要补成 "D:\" —— 不然 readdir("D:") 会读到进程的当前目录
  listDir(/^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent);
});
$("picker-body").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-p]");
  if (!li) return;
  const p = li.dataset.p;
  if (li.classList.contains("dir")) listDir(p);
  else {
    $("picker").classList.add("hidden");
    openVideo(p);
  }
});

$("lines").addEventListener("click", onLineClick);

$("btn-export").addEventListener("click", doExport);
$("btn-clear").addEventListener("click", () => {
  state.marked.clear();
  state.anchor = null;
  renderLines();
  renderTimeline();
  scheduleSave();
});

installSkipDeleted();
installCursor();
