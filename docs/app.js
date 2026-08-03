const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CORE_VERSION = "0.12.10";
const CORE_SOURCES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpeg", "mpg", "ts", "mts", "m2ts", "ogv"]);
const DEFAULT_SETTINGS = { maxEdge: "720", quality: "75", allowUpscale: false, lossless: false, fps: "12", loop: "0", compression: "4" };

const $ = (selector) => document.querySelector(selector);
const elements = {
  fileInput: $("#fileInput"), dropZone: $("#dropZone"), filePanel: $("#filePanel"), sourcePreview: $("#sourcePreview"),
  fileName: $("#fileName"), fileType: $("#fileType"), fileSize: $("#fileSize"), fileDimensions: $("#fileDimensions"),
  outputMode: $("#outputMode"), modeBadge: $("#modeBadge"), removeFileButton: $("#removeFileButton"),
  maxEdge: $("#maxEdge"), quality: $("#quality"), qualityValue: $("#qualityValue"), allowUpscale: $("#allowUpscale"),
  lossless: $("#lossless"), fps: $("#fps"), loop: $("#loop"), compression: $("#compression"),
  compressionValue: $("#compressionValue"), videoSettings: $("#videoSettings"), resetSettingsButton: $("#resetSettingsButton"),
  convertButton: $("#convertButton"), convertButtonText: $("#convertButtonText"), engineHint: $("#engineHint"),
  progressCard: $("#progressCard"), progressPercent: $("#progressPercent"), progressBar: $("#progressBar"),
  progressTitle: $("#progressTitle"), progressDetail: $("#progressDetail"), cancelButton: $("#cancelButton"), logOutput: $("#logOutput"),
  resultCard: $("#resultCard"), resultPreview: $("#resultPreview"), resultName: $("#resultName"),
  originalSize: $("#originalSize"), resultSize: $("#resultSize"), savingText: $("#savingText"), downloadButton: $("#downloadButton"),
  themeButton: $("#themeButton"), toast: $("#toast"),
};

const state = {
  file: null,
  kind: null,
  sourceURL: null,
  resultURL: null,
  dimensions: null,
  processing: false,
  cancelled: false,
  bridge: null,
  coreURLs: null,
  toastTimer: null,
};

class FFmpegBridge {
  constructor() {
    this.worker = new Worker(new URL("./ffmpeg-worker.js", import.meta.url), { type: "module" });
    this.nextId = 1;
    this.pending = new Map();
    this.logListeners = new Set();
    this.progressListeners = new Set();
    this.worker.onmessage = ({ data }) => {
      if (data.event === "log") {
        this.logListeners.forEach((fn) => fn(data.data));
        return;
      }
      if (data.event === "progress") {
        this.progressListeners.forEach((fn) => fn(data.data));
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else {
        const error = new Error(data.error?.message || "FFmpeg 执行失败。");
        error.name = data.error?.name || "Error";
        error.stack = data.error?.stack || error.stack;
        pending.reject(error);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "FFmpeg Worker 发生错误。");
      this.pending.forEach(({ reject }) => reject(error));
      this.pending.clear();
    };
  }

  request(action, payload = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, action, payload }, transfer);
    });
  }

  onLog(fn) { this.logListeners.add(fn); }
  onProgress(fn) { this.progressListeners.add(fn); }
  load(coreURL, wasmURL) { return this.request("load", { coreURL, wasmURL }); }
  writeFile(path, data) { return this.request("writeFile", { path, data }, [data.buffer]); }
  exec(args, timeout = -1) { return this.request("exec", { args, timeout }); }
  readFile(path) { return this.request("readFile", { path }); }
  deleteFile(path) { return this.request("deleteFile", { path }); }
  terminate() {
    this.worker.terminate();
    const error = new Error("转换已取消。");
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function extensionOf(name) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function classifyFile(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  const ext = extensionOf(file.name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function sanitizeBaseName(name) {
  const stem = name.replace(/\.[^.]+$/, "") || "output";
  return stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 110);
}

function outputNameFor(file) {
  const ext = extensionOf(file.name);
  const base = sanitizeBaseName(file.name);
  return ext === "webp" ? `${base}_converted.webp` : `${base}.webp`;
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 4200);
}

function setProgress(percent, title, detail = "") {
  const safe = Math.max(0, Math.min(100, Math.round(percent)));
  elements.progressPercent.textContent = `${safe}%`;
  elements.progressBar.style.width = `${safe}%`;
  elements.progressTitle.textContent = title;
  elements.progressDetail.textContent = detail;
}

function appendLog(message) {
  if (!message) return;
  const lines = elements.logOutput.textContent.split("\n").filter(Boolean);
  lines.push(message);
  elements.logOutput.textContent = lines.slice(-100).join("\n");
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function settings() {
  return {
    maxEdge: Number(elements.maxEdge.value), quality: Number(elements.quality.value),
    allowUpscale: elements.allowUpscale.checked, lossless: elements.lossless.checked,
    fps: Number(elements.fps.value), loop: Number(elements.loop.value), compression: Number(elements.compression.value),
  };
}

function saveSettings() {
  try { localStorage.setItem("webp-studio-settings", JSON.stringify(settings())); } catch { /* ignore */ }
}

function applySettings(values = DEFAULT_SETTINGS) {
  elements.maxEdge.value = String(values.maxEdge ?? DEFAULT_SETTINGS.maxEdge);
  elements.quality.value = String(values.quality ?? DEFAULT_SETTINGS.quality);
  elements.allowUpscale.checked = Boolean(values.allowUpscale ?? DEFAULT_SETTINGS.allowUpscale);
  elements.lossless.checked = Boolean(values.lossless ?? DEFAULT_SETTINGS.lossless);
  elements.fps.value = String(values.fps ?? DEFAULT_SETTINGS.fps);
  elements.loop.value = String(values.loop ?? DEFAULT_SETTINGS.loop);
  elements.compression.value = String(values.compression ?? DEFAULT_SETTINGS.compression);
  updateSettingLabels();
  updateEngineHint();
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("webp-studio-settings") || "null");
    applySettings(stored || DEFAULT_SETTINGS);
  } catch { applySettings(DEFAULT_SETTINGS); }
}

function updateSettingLabels() {
  elements.qualityValue.value = elements.quality.value;
  elements.qualityValue.textContent = elements.quality.value;
  elements.compressionValue.value = elements.compression.value;
  elements.compressionValue.textContent = elements.compression.value;
}

function updateEngineHint() {
  if (state.kind === "video") {
    elements.engineHint.textContent = "首次转换视频时会下载约 31 MiB 的 FFmpeg 核心，之后浏览器可复用缓存。";
  } else if (state.kind === "image" && elements.lossless.checked) {
    elements.engineHint.textContent = "无损图片将使用 FFmpeg 编码，因此首次转换需下载约 31 MiB 核心。";
  } else {
    elements.engineHint.textContent = "图片将使用浏览器原生编码，无需下载 FFmpeg 核心。";
  }
}

function setBusy(busy) {
  state.processing = busy;
  for (const control of [elements.fileInput, elements.maxEdge, elements.quality, elements.allowUpscale, elements.lossless, elements.fps, elements.loop, elements.compression, elements.resetSettingsButton, elements.removeFileButton]) {
    control.disabled = busy;
  }
  elements.convertButton.disabled = busy || !state.file;
  elements.cancelButton.disabled = !busy;
  elements.convertButtonText.textContent = busy ? "正在转换…" : state.file ? (state.kind === "image" ? "转换为静态 WebP" : "转换为 WebP 动图") : "请先选择文件";
}

function clearResult() {
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  state.resultURL = null;
  elements.resultCard.hidden = true;
  elements.resultPreview.innerHTML = "";
  elements.downloadButton.removeAttribute("href");
}

function clearFile() {
  if (state.processing) return;
  if (state.sourceURL) URL.revokeObjectURL(state.sourceURL);
  state.sourceURL = null;
  state.file = null;
  state.kind = null;
  state.dimensions = null;
  elements.fileInput.value = "";
  elements.filePanel.hidden = true;
  elements.dropZone.hidden = false;
  elements.sourcePreview.innerHTML = "";
  elements.modeBadge.className = "mode-badge is-empty";
  elements.modeBadge.textContent = "等待文件";
  elements.videoSettings.hidden = false;
  elements.progressCard.hidden = true;
  clearResult();
  setBusy(false);
  updateEngineHint();
}

async function readMediaMetadata(file, kind, url) {
  if (kind === "image") {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, duration: null });
      image.onerror = () => resolve({ width: null, height: null, duration: null });
      image.src = url;
    });
  }
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration });
    video.onerror = () => resolve({ width: null, height: null, duration: null });
    video.src = url;
  });
}

async function handleFile(file) {
  if (!file) return;
  const kind = classifyFile(file);
  if (!kind) { showToast("无法识别该文件。请选择常见图片或视频格式。", true); return; }
  if (file.size > MAX_FILE_BYTES) { showToast(`文件为 ${formatBytes(file.size)}，超过 50 MiB 限制。`, true); return; }
  if (file.size === 0) { showToast("文件为空，无法转换。", true); return; }

  clearFile();
  state.file = file;
  state.kind = kind;
  state.sourceURL = URL.createObjectURL(file);
  elements.dropZone.hidden = true;
  elements.filePanel.hidden = false;
  elements.fileName.textContent = file.name;
  elements.fileType.textContent = file.type || extensionOf(file.name).toUpperCase() || "未知";
  elements.fileSize.textContent = formatBytes(file.size);
  elements.outputMode.textContent = kind === "image" ? "静态 WebP" : "WebP 动图";
  elements.modeBadge.className = `mode-badge is-${kind}`;
  elements.modeBadge.textContent = kind === "image" ? "图片 → 静态 WebP" : "视频 → WebP 动图";
  elements.videoSettings.hidden = kind !== "video";

  const preview = document.createElement(kind === "image" ? "img" : "video");
  preview.src = state.sourceURL;
  if (kind === "video") { preview.controls = true; preview.muted = true; preview.playsInline = true; }
  preview.alt = "源文件预览";
  elements.sourcePreview.replaceChildren(preview);

  state.dimensions = await readMediaMetadata(file, kind, state.sourceURL);
  const { width, height, duration } = state.dimensions;
  elements.fileDimensions.textContent = width && height ? `${width} × ${height}${duration && Number.isFinite(duration) ? ` · ${duration.toFixed(1)} 秒` : ""}` : "无法读取";
  clearResult();
  setBusy(false);
  updateEngineHint();
}

function scaledDimensions(width, height, maxEdge, allowUpscale) {
  if (!width || !height || maxEdge === 0) return { width, height };
  const currentMax = Math.max(width, height);
  if (!allowUpscale && currentMax <= maxEdge) return { width, height };
  const ratio = maxEdge / currentMax;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

async function convertImageWithCanvas(file, options) {
  setProgress(8, "读取图片", "正在解码源文件");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    bitmap = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("浏览器无法解码该图片格式。"));
      image.src = url;
    }).finally(() => URL.revokeObjectURL(url));
  }
  if (state.cancelled) throw new Error("转换已取消。");

  const sourceWidth = bitmap.width || bitmap.naturalWidth;
  const sourceHeight = bitmap.height || bitmap.naturalHeight;
  const target = scaledDimensions(sourceWidth, sourceHeight, options.maxEdge, options.allowUpscale);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d", { alpha: true, willReadFrequently: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close?.();
  setProgress(70, "编码静态 WebP", `${target.width} × ${target.height}`);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((result) => result ? resolve(result) : reject(new Error("当前浏览器不支持 WebP 编码。")), "image/webp", options.quality / 100);
  });
  if (blob.type !== "image/webp") throw new Error("当前浏览器未能生成 WebP 文件。");
  setProgress(100, "转换完成", "静态 WebP 已生成");
  return blob;
}

function buildScaleFilter(options, includePixelFormat) {
  const filters = [];
  if (options.maxEdge > 0) {
    const width = options.allowUpscale ? String(options.maxEdge) : `min(iw\\,${options.maxEdge})`;
    const height = options.allowUpscale ? String(options.maxEdge) : `min(ih\\,${options.maxEdge})`;
    filters.push(`scale=w='${width}':h='${height}':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:flags=lanczos`);
  }
  if (includePixelFormat) filters.push("format=pix_fmts=yuv420p");
  return filters.join(",");
}

async function fetchBlobURL(url, mimeType, onProgress) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    const blob = await response.blob();
    onProgress?.(blob.size, blob.size);
    return URL.createObjectURL(new Blob([blob], { type: mimeType }));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
}

async function ensureFFmpeg() {
  if (state.bridge && state.coreURLs) return state.bridge;
  let lastError;
  for (const source of CORE_SOURCES) {
    try {
      setProgress(2, "加载 FFmpeg", "下载核心脚本");
      const coreURL = await fetchBlobURL(`${source}/ffmpeg-core.js`, "text/javascript", (loaded, total) => {
        const ratio = total ? loaded / total : 0;
        setProgress(2 + ratio * 3, "加载 FFmpeg", `核心脚本 ${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}` : ""}`);
      });
      const wasmURL = await fetchBlobURL(`${source}/ffmpeg-core.wasm`, "application/wasm", (loaded, total) => {
        const ratio = total ? loaded / total : Math.min(loaded / (31 * 1024 * 1024), 1);
        setProgress(5 + ratio * 20, "加载 FFmpeg", `WebAssembly ${formatBytes(loaded)}${total ? ` / ${formatBytes(total)}` : ""}`);
      });
      if (state.cancelled) throw new Error("转换已取消。");
      const bridge = new FFmpegBridge();
      bridge.onLog(({ message }) => appendLog(message));
      bridge.onProgress(({ progress }) => {
        if (!state.processing || !Number.isFinite(progress)) return;
        setProgress(30 + Math.max(0, Math.min(1, progress)) * 62, "正在转码", `FFmpeg 处理进度 ${Math.round(progress * 100)}%`);
      });
      setProgress(26, "初始化 FFmpeg", "正在启动 WebAssembly");
      await bridge.load(coreURL, wasmURL);
      state.bridge = bridge;
      state.coreURLs = { coreURL, wasmURL };
      return bridge;
    } catch (error) {
      lastError = error;
      appendLog(`核心来源失败：${source} - ${error.message}`);
    }
  }
  throw new Error(`FFmpeg 核心加载失败：${lastError?.message || "网络连接异常"}`);
}

async function convertWithFFmpeg(file, kind, options) {
  const bridge = await ensureFFmpeg();
  if (state.cancelled) throw new Error("转换已取消。");
  const inputExt = extensionOf(file.name) || (kind === "image" ? "png" : "mp4");
  const inputPath = `input_${Date.now()}.${inputExt}`;
  const outputPath = `output_${Date.now()}.webp`;
  setProgress(28, "读取文件", `写入浏览器内存 · ${formatBytes(file.size)}`);
  const inputData = new Uint8Array(await file.arrayBuffer());
  await bridge.writeFile(inputPath, inputData);

  let args;
  if (kind === "video") {
    const filter = [`fps=fps=${options.fps}:round=near`, buildScaleFilter(options, true)].filter(Boolean).join(",");
    args = [
      "-nostdin", "-y", "-hide_banner", "-i", inputPath, "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", filter, "-fps_mode", "passthrough", "-c:v", "libwebp_anim",
      "-lossless", options.lossless ? "1" : "0", "-quality", String(options.quality),
      "-compression_level", String(options.compression), "-loop", String(options.loop), "-f", "webp", outputPath,
    ];
  } else {
    const filter = buildScaleFilter(options, false);
    args = ["-nostdin", "-y", "-hide_banner", "-i", inputPath, "-map", "0:v:0", "-frames:v", "1"];
    if (filter) args.push("-vf", filter);
    args.push("-c:v", "libwebp", "-lossless", options.lossless ? "1" : "0", "-quality", String(options.quality), "-compression_level", String(options.compression), "-f", "webp", outputPath);
  }

  appendLog(`ffmpeg ${args.join(" ")}`);
  setProgress(30, kind === "video" ? "正在生成 WebP 动图" : "正在生成无损 WebP", "FFmpeg WebAssembly 正在处理");
  const code = await bridge.exec(args);
  if (code !== 0) throw new Error(`FFmpeg 转换失败，退出码：${code}`);
  setProgress(94, "读取输出", "正在整理生成文件");
  const output = await bridge.readFile(outputPath);
  await Promise.allSettled([bridge.deleteFile(inputPath), bridge.deleteFile(outputPath)]);
  if (!output || output.byteLength === 0) throw new Error("FFmpeg 未生成有效的 WebP 文件。");
  setProgress(100, "转换完成", kind === "video" ? "WebP 动图已生成" : "静态 WebP 已生成");
  return new Blob([output], { type: "image/webp" });
}

function showResult(blob) {
  clearResult();
  state.resultURL = URL.createObjectURL(blob);
  const name = outputNameFor(state.file);
  const image = new Image();
  image.src = state.resultURL;
  image.alt = "WebP 输出预览";
  elements.resultPreview.replaceChildren(image);
  elements.resultName.textContent = name;
  elements.originalSize.textContent = formatBytes(state.file.size);
  elements.resultSize.textContent = formatBytes(blob.size);
  const ratio = state.file.size ? ((blob.size / state.file.size - 1) * 100) : 0;
  elements.savingText.textContent = ratio <= 0 ? `体积减少 ${Math.abs(ratio).toFixed(1)}%。文件仅在本地生成。` : `输出体积增加 ${ratio.toFixed(1)}%。可降低质量、尺寸或帧率。`;
  elements.downloadButton.href = state.resultURL;
  elements.downloadButton.download = name;
  elements.resultCard.hidden = false;
  elements.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function startConversion() {
  if (!state.file || state.processing) return;
  state.cancelled = false;
  elements.logOutput.textContent = "";
  elements.progressCard.hidden = false;
  clearResult();
  setBusy(true);
  setProgress(0, "准备转换", "检查文件和设置");
  saveSettings();

  try {
    const options = settings();
    let blob;
    if (state.kind === "image" && !options.lossless) blob = await convertImageWithCanvas(state.file, options);
    else blob = await convertWithFFmpeg(state.file, state.kind, options);
    if (state.cancelled) throw new Error("转换已取消。");
    showResult(blob);
    showToast(state.kind === "image" ? "静态 WebP 转换完成。" : "WebP 动图转换完成。");
  } catch (error) {
    if (state.cancelled || /取消/.test(error.message)) {
      setProgress(0, "已取消", "可以重新开始转换");
      showToast("转换已取消。");
    } else {
      setProgress(0, "转换失败", error.message);
      appendLog(error.stack || error.message);
      showToast(error.message || "转换失败。", true);
    }
  } finally {
    setBusy(false);
  }
}

function cancelConversion() {
  if (!state.processing) return;
  state.cancelled = true;
  if (state.bridge) {
    state.bridge.terminate();
    state.bridge = null;
  }
  if (state.coreURLs) {
    URL.revokeObjectURL(state.coreURLs.coreURL);
    URL.revokeObjectURL(state.coreURLs.wasmURL);
    state.coreURLs = null;
  }
  setBusy(false);
  setProgress(0, "已取消", "FFmpeg 将在下次转换时重新加载");
}

function initializeTheme() {
  const stored = localStorage.getItem("webp-studio-theme");
  const initial = stored || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.dataset.theme = initial;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("webp-studio-theme", next);
}

for (const event of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(event, (e) => { e.preventDefault(); elements.dropZone.classList.add("is-dragging"); });
}
for (const event of ["dragleave", "drop"]) {
  elements.dropZone.addEventListener(event, (e) => { e.preventDefault(); elements.dropZone.classList.remove("is-dragging"); });
}
elements.dropZone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files?.[0]));
elements.dropZone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); elements.fileInput.click(); } });
elements.fileInput.addEventListener("change", () => handleFile(elements.fileInput.files?.[0]));
elements.removeFileButton.addEventListener("click", clearFile);
elements.convertButton.addEventListener("click", startConversion);
elements.cancelButton.addEventListener("click", cancelConversion);
elements.themeButton.addEventListener("click", toggleTheme);
elements.resetSettingsButton.addEventListener("click", () => { applySettings(DEFAULT_SETTINGS); saveSettings(); showToast("已恢复默认设置。"); });
for (const control of [elements.maxEdge, elements.quality, elements.allowUpscale, elements.lossless, elements.fps, elements.loop, elements.compression]) {
  control.addEventListener("input", () => { updateSettingLabels(); updateEngineHint(); saveSettings(); });
}
window.addEventListener("beforeunload", () => {
  if (state.sourceURL) URL.revokeObjectURL(state.sourceURL);
  if (state.resultURL) URL.revokeObjectURL(state.resultURL);
  if (state.bridge) state.bridge.terminate();
  if (state.coreURLs) { URL.revokeObjectURL(state.coreURLs.coreURL); URL.revokeObjectURL(state.coreURLs.wasmURL); }
});

initializeTheme();
loadSettings();
setBusy(false);
