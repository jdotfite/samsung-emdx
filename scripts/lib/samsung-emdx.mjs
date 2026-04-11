import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import express from "express";
import { Device } from "@weejewel/samsung-mdc";
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

function detectLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

function getLocalIp(device) {
  return device.localIp || env.defaultLocalIp || detectLanIp();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = "Operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

/**
 * In-process EMDX sender. Hosts a local HTTP server, connects via MDC,
 * issues setContentDownload, waits for the frame to fetch the image,
 * then lingers for a configurable period before shutting down.
 */
export async function sendImageToSamsungDisplay({
  imagePath,
  device,
  onEvent,
  lingerMs = 12000,
  fetchTimeoutMs = 15000
}) {
  const events = [];
  const rawLines = [];
  let contentJsonFetched = false;
  let imageFetched = false;

  const pushEvent = (type, message) => {
    const event = { type, message, at: new Date().toISOString() };
    events.push(event);
    rawLines.push(message);
    onEvent?.(event);
  };

  const localIp = getLocalIp(device);
  const fileId = crypto.randomUUID().toUpperCase();
  const fileSize = fs.statSync(imagePath).size;
  const fileExtension = path.extname(imagePath).slice(1) || "png";
  const fileName = `${fileId}.${fileExtension}`;

  // Start local HTTP server
  pushEvent("http_server_start", "Starting local HTTP server for frame fetch.");

  let serverPort = 0;

  const { server, port } = await new Promise((resolve, reject) => {
    const app = express();

    app.get("/content.json", (req, res) => {
      pushEvent("content_json_requested", "Serving /content.json to frame.");
      res.header("Content-Type", "application/json");
      res.send(
        JSON.stringify({
          schedule: [
            {
              start_date: "1970-01-01",
              stop_date: "2999-12-31",
              start_time: "00:00:00",
              contents: [
                {
                  image_url: `http://${localIp}:${serverPort}/image`,
                  file_id: fileId,
                  file_path: `/home/owner/content/Downloads/vxtplayer/epaper/mobile/contents/${fileId}/${fileName}`,
                  duration: 91326,
                  file_size: `${fileSize}`,
                  file_name: fileName
                }
              ]
            }
          ],
          name: "node-samsung-emdx",
          version: 1,
          create_time: "2025-01-01 00:00:00",
          id: fileId,
          program_id: "com.samsung.ios.ePaper",
          content_type: "ImageContent",
          deploy_type: "MOBILE"
        }).replaceAll("/", "\\/"),
      );

      req.once("close", () => {
        contentJsonFetched = true;
        pushEvent("content_json_served", "Served /content.json to frame.");
      });
    });

    app.get("/image", (req, res) => {
      pushEvent("image_requested", `Serving /image (${fileSize} bytes) to frame.`);
      res.type(fileExtension === "jpg" || fileExtension === "jpeg" ? "image/jpeg" : "image/png");
      res.sendFile(path.resolve(imagePath), (err) => {
        if (err) {
          pushEvent("image_serve_error", `Failed to serve image: ${err.message}`);
        } else {
          imageFetched = true;
          pushEvent("image_served", "Frame finished fetching the image.");
        }
      });
    });

    const listener = app.listen(0, () => {
      serverPort = listener.address().port;
      resolve({ server: listener, port: serverPort });
    });
    listener.on("error", reject);
  });

  pushEvent("http_server_ready", `HTTP server listening at http://${localIp}:${port}`);

  try {
    // MDC connect and set content
    pushEvent("connecting_start", `Connecting to ${device.host}:1515 via MDC.`);
    const mdc = new Device({ host: device.host, pin: device.pin, mac: device.mac });
    await withTimeout(mdc.connect(), 10000, "MDC connect");
    pushEvent("connected", "MDC connection established.");

    const contentUrl = `http://${localIp}:${port}/content.json`;
    pushEvent("setting_content", `Setting content download URL: ${contentUrl}`);
    await withTimeout(mdc.setContentDownload({ url: contentUrl }), 10000, "setContentDownload");
    await mdc.disconnect().catch(() => {});
    pushEvent("content_set", "Content download URL set on frame.");

    // Wait for the frame to fetch the image
    const fetchStart = Date.now();
    while (!imageFetched && Date.now() - fetchStart < fetchTimeoutMs) {
      await sleep(300);
    }

    // Linger so the frame can re-request if needed
    if (imageFetched && lingerMs > 0) {
      pushEvent("linger_start", `Image fetched. Keeping server alive for ${Math.round(lingerMs / 1000)}s in case frame re-requests.`);
      await sleep(lingerMs);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  return {
    events,
    rawLines,
    verified: {
      contentJsonFetched,
      imageFetched
    }
  };
}
