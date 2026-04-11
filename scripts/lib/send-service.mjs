import path from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Device } from "@weejewel/samsung-mdc";
import { buildSamsungArgs, getSamsungEmdxBin, sendImageToSamsungDisplay } from "./samsung-emdx.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWakeOnLan(device) {
  if (!device?.mac) {
    return false;
  }

  const client = new Device({
    host: device.host,
    pin: device.pin,
    mac: device.mac
  });

  await client.wakeup();
  return true;
}

async function sendImageReliably({ imagePath, device, onEvent }) {
  const pushEvent = (event) => {
    onEvent?.(event);
  };

  let woke = false;
  if (device.mac) {
    woke = await sendWakeOnLan(device);
    if (woke) {
      pushEvent({
        type: "wake_sent",
        message: "Wake-on-LAN sent.",
        at: new Date().toISOString()
      });
      await sleep(1000);
    }
  }

  const sendResult = await sendImageToSamsungDisplay({
    imagePath,
    device,
    onEvent: pushEvent,
    lingerMs: 0,
    fetchTimeoutMs: 30000
  });

  if (!sendResult.verified.imageFetched) {
    pushEvent({
      type: "unverified",
      message: sendResult.verified.contentJsonFetched
        ? "Frame fetched content.json but did not complete the image download."
        : "Frame never requested content.json or the image."
          ,
      at: new Date().toISOString()
    });
  }

  return {
    woke,
    retried: false,
    verified: sendResult.verified,
    events: sendResult.events
  };
}

async function sendWithImagePaths({ screens, resolveImagePath, dryRun = false, onProgress }) {
  const results = [];

  for (const screen of screens) {
    const imagePath = await resolveImagePath(screen);
    await access(imagePath, fsConstants.R_OK);

    if (!screen.device?.host || !screen.device?.pin) {
      throw new Error(`Screen "${screen.id}" is missing required device.host or device.pin`);
    }

    const cliArgs = buildSamsungArgs({ imagePath, device: screen.device });
    const command = `${process.execPath} ${getSamsungEmdxBin()} ${cliArgs.join(" ")}`;

    let delivery = {
      woke: false,
      retried: false
    };

    if (!dryRun) {
      try {
        delivery = await sendImageReliably({
          imagePath,
          device: screen.device,
          onEvent: (event) => onProgress?.(screen, event)
        });
      } catch (error) {
        onProgress?.(screen, {
          type: "failed",
          message: error.message,
          at: new Date().toISOString()
        });
        throw error;
      }
    }

    results.push({
      screenId: screen.id,
      imagePath,
      host: screen.device.host,
      dryRun,
      command,
      delivery
    });
  }

  return results;
}

export async function sendScreens({
  screens,
  outputDir = path.join(process.cwd(), "output"),
  dryRun = false,
  onProgress
}) {
  return sendWithImagePaths({
    screens,
    dryRun,
    resolveImagePath: async (screen) => path.join(outputDir, `${screen.id}.png`),
    onProgress
  });
}

export async function sendImageToScreens({
  screens,
  imagePath,
  dryRun = false,
  onProgress
}) {
  return sendWithImagePaths({
    screens,
    dryRun,
    resolveImagePath: async () => imagePath,
    onProgress
  });
}
