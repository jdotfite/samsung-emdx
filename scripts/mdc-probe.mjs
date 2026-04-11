#!/usr/bin/env node

/**
 * MDC Command Probe — discovers which commands a Samsung Art Frame supports.
 *
 * Usage:
 *   node scripts/mdc-probe.mjs --host 192.168.4.244 --pin 000000
 *   node scripts/mdc-probe.mjs --host 192.168.4.244 --pin 000000 --command 0xC7
 *   node scripts/mdc-probe.mjs --host 192.168.4.244 --pin 000000 --range 0x00-0xFF
 */

import net from "node:net";
import tls from "node:tls";

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const HOST = getArg("host", "");
const PIN = getArg("pin", "000000");
const SINGLE_CMD = getArg("command", "");
const RANGE = getArg("range", "");
const TIMEOUT_MS = parseInt(getArg("timeout", "3000"), 10);

if (!HOST) {
  console.error("Usage: node scripts/mdc-probe.mjs --host <ip> --pin <pin> [--command 0xNN] [--range 0x00-0xFF] [--timeout 3000]");
  process.exit(1);
}

const HEADER = 0xAA;
const RESPONSE = 0xFF;
const DISPLAY_ID = 0;

// Known Samsung MDC command IDs (from spec + library)
const KNOWN_COMMANDS = {
  0x00: "Status",
  0x01: "Video Mute",
  0x02: "Audio Mute",
  0x03: "Input Source",
  0x04: "Volume",
  0x05: "Contrast",
  0x06: "Brightness",
  0x07: "Sharpness",
  0x08: "OSD",
  0x09: "Clock",
  0x0A: "Timer",
  0x0B: "Serial Number",
  0x0C: "Speaker",
  0x0D: "Model Name",
  0x0E: "Software Version",
  0x0F: "Temperature",
  0x10: "Lamp Control",
  0x11: "Power State",
  0x12: "Auto Power",
  0x13: "Sleep Timer",
  0x14: "MDC Connection",
  0x15: "Safety Lock",
  0x19: "Color Tone",
  0x1A: "Color Temperature",
  0x1B: "Battery State",
  0x34: "Network Config",
  0x44: "Virtual Remote",
  0x60: "MagicInfo Server",
  0x62: "OSD Display",
  0x63: "Panel On/Off",
  0x64: "Screen Size",
  0x65: "Auto Adjustment",
  0x67: "Device Name",
  0x6E: "Touch Control",
  0x80: "Display Mode",
  0x89: "USB Content List",
  0xA1: "Launcher URL / Content Info",
  0xA4: "Content Schedule",
  0xB5: "Current Source Info",
  0xC0: "Content Status",
  0xC1: "Content List",
  0xC7: "Content Download / EMDX",
  0xD0: "Player Control",
  0xD6: "Device Info",
  0xE0: "Art Mode Status",
  0xE1: "Art Mode Content",
  0xE2: "Art Mode Slideshow",
  0xE5: "Art Mode Current Image",
  0xE6: "Art Mode Content List",
};

function buildPacket(commandId, data = []) {
  const payload = [commandId, DISPLAY_ID, data.length, ...data];
  const checksum = payload.reduce((sum, b) => sum + b, 0) % 256;
  return Buffer.from([HEADER, ...payload, checksum]);
}

function hexByte(n) {
  return "0x" + n.toString(16).toUpperCase().padStart(2, "0");
}

function formatPayload(buf) {
  if (!buf || buf.length === 0) return "(empty)";
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const printable = [...buf].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
  return `[${buf.length} bytes] ${hex}  "${printable}"`;
}

async function connectMDC(host, pin) {
  return new Promise((resolve, reject) => {
    const tcp = net.connect({ host, port: 1515, rejectUnauthorized: false });
    tcp.on("data", (data) => {
      if (`${data}` === "MDCSTART<<TLS>>") {
        const tlsConn = tls.connect({ socket: tcp, rejectUnauthorized: false }, (err) => {
          if (err) return reject(err);
          tlsConn.write(Buffer.from(pin), (writeErr) => {
            if (writeErr) return reject(writeErr);
          });
        });

        tlsConn.on("data", (tlsData) => {
          if (`${tlsData}` === "MDCAUTH<<PASS>>") {
            return resolve({ tcp, tls: tlsConn });
          }
          if (`${tlsData}`.startsWith("MDCAUTH<<FAIL")) {
            return reject(new Error(`Auth failed: ${tlsData}`));
          }
          // Otherwise it's a command response — handled elsewhere
        });
        tlsConn.once("error", reject);
      }
    });
    tcp.on("error", reject);
    tcp.once("close", () => reject(new Error("Connection closed")));
  });
}

async function sendProbe(conn, commandId, subData = []) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.tls.removeListener("data", handler);
      resolve({ commandId, result: "TIMEOUT", payload: null });
    }, TIMEOUT_MS);

    function handler(data) {
      if (data[0] !== HEADER || data[1] !== RESPONSE) return;

      clearTimeout(timer);
      conn.tls.removeListener("data", handler);

      const ackOrNak = data[4];
      const cmdIdResp = data[5];
      const length = data[3];
      const payload = data.slice(6, 6 + length - 2);

      if (ackOrNak === 0x41) {
        resolve({ commandId: cmdIdResp, result: "ACK", payload });
      } else if (ackOrNak === 0x4E) {
        resolve({ commandId: cmdIdResp, result: "NAK", payload });
      } else {
        resolve({ commandId: cmdIdResp, result: `UNKNOWN(${hexByte(ackOrNak)})`, payload });
      }
    }

    conn.tls.on("data", handler);
    conn.tls.write(buildPacket(commandId, subData));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`\nConnecting to ${HOST}:1515 with PIN ${PIN}...\n`);
  const conn = await connectMDC(HOST, PIN);
  console.log("Connected and authenticated.\n");

  let commandsToProbe = [];

  if (SINGLE_CMD) {
    commandsToProbe = [parseInt(SINGLE_CMD, 16)];
  } else if (RANGE) {
    const [start, end] = RANGE.split("-").map((s) => parseInt(s.trim(), 16));
    for (let i = start; i <= end; i++) commandsToProbe.push(i);
  } else {
    // Probe all known interesting commands
    commandsToProbe = Object.keys(KNOWN_COMMANDS).map(Number);
  }

  console.log(`Probing ${commandsToProbe.length} command(s)...\n`);
  console.log("CMD     RESULT   NAME                            PAYLOAD");
  console.log("─".repeat(90));

  const acked = [];

  for (const cmdId of commandsToProbe) {
    const result = await sendProbe(conn, cmdId);
    const name = KNOWN_COMMANDS[cmdId] || "";
    const symbol = result.result === "ACK" ? "✓" : result.result === "NAK" ? "✗" : "?";
    const line = `${hexByte(cmdId)}    ${symbol} ${result.result.padEnd(8)} ${name.padEnd(32)} ${result.payload ? formatPayload(result.payload) : ""}`;
    console.log(line);

    if (result.result === "ACK") {
      acked.push({ cmdId, name, payload: result.payload });
    }

    await sleep(150); // Small delay between commands to not overwhelm the frame
  }

  console.log("\n" + "─".repeat(90));
  console.log(`\nACKed commands (${acked.length}):`);
  for (const { cmdId, name, payload } of acked) {
    console.log(`  ${hexByte(cmdId)} ${name.padEnd(32)} ${formatPayload(payload)}`);
  }

  // Deep probe: try sub-commands on content-related commands that ACKed
  const contentCmds = acked.filter((c) => [0xC7, 0xC0, 0xC1, 0xA1, 0xE0, 0xE1, 0xE5, 0xE6].includes(c.cmdId));
  if (contentCmds.length) {
    console.log("\n\nDeep-probing content commands with sub-command bytes...\n");
    for (const { cmdId, name } of contentCmds) {
      console.log(`  ${hexByte(cmdId)} ${name}:`);
      for (let sub = 0x00; sub <= 0xFF; sub++) {
        const result = await sendProbe(conn, cmdId, [sub]);
        if (result.result === "ACK") {
          console.log(`    sub ${hexByte(sub)}: ACK  ${formatPayload(result.payload)}`);
        }
        await sleep(100);
      }
    }
  }

  console.log("\nDone. Disconnecting.");
  conn.tls.end();
  conn.tcp.end();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
