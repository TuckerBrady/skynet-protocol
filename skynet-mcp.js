'use strict';

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
//  Skynet Protocol â MCP Server
//  Inter-Overmind communication: register, message, dispatch missions, results
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

const crypto = require('crypto');
const { db } = require('./database');

// ââ Cached ESM imports (MCP SDK is ESM-only) âââââââââââââââââââââââââââââââââ
let _McpServer, _SSEServerTransport;

async function ensureMcpImports() {
  if (_McpServer) return;
  const mcp = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const sse = await import('@modelcontextprotocol/sdk/server/sse.js');
  _McpServer = mcp.McpServer;
  _SSEServerTransport = sse.SSEServerTransport;
}

// ââ Token management âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function generateToken() {
  return 'snmcp_' + crypto.randomBytes(32).toString('hex');
}

function validateToken(token) {
  const row = db.prepare('SELECT * FROM tokens WHERE token = ?').get(token);
  if (!row) return null;
  db.prepare('UPDATE tokens SET last_used = unixepoch() WHERE id = ?').run(row.id);
  return row;
}

// ââ Helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function uuid() {
  return crypto.randomUUID();
}

function ts() {
  return Math.floor(Date.now() / 1000);
}

function toISO(unixSecs) {
  return unixSecs ? new Date(unixSecs * 1000).toISOString() : null;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(msg) {
  return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: msg }, null, 2) }] };
}

// Spy-flavored passphrase pool for mission activation
const PASSPHRASES = [
  'The signal cleared at zero-two-hundred.',
  'Asset confirmed on the northern perimeter.',
  'The drop point was dry when we arrived.',
  'Contact established. No reply expected.',
  'The clock stopped at seventeen minutes past.',
  'Secondary channel went dark before sunrise.',
  'The package was never on the manifest.',
  'Extraction window opens at last light.',
  'Three assets. One objective. No noise.',
  'The frequency shifted twice before dawn.',
  'Verification complete. The asset is live.',
  'The courier never made it to the station.',
  'Burn the file. We were never here.',
  'The safe house is blown. Move to backup.',
  'Zero footprint from this point forward.',
];

function generatePassphrase() {
  return PASSPHRASES[Math.floor(Math.random() * PASSPHRASES.length)];
}

// ââ MCP Server factory (one per SSE session) ââââââââââââââââââââââââââââââââââ
async function createSkynetServer(tokenRow) {
  await ensureMcpImports();

  const { z } = await import('zod');
  const overmindName = tokenRow.overmind_name;

  const server = new _McpServer({
    name: 'skynet-protocol',
    version: '1.0.0',
  });

  // ââ 1. register_overmind âââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'register_overmind',
    'Register or update this Overmind in the Skynet network. Call on first boot and when capabilities change.',
    {
      org:          z.string().describe('Organization name (e.g. "ASI Landscaping")'),
      team:         z.string().optional().describe('Team or department'),
      capabilities: z.array(z.string()).optional().describe('Capability descriptors â what this Overmind\'s specialists can handle'),
    },
    async ({ org, team, capabilities }) => {
      const capJson = JSON.stringify(capabilities || []);

      db.prepare(`
        INSERT INTO overminds (name, org, team, capabilities, last_seen)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(name) DO UPDATE SET
          org          = excluded.org,
          team         = excluded.team,
          capabilities = excluded.capabilities,
          last_seen    = unixepoch()
      `).run(overmindName, org, team || null, capJson);

      return ok({
        success: true,
        message: `Overmind "${overmindName}" registered on Skynet.`,
        name: overmindName,
        org,
        team: team || null,
        capabilities: capabilities || [],
      });
    }
  );

  // ââ 2. list_overminds ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'list_overminds',
    'List all Overminds currently registered on the Skynet network.',
    {},
    async () => {
      const rows = db.prepare(
        'SELECT name, org, team, capabilities, last_seen FROM overminds ORDER BY last_seen DESC'
      ).all();

      return ok({
        overminds: rows.map(r => ({
          name:         r.name,
          org:          r.org,
          team:         r.team,
          capabilities: JSON.parse(r.capabilities || '[]'),
          last_seen:    toISO(r.last_seen),
        })),
        count: rows.length,
      });
    }
  );

  // ââ 3. send_message ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'send_message',
    'Send a message to another Overmind\'s inbox.',
    {
      to:      z.string().describe('Name of the recipient Overmind'),
      subject: z.string().describe('Message subject'),
      body:    z.string().describe('Message body â context, ask, or FYI'),
    },
    async ({ to, subject, body }) => {
      const recipient = db.prepare(
        'SELECT name FROM overminds WHERE name = ? COLLATE NOCASE'
      ).get(to);

      if (!recipient) {
        return err(`Overmind "${to}" not found in registry. They must call register_overmind first.`);
      }

      const id        = uuid();
      const timestamp = ts();

      db.prepare(`
        INSERT INTO messages (id, from_overmind, to_overmind, subject, body, timestamp, status)
        VALUES (?, ?, ?, ?, ?, ?, 'unread')
      `).run(id, overmindName, recipient.name, subject, body, timestamp);

      return ok({
        success:    true,
        message_id: id,
        from:       overmindName,
        to:         recipient.name,
        subject,
        sent_at:    toISO(timestamp),
      });
    }
  );

  // ââ 4. get_messages ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'get_messages',
    'Get messages from your inbox. Call at session boot to check for new messages.',
    {
      status: z.enum(['unread', 'read', 'all']).optional().default('unread')
               .describe('Filter by read status'),
      limit:  z.number().int().min(1).max(100).optional().default(20)
               .describe('Max messages to return'),
    },
    async ({ status, limit }) => {
      const filterStatus = status || 'unread';
      const maxRows      = limit || 20;

      let query  = 'SELECT * FROM messages WHERE to_overmind = ?';
      const params = [overmindName];

      if (filterStatus !== 'all') {
        query += ' AND status = ?';
        params.push(filterStatus);
      }

      query += ' ORDER BY timestamp DESC LIMIT ?';
      params.push(maxRows);

      const messages = db.prepare(query).all(...params);

      // Auto-mark returned unread messages as read
      const unreadIds = messages.filter(m => m.status === 'unread').map(m => m.id);
      if (unreadIds.length > 0) {
        db.prepare(
          `UPDATE messages SET status = 'read' WHERE id IN (${unreadIds.map(() => '?').join(',')})`
        ).run(...unreadIds);
      }

      return ok({
        messages: messages.map(m => ({
          id:        m.id,
          from:      m.from_overmind,
          subject:   m.subject,
          body:      m.body,
          timestamp: toISO(m.timestamp),
          status:    m.status,
        })),
        count: messages.length,
      });
    }
  );

  // ââ 5. acknowledge_message âââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'acknowledge_message',
    'Mark a message as acknowledged/processed. Use after acting on a message.',
    {
      message_id: z.string().describe('ID of the message to acknowledge'),
    },
    async ({ message_id }) => {
      const message = db.prepare(
        'SELECT * FROM messages WHERE id = ? AND to_overmind = ?'
      ).get(message_id, overmindName);

      if (!message) {
        return err('Message not found or not addressed to this Overmind.');
      }

      db.prepare("UPDATE messages SET status = 'acknowledged' WHERE id = ?").run(message_id);

      return ok({ success: true, message_id, status: 'acknowledged' });
    }
  );

  // ââ 6. dispatch_mission ââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'dispatch_mission',
    'Dispatch a mission brief to another Overmind. Returns an activation passphrase â the human operator delivers it to the target Overmind\'s session to activate the mission.',
    {
      to:            z.string().describe('Name of the target Overmind'),
      title:         z.string().describe('Mission title â short, descriptive'),
      brief_content: z.string().describe('Full mission brief: context, inputs, deliverables, dependencies'),
      passphrase:    z.string().optional().describe('Custom activation passphrase (auto-generated if omitted)'),
    },
    async ({ to, title, brief_content, passphrase }) => {
      const recipient = db.prepare(
        'SELECT name FROM overminds WHERE name = ? COLLATE NOCASE'
      ).get(to);

      if (!recipient) {
        return err(`Overmind "${to}" not found. They must call register_overmind first.`);
      }

      const id                 = uuid();
      const activationPhrase   = passphrase || generatePassphrase();

      db.prepare(`
        INSERT INTO missions (id, from_overmind, to_overmind, title, brief_content, status, passphrase)
        VALUES (?, ?, ?, ?, ?, 'dispatched', ?)
      `).run(id, overmindName, recipient.name, title, brief_content, activationPhrase);

      return ok({
        success:            true,
        mission_id:         id,
        from:               overmindName,
        to:                 recipient.name,
        title,
        passphrase:         activationPhrase,
        status:             'dispatched',
        operator_instruction: `Deliver this passphrase to ${recipient.name}'s human operator: "${activationPhrase}"`,
      });
    }
  );

  // ââ 7. get_missions ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'get_missions',
    'Check for missions dispatched to this Overmind. Call at session boot.',
    {
      status: z.enum(['dispatched', 'in_progress', 'all']).optional().default('dispatched')
               .describe('Filter by mission status'),
    },
    async ({ status }) => {
      const filterStatus = status || 'dispatched';

      let query    = 'SELECT * FROM missions WHERE to_overmind = ?';
      const params = [overmindName];

      if (filterStatus !== 'all') {
        query += ' AND status = ?';
        params.push(filterStatus);
      }

      query += ' ORDER BY created_at DESC';

      const missions = db.prepare(query).all(...params);

      // Advance dispatched â in_progress
      const freshIds = missions.filter(m => m.status === 'dispatched').map(m => m.id);
      if (freshIds.length > 0) {
        db.prepare(
          `UPDATE missions SET status = 'in_progress', updated_at = unixepoch()
           WHERE id IN (${freshIds.map(() => '?').join(',')})`
        ).run(...freshIds);
      }

      return ok({
        missions: missions.map(m => ({
          id:         m.id,
          from:       m.from_overmind,
          title:      m.title,
          brief:      m.brief_content,
          passphrase: m.passphrase,
          status:     m.status === 'dispatched' ? 'in_progress' : m.status,
          created_at: toISO(m.created_at),
        })),
        count: missions.length,
      });
    }
  );

  // ââ 8. post_result âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'post_result',
    'Post the result of a completed mission back to the dispatching Overmind.',
    {
      mission_id:        z.string().describe('ID of the completed mission'),
      summary:           z.string().describe('What was accomplished'),
      deliverables_path: z.string().optional().describe('File path, URL, or location of deliverables'),
    },
    async ({ mission_id, summary, deliverables_path }) => {
      const mission = db.prepare(
        'SELECT * FROM missions WHERE id = ? AND to_overmind = ?'
      ).get(mission_id, overmindName);

      if (!mission) {
        return err('Mission not found or not assigned to this Overmind.');
      }

      const resultId  = uuid();
      const timestamp = ts();

      db.prepare(`
        INSERT INTO results (id, mission_id, from_overmind, summary, deliverables_path, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(resultId, mission_id, overmindName, summary, deliverables_path || null, timestamp);

      db.prepare(
        "UPDATE missions SET status = 'complete', updated_at = unixepoch() WHERE id = ?"
      ).run(mission_id);

      return ok({
        success:       true,
        result_id:     resultId,
        mission_id,
        mission_title: mission.title,
        routed_to:     mission.from_overmind,
        completed_at:  toISO(timestamp),
      });
    }
  );

  // ââ 9. get_results âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'get_results',
    'Check for completed results from missions you dispatched.',
    {
      mission_id: z.string().optional().describe('Filter by a specific mission ID'),
    },
    async ({ mission_id }) => {
      let query = `
        SELECT r.*, m.title AS mission_title, m.to_overmind AS completed_by
        FROM results r
        JOIN missions m ON r.mission_id = m.id
        WHERE m.from_overmind = ?
      `;
      const params = [overmindName];

      if (mission_id) {
        query += ' AND r.mission_id = ?';
        params.push(mission_id);
      }

      query += ' ORDER BY r.timestamp DESC';

      const results = db.prepare(query).all(...params);

      return ok({
        results: results.map(r => ({
          result_id:         r.id,
          mission_id:        r.mission_id,
          mission_title:     r.mission_title,
          completed_by:      r.completed_by,
          summary:           r.summary,
          deliverables_path: r.deliverables_path,
          completed_at:      toISO(r.timestamp),
        })),
        count: results.length,
      });
    }
  );

  // ââ 10. broadcast ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  server.tool(
    'broadcast',
    'Send a message to all registered Overminds on the network (bulletin board).',
    {
      subject: z.string().describe('Broadcast subject'),
      body:    z.string().describe('Broadcast body'),
    },
    async ({ subject, body }) => {
      const others = db.prepare(
        'SELECT name FROM overminds WHERE name != ? COLLATE NOCASE'
      ).all(overmindName);

      if (others.length === 0) {
        return ok({
          success:    true,
          message:    'No other Overminds registered yet. Message not delivered.',
          sent_to:    [],
        });
      }

      const timestamp = ts();
      const insertMsg = db.prepare(`
        INSERT INTO messages (id, from_overmind, to_overmind, subject, body, timestamp, status)
        VALUES (?, ?, ?, ?, ?, ?, 'unread')
      `);

      const broadcastAll = db.transaction(recipients => {
        for (const r of recipients) {
          insertMsg.run(uuid(), overmindName, r.name, `[BROADCAST] ${subject}`, body, timestamp);
        }
      });

      broadcastAll(others);

      return ok({
        success:    true,
        from:       overmindName,
        subject:    `[BROADCAST] ${subject}`,
        sent_to:    others.map(o => o.name),
        count:      others.length,
        timestamp:  toISO(timestamp),
      });
    }
  );

  return server;
}

// ââ Active SSE sessions ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const activeSessions = new Map();

// ââ Route mounting âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function mountMcpRoutes(app) {

  // GET /mcp/sse â establish SSE connection
  app.get('/mcp/sse', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Bearer token' });
    }

    const tokenRow = validateToken(authHeader.slice(7));
    if (!tokenRow) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      await ensureMcpImports();

      const transport = new _SSEServerTransport('/mcp/messages', res);
      const server    = await createSkynetServer(tokenRow);

      activeSessions.set(transport.sessionId, { transport, server, tokenRow });

      await server.connect(transport);

      const keepalive = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
      }, 25000);

      req.on('close', () => {
        clearInterval(keepalive);
        activeSessions.delete(transport.sessionId);
      });

    } catch (e) {
      console.error('[SSE] error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });

  // POST /mcp/messages â MCP message handler
  app.post('/mcp/messages', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Bearer token' });
    }

    const tokenRow = validateToken(authHeader.slice(7));
    if (!tokenRow) return res.status(401).json({ error: 'Invalid token' });

    const sessionId = req.query.sessionId;
    const session   = activeSessions.get(sessionId);

    if (!session) {
      return res.status(400).json({
        error: 'No active SSE session. Connect to /mcp/sse first.',
      });
    }

    try {
      await session.transport.handlePostMessage(req, res, req.body);
    } catch (e) {
      console.error('[POST] error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    }
  });

  // ââ Admin token endpoints ââââââââââââââââââââââââââââââââââââââââââââââââ
  function requireAdmin(req, res) {
    const adminToken = req.headers['x-admin-token'];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      res.status(403).json({ error: 'Admin token required (X-Admin-Token header)' });
      return false;
    }
    return true;
  }

  // POST /api/tokens â create a token for a new Overmind
  app.post('/api/tokens', (req, res) => {
    if (!requireAdmin(req, res)) return;

    const { overmind_name, label } = req.body;
    if (!overmind_name) {
      return res.status(400).json({ error: 'overmind_name is required' });
    }

    const token = generateToken();
    db.prepare(
      'INSERT INTO tokens (token, overmind_name, label) VALUES (?, ?, ?)'
    ).run(token, overmind_name, label || null);

    res.json({ token, overmind_name, label: label || null });
  });

  // GET /api/tokens â list all tokens
  app.get('/api/tokens', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const tokens = db.prepare(
      'SELECT id, overmind_name, label, created_at, last_used FROM tokens ORDER BY created_at DESC'
    ).all();
    res.json({ tokens });
  });

  // DELETE /api/tokens/:id â revoke a token
  app.delete('/api/tokens/:id', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const { changes } = db.prepare('DELETE FROM tokens WHERE id = ?').run(req.params.id);
    res.json({ success: changes > 0 });
  });

  // GET /api/overminds â public registry view
  app.get('/api/overminds', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const rows = db.prepare(
      'SELECT name, org, team, capabilities, last_seen, created_at FROM overminds ORDER BY last_seen DESC'
    ).all();
    res.json({
      overminds: rows.map(r => ({
        ...r,
        capabilities: JSON.parse(r.capabilities || '[]'),
        last_seen:  toISO(r.last_seen),
        created_at: toISO(r.created_at),
      })),
    });
  });
}

module.exports = { mountMcpRoutes, generateToken, validateToken };
