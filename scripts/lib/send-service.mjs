import path from "node:path";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { Device } from "@weejewel/samsung-mdc";
import { probeDeviceHost } from "../../server/device-diagnostics.mjs";
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

  await client.wakeup({ mac: device.mac });
  return true;
}

async function waitForDeviceReady(device, onEvent, { timeoutMs = 15000, intervalMs = 900, stableSuccesses = 2 } = {}) {
  const startedAt = Date.now();
  let consecutiveSuccesses = 0;

  onEvent?.({
    type: "wake_wait_start",
    message: "Waiting for frame to become reachable after wake.",
    at: new Date().toISOString()
  });

  while (Date.now() - startedAt < timeoutMs) {
    const probe = await probeDeviceHost(device.host, 1515, Math.min(2200, intervalMs));

    if (probe.reachable) {
      consecutiveSuccesses += 1;
      onEvent?.({
        type: consecutiveSuccesses >= stableSuccesses ? "wake_ready" : "wake_probe_success",
        message:
          consecutiveSuccesses >= stableSuccesses
            ? `Frame responded after wake (${probe.latencyMs ?? "?"} ms).`
            : `Frame probe succeeded (${probe.latencyMs ?? "?"} ms). Confirming stability...`,
        at: new Date().toISOString()
      });

      if (consecutiveSuccesses >= stableSuccesses) {
        return {
          ready: true,
          probe
        };
      }
    } else {
      consecutiveSuccesses = 0;
      onEvent?.({
        type: "wake_probe_retry",
        message: probe.error || "Frame still not reachable after wake.",
        at: new Date().toISOString()
      });
    }

    await sleep(intervalMs);
  }

  onEvent?.({
    type: "wake_wait_timeout",
    message: `Frame did not become stably reachable within ${timeoutMs}ms.`,
    at: new Date().toISOString()
  });

  return {
    ready: false,
    probe: null
  };
}

async function sendImageReliably({ imagePath, device, onEvent }) {
  let woke = false;
  let readyAfterWake = false;
  const events = [];
  let verified = {
    contentJsonFetched: false,
    imageFetched: false
  };

  const pushEvent = (event) => {
    events.push(event);
    onEvent?.(event);
  };

  if (device.mac) {
    try {
      pushEvent({ type: "wake_sent", message: "Wake-on-LAN sent.", at: new Date().toISOString() });
      woke = await sendWakeOnLan(device);
      if (woke) {
        const readiness = await waitForDeviceReady(device, pushEvent);
        readyAfterWake = readiness.ready;
      }
    } catch {
      woke = false;
    }
  }

  let sendResult = await sendImageToSamsungDisplay({
    imagePath,
    device,
    onEvent: pushEvent
  });
  verified = sendResult.verified;

  const shouldRetry = !verified.imageFetched;

  if (shouldRetry) {
    pushEvent({
      type: "attempt_retry",
      message: woke
        ? "Retrying send after wake because the first attempt did not verify."
        : "Retrying send because the first attempt did not verify.",
      at: new Date().toISOString()
    });
    await sleep(woke && readyAfterWake ? 900 : 2200);
    sendResult = await sendImageToSamsungDisplay({
      imagePath,
      device,
      onEvent: pushEvent
    });
    verified = {
      contentJsonFetched: verified.contentJsonFetched || sendResult.verified.contentJsonFetched,
      imageFetched: verified.imageFetched || sendResult.verified.imageFetched
    };
  }

  return {
    woke,
    readyAfterWake,
    retried: shouldRetry,
    verified,
    events
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
