/**
 * LongCut —— 长视频规整台（去冗余 → 出草稿 / EDL / SRT / MP4）
 *
 * 定位：给「结构已知的长视频」做**机械规整**。
 *   转写 → 人读文本、标出「这段剪掉」 → 硬剪 + 字幕重排 + 出片 / 出草稿
 *
 * 刻意不做的事：**不判断内容好坏**。HotClip 那套「AI 找爆点、从 3 小时里挑
 * 5 分钟」是另一种活（选择）；这里只要「加工」——保留全部有效内容，去掉冗余。
 * 判断权在人手里，ASR 只负责把声音变成可读的文本。
 *
 * 复用 HotClip 的 core（该目录零 electron 引用，纯 Node，可直接 import）：
 *   pipeline.transcribeCached   转写（与桌面端共享缓存，同一素材不重跑）
 *   gaps.subtractSpans          区间减法：「从整片里减掉若干区间」
 *   jianying.buildDraftContent  剪映草稿（媒体反链源片，不复制）
 *   edl.buildEdl                CMX3600 EDL —— 进 Premiere 重链源片继续精修
 *   srt.buildSrt                字幕（时间轴已按剪后重排）
 *
 * 跑法：
 *   cd hotclip && ./node_modules/.bin/tsx longcut/server.ts
 *   浏览器打开 http://127.0.0.1:5180
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createReadStream } from "fs";
import { stat, readFile, writeFile, mkdir, readdir } from "fs/promises";
import { basename, extname, join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";

import { transcribeCached } from "../src/core/pipeline";
import { modelsRoot, cacheDir, userDataDir } from "../src/core/appenv";
import { loadGlossary } from "../src/core/glossary-store";
import { subtractSpans } from "../src/core/gaps";
import { buildDraftContent, buildDraftMetaInfo } from "../src/core/jianying";
import { buildEdl, type EdlClip } from "../src/core/edl";
import { buildSrt, srtLinesFromWords } from "../src/core/srt";
import { parseProbeOutput, type MediaInfo } from "../src/core/probe";
import { resolveFfprobePath, resolveFfmpegPath } from "../src/core/binaries";
import type { Transcript, TranscriptWord } from "../src/shared/api-types";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.LONGCUT_PORT || 5180);
/** 会话存档根目录。默认与 HotClip 的输出目录对称。 */
const OUT_ROOT = process.env.LONGCUT_OUT || "D:\\FFOutput\\LongCut";
/** 静态资源目录（本文件所在目录）。CJS 下 __dirname 可用；ESM 下退回 cwd。 */
const HERE = typeof __dirname !== "undefined" ? __dirname : join(process.cwd(), "longcut");

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm", ".ts", ".m4v", ".wmv"]);

/** 一个删除区间（源片绝对秒）。 */
interface Span {
  startSec: number;
  endSec: number;
}

/**
 * 一次会话 = 一条视频的标记进度。
 * 存档在 `<OUT_ROOT>/<视频名>/session.json`，关掉明天接着标。
 */
interface Session {
  videoPath: string;
  name: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  /** 用户标的「剪掉」区间，按时间排序。这是唯一数据源。 */
  marks: Span[];
  updatedAt: string;
}

// ---------------------------------------------------------------- 基础工具

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(s);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function probeMedia(filePath: string): Promise<MediaInfo> {
  const { stdout } = await execFileAsync(
    resolveFfprobePath(),
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { maxBuffer: 64 * 1024 * 1024 }
  );
  return parseProbeOutput(JSON.parse(stdout) as unknown);
}

function sessionDir(videoPath: string): string {
  const stem = basename(videoPath, extname(videoPath)).replace(/[\\/:*?"<>|]/g, "_");
  return join(OUT_ROOT, stem);
}

async function loadSession(videoPath: string): Promise<Session | null> {
  try {
    const raw = await readFile(join(sessionDir(videoPath), "session.json"), "utf8");
    const s = JSON.parse(raw) as Session;
    // 不校验 videoPath 是否相等：素材被搬过位置也让它读出来，用不用由前端决定
    return s;
  } catch {
    return null;
  }
}

async function saveSession(s: Session): Promise<void> {
  const dir = sessionDir(s.videoPath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.json"), JSON.stringify(s, null, 2), "utf8");
}

/** marks 归一化：按起点排序、合并重叠与相邻（避免产生碎片保留段）。 */
function normalizeMarks(marks: Span[], durationSec: number): Span[] {
  const clean = marks
    .map((m) => ({
      startSec: Math.max(0, Math.min(m.startSec, m.endSec)),
      endSec: Math.min(durationSec, Math.max(m.startSec, m.endSec)),
    }))
    .filter((m) => m.endSec - m.startSec > 0.01)
    .sort((a, b) => a.startSec - b.startSec);
  const out: Span[] = [];
  for (const m of clean) {
    const last = out[out.length - 1];
    if (last && m.startSec <= last.endSec + 0.001) last.endSec = Math.max(last.endSec, m.endSec);
    else out.push({ ...m });
  }
  return out;
}

/** 保留段 = 整片减掉所有 marks。这是「剪完还剩什么」的唯一算法。 */
function keptSpans(durationSec: number, marks: Span[]): Span[] {
  return subtractSpans([{ startSec: 0, endSec: durationSec }], marks).map((s) => ({
    startSec: s.startSec,
    endSec: s.endSec,
  }));
}

/**
 * 把词重排到剪后的时间轴。
 * 剪掉中间的片段后，后面每一条字幕都要往前平移「已剪掉的总时长」——
 * 这一步不做，字幕会越到后面越对不上画面（文本驱动剪辑最经典的翻车点）。
 */
function remapWords(transcript: Transcript, kept: Span[]): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let offset = 0;
  for (const seg of kept) {
    for (const s of transcript.segments) {
      for (const w of s.words) {
        // 只收完整落在保留段里的词；被切点劈开的词丢弃（切点本就该落在词间隙）
        if (w.startSec >= seg.startSec - 1e-6 && w.endSec <= seg.endSec + 1e-6) {
          out.push({
            ...w,
            startSec: w.startSec - seg.startSec + offset,
            endSec: w.endSec - seg.startSec + offset,
          });
        }
      }
    }
    offset += seg.endSec - seg.startSec;
  }
  return out;
}

// ---------------------------------------------------------------- 转写任务

interface TaskState {
  id: string;
  status: "running" | "done" | "error";
  message: string;
  startedAt: number;
  transcript?: Transcript;
  probe?: MediaInfo;
}

const tasks = new Map<string, TaskState>();

async function startTranscribeTask(videoPath: string, engineId: string): Promise<string> {
  const id = randomUUID();
  const t: TaskState = { id, status: "running", message: "读取素材信息…", startedAt: Date.now() };
  tasks.set(id, t);

  void (async () => {
    try {
      const info = await probeMedia(videoPath);
      t.probe = info;
      t.message = "转写中（首次较慢，之后命中缓存秒开）…";
      const glossary = await loadGlossary(userDataDir()).catch(() => []);
      const transcript = await transcribeCached(
        videoPath,
        modelsRoot(),
        cacheDir(),
        glossary,
        undefined,
        undefined,
        { engineId }
      );
      t.transcript = transcript;

      const existing = await loadSession(videoPath);
      const session: Session = {
        videoPath,
        name: basename(videoPath, extname(videoPath)),
        durationSec: transcript.durationSec || info.durationSec,
        width: info.width,
        height: info.height,
        fps: info.fps > 0 ? info.fps : 30,
        marks: existing && existing.videoPath === videoPath ? existing.marks : [],
        updatedAt: new Date().toISOString(),
      };
      await saveSession(session);
      t.status = "done";
      t.message = "转写完成";
    } catch (e) {
      t.status = "error";
      t.message = e instanceof Error ? e.message : String(e);
    }
  })();

  return id;
}

// ---------------------------------------------------------------- 导出

async function runExport(videoPath: string, formats: string[]): Promise<{ files: string[]; kept: number; removed: number }> {
  const session = await loadSession(videoPath);
  if (!session) throw new Error("没有这份素材的会话记录，请先打开一次");
  const info = await probeMedia(videoPath);
  const durationSec = session.durationSec || info.durationSec;
  const marks = normalizeMarks(session.marks, durationSec);
  const kept = keptSpans(durationSec, marks);

  const outBase = join(sessionDir(videoPath), "导出");
  await mkdir(outBase, { recursive: true });
  const files: string[] = [];
  const fps = session.fps > 0 ? Math.round(session.fps) : 30;
  const title = session.name;

  // ---- 剪映草稿：两个 JSON，媒体直接反链源片（不复制大文件） ----
  if (formats.includes("draft")) {
    const folder = join(outBase, "剪映草稿", `01-${title.replace(/[\\/:*?"<>|]/g, "_")}`);
    await mkdir(folder, { recursive: true });
    const clip: EdlClip = { title, segments: kept };
    const content = buildDraftContent({
      sourcePath: videoPath,
      sourceName: basename(videoPath),
      sourceDurationSec: info.durationSec,
      width: session.width || info.width,
      height: session.height || info.height,
      fps,
      clip,
    });
    await writeFile(join(folder, "draft_content.json"), JSON.stringify(content, null, 4), "utf8");
    await writeFile(join(folder, "draft_meta_info.json"), JSON.stringify(buildDraftMetaInfo(), null, 4), "utf8");
    files.push(folder);
  }

  // ---- EDL：给 Premiere / DaVinci 重链源片继续精修 ----
  if (formats.includes("edl")) {
    const edl = buildEdl({
      title,
      sourceName: basename(videoPath),
      fps,
      clips: [{ title, segments: kept }],
    });
    const p = join(outBase, `${title}.edl`);
    await writeFile(p, edl, "utf8");
    files.push(p);
  }

  // ---- 字幕：时间轴已按剪后重排 ----
  if (formats.includes("srt")) {
    const transcript = await loadTranscriptForExport(videoPath);
    if (!transcript) throw new Error("没找到转写结果，请先转写一次再出字幕");
    const words = remapWords(transcript, kept);
    const srt = buildSrt(srtLinesFromWords(words, [], [], {}));
    const p = join(outBase, `${title}.srt`);
    await writeFile(p, srt, "utf8");
    files.push(p);
  }

  // ---- MP4：硬剪拼接（trim + concat 一遍过，无转场） ----
  if (formats.includes("mp4")) {
    const p = join(outBase, `${title}-已剪.mp4`);
    await renderHardCut(videoPath, kept, p, Boolean(info.hasAudio));
    files.push(p);
  }

  const removed = marks.reduce((a, m) => a + (m.endSec - m.startSec), 0);
  return { files, kept: durationSec - removed, removed };
}

async function loadTranscriptForExport(videoPath: string): Promise<Transcript | null> {
  const glossary = await loadGlossary(userDataDir()).catch(() => []);
  return transcribeCached(videoPath, modelsRoot(), cacheDir(), glossary).catch(() => null);
}

/**
 * 硬剪：把保留段按序拼起来。
 * 用 trim/atrim + concat 而不是 select 表达式 —— 前者按时间精确切，不依赖关键帧间隔。
 */
async function renderHardCut(videoPath: string, kept: Span[], outPath: string, hasAudio: boolean): Promise<void> {
  if (kept.length === 0) throw new Error("所有内容都被标记为剪掉了，没有可输出的画面");
  const parts: string[] = [];
  const labels: string[] = [];
  kept.forEach((seg, i) => {
    parts.push(`[0:v]trim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}][a${i}]`);
    } else {
      labels.push(`[v${i}]`);
    }
  });
  // 有音轨 → concat 出 [v][a] 两路；纯视频素材 → 只出 [v]
  parts.push(hasAudio
    ? `${labels.join("")}concat=n=${kept.length}:v=1:a=1[v][a]`
    : `${labels.join("")}concat=n=${kept.length}:v=1:a=0[v]`);
  const filter = parts.join(";");

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-filter_complex", filter,
    "-map", "[v]",
    ...(hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    // 剪辑软件与浏览器对 yuv420p 兼容最好；源片是 10bit/4:2:2 时也能安全播放
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ];
  await execFileAsync(resolveFfmpegPath(), args, { maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------- 媒体流

function parseRange(header: string | undefined, size: number): { start: number; end: number; status: number } | null {
  if (!header) return { start: 0, end: size - 1, status: 200 };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawA, rawB] = m;
  if (rawA === "" && rawB === "") return null;
  if (rawA === "") {
    const n = Number(rawB);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, size - n), end: size - 1, status: 206 };
  }
  const start = Number(rawA);
  const end = rawB === "" ? size - 1 : Math.min(Number(rawB), size - 1);
  if (!Number.isFinite(start) || start > end || start >= size) return null;
  return { start, end, status: 206 };
}

const MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  mkv: "video/x-matroska", avi: "video/x-msvideo", ts: "video/mp2t", flv: "video/x-flv",
};

async function serveMedia(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    json(res, 404, { error: "文件不存在" });
    return;
  }
  const range = parseRange(req.headers.range, size);
  if (!range) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` });
    res.end();
    return;
  }
  const headers: Record<string, string> = {
    "Content-Type": MIME[extname(filePath).slice(1).toLowerCase()] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Content-Length": String(range.end - range.start + 1),
  };
  if (range.status === 206) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  res.writeHead(range.status, headers);
  createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
}

// ---------------------------------------------------------------- 静态资源

const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const name = STATIC[urlPath];
  if (!name) return false;
  try {
    const body = await readFile(join(HERE, name));
    const type = name.endsWith(".html") ? "text/html"
      : name.endsWith(".js") ? "text/javascript"
      : "text/css";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(body);
    return true;
  } catch {
    json(res, 500, { error: `缺少静态资源 ${name}` });
    return true;
  }
}

// ---------------------------------------------------------------- 路由

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && (await serveStatic(res, path))) return;

  // 视频流（支持 Range，拖进度条靠它）
  if (path === "/api/media") {
    const p = url.searchParams.get("p");
    if (!p) return json(res, 400, { error: "缺少 p" });
    // 本服务只监听 127.0.0.1，但仍限定只能读视频文件，避免被当成任意文件读取器
    if (!VIDEO_EXT.has(extname(p).toLowerCase())) return json(res, 403, { error: "只允许读取视频文件" });
    return serveMedia(req, res, p);
  }

  // 会话：读取已有标记
  if (path === "/api/session") {
    const p = url.searchParams.get("p");
    if (!p) return json(res, 400, { error: "缺少 p" });
    const s = await loadSession(p);
    return json(res, 200, { session: s });
  }

  // 打开素材：probe + 启动转写任务
  if (path === "/api/open" && req.method === "POST") {
    const body = await readBody(req);
    const videoPath = String(body.videoPath ?? "").trim();
    const engineId = String(body.engineId ?? "sensevoice");
    if (!videoPath) return json(res, 400, { error: "缺少 videoPath" });
    try {
      const st = await stat(videoPath);
      if (!st.isFile()) throw new Error("不是文件");
    } catch {
      return json(res, 400, { error: `文件打不开：${videoPath}` });
    }
    const existing = await loadSession(videoPath);
    const taskId = await startTranscribeTask(videoPath, engineId);
    return json(res, 200, { taskId, session: existing });
  }

  // 转写任务状态
  if (path === "/api/task") {
    const id = url.searchParams.get("id") ?? "";
    const t = tasks.get(id);
    if (!t) return json(res, 404, { error: "任务不存在" });
    return json(res, 200, {
      status: t.status,
      message: t.message,
      elapsedSec: Math.round((Date.now() - t.startedAt) / 1000),
      transcript: t.status === "done" ? t.transcript : undefined,
      probe: t.probe,
    });
  }

  // 保存标记
  if (path === "/api/marks" && req.method === "POST") {
    const body = await readBody(req);
    const videoPath = String(body.videoPath ?? "");
    const rawMarks = Array.isArray(body.marks) ? (body.marks as Span[]) : [];
    const s = await loadSession(videoPath);
    if (!s) return json(res, 404, { error: "会话不存在，请先打开素材" });
    s.marks = normalizeMarks(rawMarks, s.durationSec);
    s.updatedAt = new Date().toISOString();
    await saveSession(s);
    return json(res, 200, { marks: s.marks });
  }

  // 列目录（便于挑素材，省得手打路径）
  if (path === "/api/list") {
    const dir = url.searchParams.get("dir") || "D:\\FFOutput";
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
      const files = entries
        .filter((e) => e.isFile() && VIDEO_EXT.has(extname(e.name).toLowerCase()))
        .map((e) => join(dir, e.name));
      return json(res, 200, { dir, dirs, files });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 导出
  if (path === "/api/export" && req.method === "POST") {
    const body = await readBody(req);
    const videoPath = String(body.videoPath ?? "");
    const formats = Array.isArray(body.formats) ? (body.formats as string[]) : ["draft", "edl"];
    try {
      const r = await runExport(videoPath, formats);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
});
// 长视频转写可能跑十几分钟，别让 socket 超时掐断
server.timeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`\nLongCut 已启动 → http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`会话存档: ${OUT_ROOT}\n`);
  process.stdout.write(`素材目录: ${modelsRoot()}\n\n`);
});
