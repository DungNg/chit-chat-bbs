/**
 * PRIVATE.CHAT — Backend Server
 * Stack: Node.js 22 (zero npm deps)
 *   - http (built-in)        → serve static HTML
 *   - node:sqlite (built-in) → persist messages
 *   - WebSocket (built-in)   → real-time messaging
 *
 * Privacy: no IP stored, no auth, no sessions server-side
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// DATABASE SETUP (node:sqlite built-in)
// ─────────────────────────────────────────────
const db = new DatabaseSync(path.join(__dirname, 'chat.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL,
    message     TEXT    NOT NULL,
    createdDate TEXT    NOT NULL
  );
  -- Keep only last 500 messages (cleanup on startup)
  DELETE FROM messages WHERE id NOT IN (
    SELECT id FROM messages ORDER BY id DESC LIMIT 500
  );
`);

const saveMessage = db.prepare(
  `INSERT INTO messages (username, message, createdDate) VALUES (?, ?, ?)`
);

const getRecent = db.prepare(
  `SELECT username, message, createdDate FROM messages ORDER BY id DESC LIMIT 50`
);

// ─────────────────────────────────────────────
// HTTP SERVER (serve index.html + REST API)
// ─────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // GET /api/history — last 50 messages (newest first → reverse for display)
  if (url.pathname === '/api/history') {
    const rows = getRecent.all().reverse();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }

  // GET /api/online — current online count
  if (url.pathname === '/api/online') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: uniqueOnlineCount() }));
    return;
  }

  // Serve index.html
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(htmlPath));
    } else {
      res.writeHead(404);
      res.end('index.html not found. Place it next to server.js');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ─────────────────────────────────────────────
// WEBSOCKET SERVER (Node 22 built-in)
// ─────────────────────────────────────────────
// Node 22 has global WebSocket client but NOT a WebSocket server built-in.
// We'll implement the WS handshake/framing manually using built-in 'net'
// via the HTTP server's 'upgrade' event.

import { createHash } from 'node:crypto';

const clients = new Map(); // socket → { username }

function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

/** Decode a single WebSocket frame → string (text frames only) */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  if (opcode === 8) return { type: 'close' };
  if (opcode !== 1) return null; // only text

  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;

  if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); offset = 4; }
  else if (payloadLen === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }

  if (buf.length < offset + (masked ? 4 : 0) + payloadLen) return null;

  let payload;
  if (masked) {
    const mask = buf.slice(offset, offset + 4); offset += 4;
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) payload[i] = buf[offset + i] ^ mask[i % 4];
  } else {
    payload = buf.slice(offset, offset + payloadLen);
  }
  return { type: 'text', data: payload.toString('utf8') };
}

/** Encode a string as a WebSocket text frame (server → client, unmasked) */
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function broadcast(data, excludeSocket = null) {
  const frame = encodeFrame(JSON.stringify(data));
  for (const [sock] of clients) {
    if (sock !== excludeSocket && !sock.destroyed) {
      try { sock.write(frame); } catch(_) {}
    }
  }
}

function sendTo(socket, data) {
  try { socket.write(encodeFrame(JSON.stringify(data))); } catch(_) {}
}

function uniqueOnlineCount() {
  const names = new Set();
  for (const [, client] of clients) {
    if (client.username) names.add(client.username.toLowerCase());
  }
  return names.size;
}

function broadcastOnlineCount() {
  broadcast({ type: 'online', count: uniqueOnlineCount() });
}

server.on('upgrade', (req, socket, head) => {
  if (req.headers['upgrade']?.toLowerCase() !== 'websocket') {
    socket.destroy(); return;
  }

  wsHandshake(req, socket);
  clients.set(socket, { username: null });
  broadcastOnlineCount();

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const frame = decodeFrame(buffer);
      if (!frame) break;

      // Advance buffer (re-parse length to know consumed bytes)
      const b1 = buffer[1];
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) { payloadLen = buffer.readUInt16BE(2); offset = 4; }
      else if (payloadLen === 127) { payloadLen = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const masked = (b1 & 0x80) !== 0;
      const total = offset + (masked ? 4 : 0) + payloadLen;
      if (buffer.length < total) break;
      buffer = buffer.slice(total);

      if (frame.type === 'close') { socket.destroy(); break; }
      if (!frame.data) continue;

      let msg;
      try { msg = JSON.parse(frame.data); } catch { continue; }

      const client = clients.get(socket);

      // ── JOIN ──
      if (msg.type === 'join') {
        const username = String(msg.username || '').slice(0, 20).trim();
        if (!username) continue;
        client.username = username;

        // Send history to the joining user
        const history = getRecent.all().reverse();
        sendTo(socket, { type: 'history', messages: history });

        // Notify everyone else
        broadcast({ type: 'system', text: `${username} joined` }, socket);
        broadcastOnlineCount();
        sendTo(socket, { type: 'online', count: uniqueOnlineCount() });
        console.log(`[JOIN] ${username}`);
      }

      // ── MESSAGE ──
      else if (msg.type === 'message') {
        if (!client.username) continue;
        const text = String(msg.message || '').slice(0, 500).trim();
        if (!text) continue;

        const createdDate = new Date().toISOString();
        // Persist to SQLite (no IP stored)
        saveMessage.run(client.username, text, createdDate);

        const payload = {
          type: 'message',
          username: client.username,
          message: text,
          createdDate,
        };
        // Send to ALL (including sender so they get server-confirmed timestamp)
        broadcast(payload);
        console.log(`[MSG] ${client.username}: ${text.slice(0, 60)}`);
      }

      // ── TYPING ──
      else if (msg.type === 'typing') {
        if (!client.username) continue;
        broadcast({ type: 'typing', username: client.username }, socket);
      }

      // ── RENAME ──
      else if (msg.type === 'rename') {
        if (!client.username) continue;
        const newName = String(msg.newName || '').slice(0, 20).trim();
        if (!newName || newName === client.username) continue;
        const oldName = client.username;
        client.username = newName;
        broadcast({ type: 'system', text: `${oldName} renamed to ${newName}` });
        console.log(`[RENAME] ${oldName} → ${newName}`);
      }
    }
  });

  socket.on('close', () => {
    const client = clients.get(socket);
    if (client?.username) {
      broadcast({ type: 'system', text: `${client.username} left` });
    }
    clients.delete(socket);
    broadcastOnlineCount();
  });

  socket.on('error', () => {
    clients.delete(socket);
    broadcastOnlineCount();
  });
});

server.listen(PORT, () => {
  console.log(`\n  PRIVATE.CHAT server running`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → WebSocket ws://localhost:${PORT}`);
  console.log(`  → DB: chat.db (SQLite)\n`);
});
