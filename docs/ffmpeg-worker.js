let core = null;

function postEvent(type, data) {
  self.postMessage({ event: type, data });
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack || "" };
  }
  return { name: "Error", message: String(error), stack: "" };
}

async function loadCore({ coreURL, wasmURL }) {
  if (core) return false;
  const imported = await import(coreURL);
  const createFFmpegCore = imported.default;
  if (typeof createFFmpegCore !== "function") {
    throw new Error("无法加载 FFmpeg 核心模块。");
  }

  const config = { wasmURL, workerURL: "" };
  core = await createFFmpegCore({
    mainScriptUrlOrBlob: `${coreURL}#${btoa(JSON.stringify(config))}`,
  });

  core.setLogger((data) => postEvent("log", data));
  core.setProgress((data) => postEvent("progress", data));
  return true;
}

function execute({ args, timeout = -1 }) {
  if (!core) throw new Error("FFmpeg 尚未加载。");
  core.setTimeout(timeout);
  core.exec(...args);
  const code = core.ret;
  core.reset();
  return code;
}

self.onmessage = async ({ data }) => {
  const { id, action, payload = {} } = data;
  try {
    let result;
    switch (action) {
      case "load":
        result = await loadCore(payload);
        break;
      case "writeFile":
        if (!core) throw new Error("FFmpeg 尚未加载。");
        core.FS.writeFile(payload.path, payload.data);
        result = true;
        break;
      case "exec":
        result = execute(payload);
        break;
      case "readFile":
        if (!core) throw new Error("FFmpeg 尚未加载。");
        result = core.FS.readFile(payload.path);
        break;
      case "deleteFile":
        if (!core) throw new Error("FFmpeg 尚未加载。");
        try { core.FS.unlink(payload.path); } catch { /* 文件可能已不存在 */ }
        result = true;
        break;
      default:
        throw new Error(`未知操作：${action}`);
    }

    if (result instanceof Uint8Array) {
      self.postMessage({ id, ok: true, result }, [result.buffer]);
    } else {
      self.postMessage({ id, ok: true, result });
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: serializeError(error) });
  }
};
