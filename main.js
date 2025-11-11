import https from 'https';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = __dirname;


const PORT = 443;
const TLS_CERT = process.env.TLS_CERT || '/etc/ssl/cloudflare/yapzac.crt';
const TLS_KEY  = process.env.TLS_KEY  || '/etc/ssl/cloudflare/yapzac.key';

let tlsOptions;
try {
  tlsOptions = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
} catch (e) {
  console.error('TLS files not found.\n cert:', TLS_CERT, '\n key :', TLS_KEY);
  process.exit(1);
}

/* ----- profanity filter (server) ----- */
const BAD_WORD_SOURCES = [
  'https://www.cs.cmu.edu/~biglou/resources/bad-words.txt',
  'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en'
];
const BAD_BASE = ['fuck','shit','ass','bitch','bastard','cunt','dick','cock','pussy','whore','slut','nigger','nigga','asshole','motherfucker','fucker','bullshit','douche','cocksucker','prick','wanker','twat','cum','jizz'];
const badWords = new Set(BAD_BASE.map(w=>w.toLowerCase()));
const TOKEN_RE = /\b([A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*)\b/g;
const normalizeWord = s => String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const censorBySet = t => t?.replace(TOKEN_RE, tok => badWords.has(normalizeWord(tok)) ? '*'.repeat(tok.length) : tok) ?? t;
async function loadBadWords(){let a=0;for(const u of BAD_WORD_SOURCES){try{const r=await fetch(u);if(!r.ok)throw new Error(r.status);for(const raw of (await r.text()).split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;const n=normalizeWord(line);if(!n||/^\d+$/.test(n)||n.length<2)continue;if(!badWords.has(n)){badWords.add(n);a++;}}}catch(e){console.error('Bad-words fetch failed:',u,e.message)}}console.log(`Profanity list active: ${badWords.size} words (loaded ${a}, fallback ${BAD_BASE.length})`)}
/* ------------------------------------ */

const channels = new Map();   // name -> {members, history, typing}
const clients  = new Map();   // ws -> {id, username, channels}
const DEFAULT_CHANNELS = ['general','tech','random'];
for (const n of DEFAULT_CHANNELS) channels.set(n, {members:new Set(),history:[],typing:new Set()});

/* HTTPS server */
const server = https.createServer(tlsOptions, (req, res) => {
  const { url, method, headers } = req;

  // Strict, no-inline JS; allow inline CSS if you still have it in HTML
  const csp = [
    `default-src 'self'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `connect-src 'self' wss:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`
  ].join('; ');

  const secHeaders = {
    'content-security-policy': csp,
    'strict-transport-security': 'max-age=31536000; includeSubDomains; preload',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()'
  };

  // --- API endpoints (unchanged behavior) ---
  if (method === 'GET' && url === '/channels') {
    res.writeHead(200, { ...secHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(JSON.stringify({ channels: [...channels.keys()] }));
    return;
  }

  if (method === 'GET' && url.startsWith('/debug/censor?text=')) {
    const q = decodeURIComponent(url.split('=')[1] || '');
    const cens = censorBySet(q);
    res.writeHead(200, { ...secHeaders, 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store' });
    res.end(JSON.stringify({ input:q, output:cens }));
    return;
  }

  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { ...secHeaders, 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  // --- Static files from /public ---
  const pathname = (url || '/').split('?')[0] || '/';
  let filePath = pathname === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, decodeURIComponent(pathname.replace(/^\/+/, '')));

  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(400, { ...secHeaders, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type =
      ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js'   ? 'text/javascript; charset=utf-8'
    : ext === '.css'  ? 'text/css; charset=utf-8'
    : ext === '.png'  ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.svg'  ? 'image/svg+xml'
    : 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { ...secHeaders, 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { ...secHeaders, 'content-type': type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch{} }
function broadcast(channel, obj){ const ch=channels.get(channel); if(!ch) return; for(const m of ch.members) send(m,obj); }
function sanitizeName(s){
  const base=String(s||'').trim().replace(/\s+/g,'-').replace(/[^a-zA-Z0-9-_]/g,'-').slice(0,32);
  const masked=censorBySet(base);
  return masked.replace(/\*/g,'-');
}
function sanitizeText(s){ const c=String(s||'').replace(/[\u0000-\u001f]/g,'').slice(0,2000); return censorBySet(c) }

wss.on('connection', (ws, req) => {
  const origin = req?.headers?.origin || '';
  const host = (req?.headers?.host || '').replace(/:443$/, '');
  const allowed = `https://${host}`;
  if (origin && origin !== allowed) {
    ws.close(1008, 'origin not allowed');
    return;
  }
  const id = randomUUID();
  clients.set(ws, { id, username:'', channels:new Set() });
  send(ws, { type:'welcome', id, channels:[...channels.keys()] });

  ws.on('message', (buf) => {
    let msg; try{ msg = JSON.parse(buf.toString()); }catch{ return }
    const user = clients.get(ws); if (!user) return;

    switch (msg.type) {
      case 'hello': {
        user.username = sanitizeName(msg.username) || ('user-' + id.slice(0,6));
        send(ws, { type:'ready', userId:id, username:user.username }); break;
      }
      case 'join': {
        const name = sanitizeName(msg.channel) || 'general';
        let ch = channels.get(name); if (!ch) { ch = {members:new Set(),history:[],typing:new Set()}; channels.set(name, ch) }
        if (!ch.members.has(ws)) {
          ch.members.add(ws); user.channels.add(name);
          send(ws, { type:'history', channel:name, messages:ch.history.slice(-100) });
          broadcast(name, { type:'system', channel:name, text:`${user.username} joined`, ts:Date.now() });
          if (ch.history.length===0 && ch.members.size===1 && !DEFAULT_CHANNELS.includes(name))
            for (const sock of wss.clients) send(sock, { type:'channels', channels:[...channels.keys()] });
        } break;
      }
      case 'leave': {
        const name = sanitizeName(msg.channel);
        const ch = channels.get(name); if (!ch) break;
        if (ch.members.delete(ws)) { user.channels.delete(name); ch.typing.delete(user.id);
          broadcast(name, { type:'system', channel:name, text:`${user.username} left`, ts:Date.now() }); }
        break;
      }
      case 'chat': {
        const name = sanitizeName(msg.channel), ch = channels.get(name);
        if (!ch || !user.channels.has(name)) break;
        const text = sanitizeText(msg.text); if (!text) break;
        const payload = { type:'chat', channel:name, from:{id, username:user.username}, text, ts:Date.now() };
        ch.history.push(payload); if (ch.history.length>1000) ch.history.shift();
        broadcast(name, payload); break;
      }
      case 'typing': {
        const name = sanitizeName(msg.channel), ch = channels.get(name); if (!ch || !user.channels.has(name)) break;
        const on = !!msg.isTyping; if (on) ch.typing.add(id); else ch.typing.delete(id);
        broadcast(name, { type:'typing', channel:name, userId:id, username:user.username, isTyping:on }); break;
      }
    }
  });

  ws.on('close', () => {
    const user = clients.get(ws);
    if (user) for (const name of user.channels) {
      const ch = channels.get(name); if (!ch) continue;
      ch.members.delete(ws); ch.typing.delete(user.id);
      broadcast(name, { type:'system', channel:name, text:`${user.username} left`, ts:Date.now() });
    }
    clients.delete(ws);
  });
});

loadBadWords().catch(()=>{});

server.on('error', (err) => { console.error('Server error:', err); process.exit(1); });
server.listen(PORT, () => logUrls(PORT));

function logUrls(port){
  const urls = [`https://localhost:${port}`];
  const ifaces = os.networkInterfaces();
  for (const dev of Object.values(ifaces)) for (const adr of (dev||[])) if (adr && adr.family==='IPv4' && !adr.internal) urls.push(`https://${adr.address}:${port}`);
  console.log('\nDiscord-Alt running on:'); for (const u of urls) console.log('  ' + u); console.log('\nHit Ctrl+C to stop.');
}
