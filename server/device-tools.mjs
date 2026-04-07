import net from "node:net";
import { Device } from "@weejewel/samsung-mdc";

function createMdcDevice(device) {
  return new Device({
    host: device.host,
    mac: device.mac,
    pin: device.pin
  });
}

async function probeTcp(host, port = 1515, timeoutMs = 1500) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      cleanup();
      resolve();
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error("Timed out"));
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

export async function wakeSamsungDevice(device) {
  if (!device.mac) {
    throw new Error("Device MAC is required for Wake-on-LAN.");
  }

  const mdc = createMdcDevice(device);
  await mdc.wakeup({ mac: device.mac });
  return {
    woke: true,
    host: device.host,
    mac: device.mac,
    sentAt: new Date().toISOString()
  };
}

export async function getSamsungDeviceStatus(device) {
  const status = {
    host: device.host,
    checkedAt: new Date().toISOString(),
    reachable: false,
    powerState: null,
    deviceName: null,
    serialNumber: null,
    error: null
  };

  try {
    await probeTcp(device.host);
    status.reachable = true;
  } catch {}

  const mdc = createMdcDevice(device);

  try {
    status.powerState = await mdc.getPowerState();
  } catch (error) {
    status.error = error.message;
  }

  try {
    status.deviceName = await mdc.getDeviceName();
  } catch {}

  try {
    status.serialNumber = await mdc.getSerialNumber();
  } catch {}

  try {
    await mdc.disconnect();
  } catch {}

  return status;
}
