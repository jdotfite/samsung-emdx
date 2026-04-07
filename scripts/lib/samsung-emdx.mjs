import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "../../server/env.mjs";

export function getSamsungEmdxBin(cwd = process.cwd()) {
  if (env.samsungEmdxBin) {
    return path.isAbsolute(env.samsungEmdxBin)
      ? env.samsungEmdxBin
      : path.join(cwd, env.samsungEmdxBin);
  }
  return path.join(cwd, "node_modules", "@weejewel", "samsung-emdx", "bin", "index.mjs");
}

export function buildSamsungArgs({ imagePath, device }) {
  const args = [
    "show-image",
    "--host",
    device.host,
    "--pin",
    device.pin,
    "--image",
    imagePath
  ];

  if (device.mac) {
    args.push("--mac", device.mac);
  }

  if (device.localIp || env.defaultLocalIp) {
    args.push("--local-ip", device.localIp || env.defaultLocalIp);
  }

  return args;
}

function parseSamsungLine(line) {
  if (!line) {
    return null;
  }

  if (line.includes("Starting HTTP server")) {
    return { type: "http_server_start", message: line };
  }
  if (line.includes("HTTP server listening")) {
    return { type: "http_server_ready", message: line };
  }
  if (line.includes("Waking up device")) {
    return { type: "waking_start", message: line };
  }
  if (line.includes("Device woken up")) {
    return { type: "wake_done", message: line };
  }
  if (line.includes("Connecting")) {
    return { type: "connecting_start", message: line };
  }
  if (line.includes("Connected")) {
    return { type: "connected", message: line };
  }
  if (line.includes("Setting content to")) {
    return { type: "setting_content", message: line };
  }
  if (line.includes("Content set")) {
    return { type: "content_set", message: line };
  }
  if (line.includes("Serving /content.json")) {
    return { type: "content_json_requested", message: line };
  }
  if (line.includes("Served /content.json")) {
    return { type: "content_json_served", message: line };
  }
  if (line.includes("Serving /image")) {
    return { type: "image_requested", message: line };
  }
  if (line.includes("Served /image")) {
    return { type: "image_served", message: line };
  }

  return { type: "log", message: line };
}

export async function sendImageToSamsungDisplay({ imagePath, device, cwd = process.cwd(), timeoutMs = 45000, onEvent }) {
  const binPath = getSamsungEmdxBin(cwd);
  const args = [binPath, ...buildSamsungArgs({ imagePath, device })];
  const rawLines = [];
  const parsedEvents = [];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let settled = false;

    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      error.events = parsedEvents;
      error.rawLines = rawLines;
      reject(error);
    };

    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const emitLine = (line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed) {
        return;
      }
      rawLines.push(trimmed);
      const parsed = parseSamsungLine(trimmed);
      if (!parsed) {
        return;
      }
      const event = {
        ...parsed,
        at: new Date().toISOString()
      };
      parsedEvents.push(event);
      onEvent?.(event);
    };

    const bindStream = (stream) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        lines.forEach(emitLine);
      });
      stream.on("end", () => {
        if (buffer.trim()) {
          emitLine(buffer);
        }
      });
    };

    bindStream(child.stdout);
    bindStream(child.stderr);

    const timeout = setTimeout(() => {
      child.kill();
      finishReject(new Error(`Samsung EMDX sender timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        finishResolve();
        return;
      }
      finishReject(new Error(`Samsung EMDX sender exited with code ${code}`));
    });
  });

  return {
    events: parsedEvents,
    rawLines,
    verified: {
      contentJsonFetched: parsedEvents.some((event) => event.type === "content_json_served"),
      imageFetched: parsedEvents.some((event) => event.type === "image_served")
    }
  };
}
