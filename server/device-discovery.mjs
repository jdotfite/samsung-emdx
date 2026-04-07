import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Device } from "@weejewel/samsung-mdc";
import { env } from "./env.mjs";

const execFileAsync = promisify(execFile);

function isPrivateIpv4(address) {
  return /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

function ipToInt(ip) {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

function intToIp(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

function netmaskToPrefix(netmask) {
  return netmask
    .split(".")
    .map((octet) => Number(octet).toString(2).padStart(8, "0"))
    .join("")
    .replace(/0+$/, "").length;
}

function getActiveInterface() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) {
        continue;
      }
      candidates.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        cidr: `${entry.address}/${netmaskToPrefix(entry.netmask)}`
      });
    }
  }

  if (!candidates.length) {
    throw new Error("No active private IPv4 interface found for discovery.");
  }

  if (env.defaultLocalIp) {
    const preferred = candidates.find((entry) => entry.address === env.defaultLocalIp);
    if (preferred) {
      return preferred;
    }
  }

  return candidates[0];
}

function enumerateHosts(address, netmask) {
  const ipInt = ipToInt(address);
  const maskInt = ipToInt(netmask);
  const network = (ipInt & maskInt) >>> 0;
  const broadcast = (network | (~maskInt >>> 0)) >>> 0;
  const hosts = [];

  for (let current = network + 1; current < broadcast; current += 1) {
    hosts.push(intToIp(current >>> 0));
  }

  return {
    subnet: intToIp(network >>> 0),
    broadcast: intToIp(broadcast >>> 0),
    hosts
  };
}

async function probeTcp(host, port = 1515, timeoutMs = 225) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reachable) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function readArpTable() {
  try {
    const { stdout } = await execFileAsync("arp", ["-a"], { windowsHide: true });
    const map = new Map();
    const pattern = /(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})/gi;
    let match;
    while ((match = pattern.exec(stdout))) {
      map.set(match[1], match[2].toLowerCase().replaceAll("-", ":"));
    }
    return map;
  } catch {
    return new Map();
  }
}

async function identifyDevice({ host, mac, candidatePins }) {
  const base = {
    host,
    mac,
    reachable: true,
    mdcConnected: false,
    detectedPin: "",
    deviceName: "",
    serialNumber: "",
    softwareVersion: "",
    battery: null
  };

  for (const pin of candidatePins) {
    const normalizedPin = String(pin || "").trim();
    if (!normalizedPin) {
      continue;
    }

    const client = new Device({
      host,
      mac,
      pin: normalizedPin
    });

    try {
      await client.connect();
      const [deviceName, serialNumber, softwareVersion, battery] = await Promise.all([
        client.getDeviceName().catch(() => ""),
        client.getSerialNumber().catch(() => ""),
        client.getSoftwareVersion().catch(() => ""),
        client.getBatteryState().catch(() => null)
      ]);

      return {
        ...base,
        mdcConnected: true,
        detectedPin: normalizedPin,
        deviceName,
        serialNumber,
        softwareVersion,
        battery
      };
    } catch {
      // Try next known PIN.
    } finally {
      await client.disconnect().catch(() => {});
    }
  }

  return base;
}

export async function discoverSamsungDevices({ project }) {
  const activeInterface = getActiveInterface();
  const { subnet, broadcast, hosts } = enumerateHosts(activeInterface.address, activeInterface.netmask);
  const candidatePins = [...new Set(project.screens.map((screen) => screen.device?.pin).filter(Boolean))];
  const scanHosts = hosts.filter((host) => host !== activeInterface.address);

  const reachableHosts = (await mapWithConcurrency(scanHosts, 96, async (host) => {
    const reachable = await probeTcp(host);
    return reachable ? host : null;
  })).filter(Boolean);

  const arpMap = await readArpTable();
  const results = await mapWithConcurrency(reachableHosts, 6, async (host) =>
    identifyDevice({
      host,
      mac: arpMap.get(host) || "",
      candidatePins
    }),
  );

  results.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));

  return {
    localIp: activeInterface.address,
    cidr: activeInterface.cidr,
    subnet,
    broadcast,
    results
  };
}
