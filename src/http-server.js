import 'dotenv/config';
import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';
import { registerMorningTools } from './tools/morning.js';

const PORT = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  process.stderr.write('ERREUR: MCP_AUTH_TOKEN non défini. Définissez cette variable dans .env ou votre environnement.\n');
  process.stderr.write('Exemple: MCP_AUTH_TOKEN=' + randomUUID() + '\n');
  process.exit(1);
}

const SERVER_OPTIONS = {
  name: 'tradingview',
  version: '2.0.0',
  description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
};

function createMcpServer() {
  const server = new McpServer(SERVER_OPTIONS);
  registerHealthTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerCaptureTools(server);
  registerDrawingTools(server);
  registerAlertTools(server);
  registerBatchTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerWatchlistTools(server);
  registerUiTools(server);
  registerPaneTools(server);
  registerTabTools(server);
  registerMorningTools(server);
  return server;
}

// sessionId → transport
const sessions = new Map();

function checkAuth(req) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Bearer ')) {
    return header.slice(7) === AUTH_TOKEN;
  }
  // Also accept token as query param (for quick testing only)
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return url.searchParams.get('token') === AUTH_TOKEN;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? JSON.parse(text) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  setCors(res);

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check — sans auth (utile pour Cloudflare Tunnel / monitoring)
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'tradingview-mcp', version: '2.0.0' }));
    return;
  }

  // Toutes les autres routes nécessitent le token
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized. Set Authorization: Bearer <MCP_AUTH_TOKEN>' }));
    return;
  }

  if (url.pathname === '/mcp') {
    const sessionId = req.headers['mcp-session-id'];

    // DELETE → fermer la session
    if (req.method === 'DELETE' && sessionId) {
      const transport = sessions.get(sessionId);
      if (transport) {
        await transport.close();
        sessions.delete(sessionId);
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Requête sur une session existante
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId);
      try {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    // Nouvelle session (POST d'initialisation sans session ID)
    if (req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          process.stderr.write(`[MCP] Session ouverte: ${id}\n`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          process.stderr.write(`[MCP] Session fermée: ${id}\n`);
        },
      });

      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);

      try {
        const body = await readBody(req);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
      return;
    }

    // GET sur /mcp sans session = SSE standalone (notifications proactives)
    if (req.method === 'GET') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
        onsessionclosed: (id) => sessions.delete(id),
      });
      const mcpServer = createMcpServer();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', endpoints: ['/health', '/mcp'] }));
});

httpServer.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`\n⚡ TradingView MCP HTTP Server démarré\n`);
  process.stderr.write(`   Écoute sur : http://127.0.0.1:${PORT}\n`);
  process.stderr.write(`   Endpoint   : http://127.0.0.1:${PORT}/mcp\n`);
  process.stderr.write(`   Health     : http://127.0.0.1:${PORT}/health\n`);
  process.stderr.write(`\n   → Pour exposer via Cloudflare Tunnel:\n`);
  process.stderr.write(`     cloudflared tunnel --url http://127.0.0.1:${PORT}\n\n`);
  process.stderr.write(`⚠  Outil non officiel. Non affilié à TradingView Inc. ou Anthropic.\n\n`);
});

httpServer.on('error', (err) => {
  process.stderr.write(`Erreur serveur HTTP: ${err.message}\n`);
  process.exit(1);
});
