# PRIVATE.CHAT — Backend

Real-time anonymous chat. **Zero npm dependencies.** Uses only Node.js 22 built-ins.

## Stack

| Layer     | Tech                              |
|-----------|-----------------------------------|
| HTTP      | `node:http` (built-in)            |
| WebSocket | Manual WS handshake over `net`    |
| Database  | `node:sqlite` (built-in, Node 22) |
| Frontend  | Vanilla HTML/CSS/JS               |

## Requirements

- **Node.js >= 22.5.0** (for `node:sqlite`)

## Run

```bash
npm start
# or directly:
node --experimental-sqlite server.js
```

Open → http://localhost:3000

## File Structure

```
private-chat/
├── server.js      # Backend: HTTP + WebSocket + SQLite
├── index.html     # Frontend (served by server.js)
├── package.json
├── README.md
└── chat.db        # Auto-created on first run
```

## API

### WebSocket Messages (Client → Server)

| type      | payload                         | description            |
|-----------|---------------------------------|------------------------|
| `join`    | `{ username }`                  | Join chat room         |
| `message` | `{ message }`                   | Send a message         |
| `typing`  | —                               | Broadcast typing event |
| `rename`  | `{ newName }`                   | Change username        |

### WebSocket Messages (Server → Client)

| type      | payload                                      | description              |
|-----------|----------------------------------------------|--------------------------|
| `history` | `{ messages: [{username, message, createdDate}] }` | Last 50 messages on join |
| `message` | `{ username, message, createdDate }`         | New message broadcast    |
| `system`  | `{ text }`                                   | Join/leave/rename notice |
| `online`  | `{ count }`                                  | Online user count        |
| `typing`  | `{ username }`                               | Someone is typing        |

### REST

| Endpoint      | Description             |
|---------------|-------------------------|
| `GET /`       | Serve index.html        |
| `GET /api/history` | Last 50 messages (JSON) |
| `GET /api/online`  | Current online count    |

## Privacy

- ❌ No IP address stored
- ❌ No session tokens
- ❌ No cookies server-side
- ✅ Username saved to browser `localStorage` only
- ✅ Messages stored: `username`, `message`, `createdDate` only
- ✅ Auto-purges messages > 500 on startup

## Deploy (VPS / Docker)

```bash
# Simple
PORT=80 node --experimental-sqlite server.js

# With PM2
pm2 start server.js --node-args="--experimental-sqlite" --name private-chat

# Behind nginx (reverse proxy ws://)
# Add to nginx config:
# location / { proxy_pass http://localhost:3000; proxy_http_version 1.1;
#   proxy_set_header Upgrade $http_upgrade;
#   proxy_set_header Connection "upgrade"; }
```
