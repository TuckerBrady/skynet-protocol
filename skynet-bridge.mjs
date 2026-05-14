#!/usr/bin/env node
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
//  Skynet Protocol â stdio â SSE Bridge (client-side)
//
//  This is the local script that Claude Code spawns. It bridges Claude Code's
//  stdio-based MCP protocol to the remote Skynet SSE server.
//
//  Configure in ~/.claude.json:
//  {
//    "mcpServers": {
//      "skynet": {
//        "command": "node",
//        "args": ["/path/to/skynet-bridge.mjs"],
//        "env": {
//          "SKYNET_URL":   "http://your-skynet-host:3001",
//          "SKYNET_TOKEN": "snmcp_your_token_here"
//        }
//      }
//    }
//  }
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const SKYNET_URL   = process.env.SKYNET_URL;
const SKYNET_TOKEN = process.env.SKYNET_TOKEN;

if (!SKYNET_URL || !SKYNET_TOKEN) {
  process.stderr.write(
    '[skynet-bridge] ERROR: SKYNET_URL and SKYNET_TOKEN env vars are required\n'
  );
  process.exit(1);
}

const SSE_URL      = `${SKYNET_URL}/mcp/sse`;
const MESSAGES_URL = `${SKYNET_URL}/mcp/messages`;

// ââ Reconnect config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const MAX_RETRIES    = 30;
const BASE_DELAY_MS  = 1000;
const MAX_DELAY_MS   = 10000;
const BACKOFF_FACTOR = 1.5;

let retryCount      = 0;
let messageEndpoint = null;   // filled from SSE 'endpoint' event

// ââ Connect to Skynet SSE âââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function connect() {
  process.stderr.write(`[skynet-bridge] Connecting to ${SSE_URL}\n`);

  const response = await fetch(SSE_URL, {
    headers: {
      Authorization: `Bearer ${SKYNET_TOKEN}`,
      Accept:        'text/event-stream',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`SSE connect failed: HTTP ${response.status} â ${body}`);
  }

  retryCount = 0;   // reset on successful connect
  process.stderr.write('[skynet-bridge] Connected\n');

  const decoder = new TextDecoder();
  let   buffer  = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline;
    while ((newline = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, newline);
      buffer      = buffer.slice(newline + 2);

      const lines = block.split('\n');
      let   event = 'message';
      let   data  = '';

      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:'))  data  = line.slice(5).trim();
      }

      if (event === 'endpoint') {
        // Server tells us where to POST messages
        messageEndpoint = data.startsWith('http') ? data : `${SKYNET_URL}${data}`;
        process.stderr.write(`[skynet-bridge] Message endpoint: ${messageEndpoint}\n`);
        continue;
      }

      if (event === 'message' && data) {
        // Forward SSE message â stdout (Claude Code reads this)
        process.stdout.write(data + '\n');
      }
    }
  }
}

// ââ Read stdin â POST to Skynet âââââââââââââââââââââââââââââââââââââââââââââââ
process.stdin.setEncoding('utf8');

let stdinBuffer = '';
process.stdin.on('data', async chunk => {
  stdinBuffer += chunk;

  let newline;
  while ((newline = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);

    if (!line) continue;
    if (!messageEndpoint) {
      process.stderr.write('[skynet-bridge] Message endpoint not yet known â dropping message\n');
      continue;
    }

    try {
      const res = await fetch(messageEndpoint, {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${SKYNET_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: line,
      });

      if (!res.ok) {
        process.stderr.write(`[skynet-bridge] POST failed: HTTP ${res.status}\n`);
      }
    } catch (e) {
      process.stderr.write(`[skynet-bridge] POST error: ${e.message}\n`);
    }
  }
});

// ââ Reconnect loop ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function run() {
  while (true) {
    try {
      await connect();
      // If connect() returns cleanly, reconnect
      process.stderr.write('[skynet-bridge] SSE stream ended â reconnecting\n');
    } catch (e) {
      retryCount++;
      if (retryCount > MAX_RETRIES) {
        process.stderr.write(`[skynet-bridge] Max retries (${MAX_RETRIES}) exceeded. Exiting.\n`);
        process.exit(1);
      }

      const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, retryCount - 1), MAX_DELAY_MS);
      process.stderr.write(
        `[skynet-bridge] Connection error (attempt ${retryCount}/${MAX_RETRIES}): ${e.message}\n`
      );
      process.stderr.write(`[skynet-bridge] Retrying in ${Math.round(delay / 1000)}s\n`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

run();
