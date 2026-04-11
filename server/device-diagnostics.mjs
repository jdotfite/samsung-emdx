import net from "node:net";
import { Device } from "@weejewel/samsung-mdc";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeDeviceConfig(device = {}) {
  return {
    host: String(device.host || "").trim(),
    pin: String(device.pin || "").trim(),
    mac: String(device.mac || "").trim(),
    localIp: String(device.localIp || "").trim()
  };
}

function createProbeResult({ reachable, latencyMs = null, error = "" }) {
  return {
    reachable,
    latencyMs,
    error,
    checkedAt: new Date().toISOString()
  };
}

export async function probeDeviceHost(host, port = 1515, timeoutMs = 2500) {
  const normalizedHost = String(host || "").trim();
  if (!normalizedHost) {
    return createProbeResult({
      reachable: false,
      error: "Device host is not configured."
    });
  }

  const startedAt = Date.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finish(
        createProbeResult({
          reachable: true,
          latencyMs: Date.now() - startedAt
        }),
      );
    });
    socket.once("timeout", () => {
      finish(
        createProbeResult({
          reachable: false,
          error: `Timed out connecting to ${normalizedHost}:${port}.`
        }),
      );
    });
    socket.once("error", (error) => {
      finish(
        createProbeResult({
          reachable: false,
          error: error.message
        }),
      );
    });

    socket.connect(port, normalizedHost);
  });
}

async function safeCommand(client, commandId, data = []) {
  try {
    return { ok: true, payload: await client.sendCommand({ commandId, data }) };
  } catch {
    return { ok: false, payload: null };
  }
}

const SOURCE_NAMES = {
  0x00: "Art Mode",
  0x01: "TV",
  0x02: "HDMI",
  0x03: "HDMI 1",
  0x04: "HDMI 2",
  0x05: "USB",
  0x09: "URL Launcher",
  0x0A: "MagicInfo",
  0x0B: "Screen Mirroring",
  0x20: "Media Player",
  0x21: "Signage Player"
};

function parseSourcePayload(payload) {
  if (!payload || payload.length < 1) return null;
  const code = payload[0];
  return {
    code,
    label: SOURCE_NAMES[code] || `Unknown (0x${code.toString(16).padStart(2, "0")})`
  };
}

export async function getDeviceStatus(deviceConfig) {
  const device = sanitizeDeviceConfig(deviceConfig);
  const probe = await probeDeviceHost(device.host);

  const emptyResult = {
    ...probe,
    powerState: null,
    deviceName: "",
    serialNumber: "",
    softwareVersion: "",
    battery: null,
    source: null
  };

  if (!probe.reachable) {
    return emptyResult;
  }

  if (!device.pin) {
    return { ...emptyResult, error: "Device PIN is not configured." };
  }

  const client = new Device({
    host: device.host,
    pin: device.pin,
    mac: device.mac
  });

  try {
    await client.connect();
    const [powerStateResult, deviceNameResult, serialResult, versionResult, batteryResult, sourceResult] = await Promise.allSettled([
      client.getPowerState(),
      client.getDeviceName(),
      client.getSerialNumber(),
      client.getSoftwareVersion(),
      client.getBatteryState(),
      client.sendCommand({ commandId: 0xB5 })
    ]);

    const powerStateError = powerStateResult.status === "rejected" ? powerStateResult.reason : null;
    const powerStateErrorMessage = powerStateError?.message && powerStateError.message !== "NAK"
      ? powerStateError.message
      : "";

    return {
      ...probe,
      powerState: powerStateResult.status === "fulfilled" ? powerStateResult.value : "",
      mdcConnected: true,
      deviceName: deviceNameResult.status === "fulfilled" ? deviceNameResult.value : "",
      serialNumber: serialResult.status === "fulfilled" ? serialResult.value : "",
      softwareVersion: versionResult.status === "fulfilled" ? versionResult.value : "",
      battery: batteryResult.status === "fulfilled" ? batteryResult.value : null,
      source: sourceResult.status === "fulfilled" ? parseSourcePayload(sourceResult.value) : null,
      error: powerStateErrorMessage
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}


export async function wakeDevice(deviceConfig) {
  const device = sanitizeDeviceConfig(deviceConfig);
  if (!device.mac) {
    throw new Error("Device MAC is not configured.");
  }

  const client = new Device({
    host: device.host,
    pin: device.pin,
    mac: device.mac
  });

  await client.wakeup({ mac: device.mac });
  await sleep(1800);

  const probe = await probeDeviceHost(device.host);
  return {
    ok: true,
    host: device.host,
    mac: device.mac,
    wokeAt: new Date().toISOString(),
    probe
  };
}
