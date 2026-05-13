'use strict';

const express = require('express');
const { initDatabase } = require('./database');
const { mountMcpRoutes } = require('./skynet-mcp');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.set('trust proxy', 1);

initDatabase();
mountMcpRoutes(app);

app.get('/health', (_req, res) => {
  res.json({ status: 'okserver.js', service: 'skynet-protocol', version: '1.0.0', time: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.json({
    name: 'Skynet Protocol',
    description: 'Inter-Overmind communication network',
    version: '1.0.0',
    endpoints: {
      mcp_sse:      'GET  /mcp/sse       (Bearer token)',
      mcp_messages: 'POST /mcp/messages  (Bearer token + ?sessionId)',
      health:       'GET  /health',
      tokens:       'POST /api/tokens    (X-Admin-Token)',
      overminds:    'GET  /api/overminds (X-Admin-Token)',
    },
    tools: [
      'register_overmind', 'list_overminds',
      'send_message', 'get_messages', 'acknowledge_message',
      'dispatch_mission', 'get_missions',
      'post_result', 'get_results', 'broadcast',
    ],
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('Skynet Protocol online');
  console.log('  Port    :', PORT);
  console.log('  MCP SSE : http://localhost:' + PORT + '/mcp/sse');
  console.log('  Health  : http://localhost:' + PORT + '/health');
  console.log('');
  if (!process.env.ADMIN_TOKEN) console.warn('  ADMIN_TOKEN not set -- run: node setup.js');
});
