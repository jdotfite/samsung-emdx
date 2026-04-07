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

export async function getDeviceStatus(deviceConfig) {
  const device = sanitizeDeviceConfig(deviceConfig);
  const probe = await probeDeviceHost(device.host);

  if (!probe.reachable) {
    return {
      ...probe,
      powerState: null,
      deviceName: "",
      serialNumber: "",
      softwareVersion: "",
      battery: null
    };
  }

  if (!device.pin) {
    return {
      ...probe,
      powerState: null,
      deviceName: "",
      serialNumber: "",
      softwareVersion: "",
      battery: null,
      error: "Device PIN is not configured."
    };
  }

  const client = new Device({
    host: device.host,
    pin: device.pin,
    mac: device.mac
  });

  try {
    await client.connect();
    const powerStateResult = await Promise.allSettled([client.getPowerState()]);
    const [deviceNameResult, serialResult, versionResult, batteryResult] = await Promise.allSettled([
      client.getDeviceName(),
      client.getSerialNumber(),
      client.getSoftwareVersion(),
      client.getBatteryState()
    ]);

    const powerStateError = powerStateResult[0].status === "rejected" ? powerStateResult[0].reason : null;
    const powerStateErrorMessage = powerStateError?.message === "NAK"
      ? "Power state not exposed by this frame."
      : powerStateError?.message || "";

    return {
      ...probe,
      powerState: powerStateResult[0].status === "fulfilled" ? powerStateResult[0].value : "",
      mdcConnected: true,
      deviceName: deviceNameResult.status === "fulfilled" ? deviceNameResult.value : "",
      serialNumber: serialResult.status === "fulfilled" ? serialResult.value : "",
      softwareVersion: versionResult.status === "fulfilled" ? versionResult.value : "",
      battery: batteryResult.status === "fulfilled" ? batteryResult.value : null,
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
