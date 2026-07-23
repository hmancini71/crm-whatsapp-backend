// Fuso horário OBRIGATÓRIO do Brasil (GMT-3) para TODO o backend — antes de qualquer uso de Date.
// Assim, toda hora/data gerada no servidor (horas das mensagens, logs, agregações) fica em Brasília,
// independentemente do fuso do servidor (Hetzner costuma ser UTC).
process.env.TZ = 'America/Sao_Paulo';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { runQuery, getRow, allRows, isGoogleAdsUtm, extractAdParams, getOriginMsgRules, setOriginMsgRules, reclassifyLeadsByFirstMsg } = require('./db');
const { getIntegrationSettings, saveIntegrationSettings, newApiKey, sendWebhook } = require('./webhook');
const { getAiSettings, saveAiSettings, callGemini, getFollowUpReply } = require('./ai');
const { getCalendlySettings, saveCalendlySettings, testCalendly, calendlySweep } = require('./calendly');
const antiban = require('./antiban'); // governador anti-banimento (caps, warm-up, pacing, horário, variação)
const {
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  processNovoBacklog,
  initSessions,
  sessionQrs,
  sessionPairCodes,
  sessions,
  MEDIA_DIR, sendWhatsAppMedia,
  editWhatsAppMessage, deleteWhatsAppMessage,
  avatarFileForJid, fetchAndStoreAvatar } = require('./whatsapp');

// Redirect console logs to an in-memory buffer
const logBuffer = [];
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function addLog(level, args) {
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    return typeof a === 'object' ? JSON.stringify(a) : String(a);
  }).join(' ');
  logBuffer.push(`[${level}] ${new Date().toISOString()} - ${msg}`);
  if (logBuffer.length > 1000) logBuffer.shift();
}

console.log = (...args) => {
  addLog('LOG', args);
  originalLog.apply(console, args);
};

console.error = (...args) => {
  addLog('ERROR', args);
  originalError.apply(console, args);
};

console.warn = (...args) => {
  addLog('WARN', args);
  originalWarn.apply(console, args);
};

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'leadsdpi_secret_key_123!';

app.use(cors());
app.use(compression());

// MICRO-CACHE do GET /api/leads (perf 2026-07-10): a rota faz SELECT * de TODOS os leads (1078
// leads ~1,2MB) e refiltra em JS a cada chamada — o SPA refaz esse fetch em TODA entrada na guia
// Pipeline, então cada clique pagava 0,9-1,5s de TTFB no servidor. Guarda o corpo JSON já pronto
// por chave de ambiente ('pre'|'pos'|'all') por poucos segundos (TTL curto, não é cache de longo
// prazo) e invalida explicitamente em qualquer rota que escreva em 'leads' — assim o board nunca
// mostra dado velho após um card ser criado/movido/editado/arquivado.
const LEADS_CACHE_TTL_MS = 4000;
let _leadsCache = new Map();
function bustLeadsCache() { _leadsCache.clear(); }

// TODO: reduzir para 2mb quando o frontend FormData estiver publicado
app.use(bodyParser.json({ limit: '30mb' }));

// Upload multipart de mídia (áudio/foto/vídeo/documento) — achado 1.8: o caminho antigo mandava
// o arquivo como base64 dentro do JSON (bodyParser 30mb), e o JSON.parse síncrono de ~20MB travava
// o processo inteiro. Guarda em memória (os handlers já trabalham com Buffer, igual ao base64 antigo)
// e limita a 16MB, mesmo teto já aplicado no caminho base64 de /media.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
// Envolve upload.single para responder JSON (e não a página de erro HTML padrão do Express) se o
// multipart estourar o limite de tamanho ou vier malformado.
function uploadSingle(field) {
  const mw = upload.single(field);
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) return res.status(400).json({ error: (err && err.message) || 'Falha no upload do arquivo' });
      next();
    });
  };
}

// Health check routes
app.get('/', (req, res) => {
  res.json({ status: "ok", service: "leads-whatsapp-crm-backend" });
});
app.get('/api', (req, res) => {
  res.json({ status: "ok", api: "v1" });
});

// Debug endpoints
app.get('/api/debug/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(logBuffer.join('\n'));
});

app.get('/api/debug/db-dump', async (req, res) => {
  try {
    const users = await allRows("SELECT id, email, name, role FROM users");
    const accounts = await allRows("SELECT * FROM whatsapp_accounts");
    const convs = await allRows("SELECT * FROM conversations");
    const messages = await allRows("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 50");
    const leads = await allRows("SELECT * FROM leads LIMIT 10");
    res.json({
      users,
      accounts,
      convs,
      messages,
      leads
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Emergency: force-fix stages without auth (safe: only updates pipeline column names)
app.post('/api/debug/fix-stages', async (req, res) => {
  try {
    const correctStages = [
      { id: "novo",       title: "Novo Leads",              color: "#71717a" },
      { id: "tratamento", title: "Tratamento inicial",      color: "#0ea5e9" },
      { id: "proposta",   title: "Proposta enviada",        color: "#f59e0b" },
      { id: "followup",   title: "Follow-up pagamento",     color: "#ec4899" },
      { id: "convertida", title: "Venda convertida",        color: "#16a34a" },
      { id: "declinado",  title: "Lead declinou/cancelado", color: "#ef4444" },
      { id: "clientes_antigos", title: "Comunicação com ambiente Pós-Venda",  color: "#6366f1" }
    ];
    await runQuery("DELETE FROM stages");
    for (const s of correctStages) {
      await runQuery("INSERT INTO stages (id, title, color) VALUES (?, ?, ?)", [s.id, s.title, s.color]);
    }
    await runQuery("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
    await runQuery("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
    await runQuery("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'convertida', 'declinado', 'clientes_antigos')");
    const stages = await allRows("SELECT * FROM stages");
    res.json({ success: true, stages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log requests (condicional: liga com DEBUG_HTTP=1 — evita logar toda requisição/polling em produção)
app.use((req, res, next) => {
  if (process.env.DEBUG_HTTP === '1') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  }
  next();
});

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ detail: "Não autenticado" });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ detail: "Token inválido ou expirado" });
    }
    req.user = user;
    next();
  });
}

// 1. Auth Route: Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password, env } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email e senha são obrigatórios" });
  }

  try {
    // E-mail é salvo em minúsculas no cadastro → normaliza aqui também (case-insensitive + trim),
    // senão "Levi@..." não casa com "levi@..." e o login falha sem motivo.
    const mail = String(email).trim().toLowerCase();
    let user = await getRow("SELECT * FROM users WHERE email = ?", [mail]);
    if (!user) user = await getRow("SELECT * FROM users WHERE LOWER(email) = ?", [mail]); // pega cadastros antigos sem normalização
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(400).json({ error: "Credenciais inválidas" });
    }

    // AMBIENTE escolhido no login (pedido do Henry, 09/07/2026): combo Pré-venda/Pós-venda na
    // tela de login. Valida contra o wa_type do usuário ('ambos' pode os dois; 'pre' só pré;
    // 'pos' só pós). Se não permitido → 403 com aviso claro. Sem env no body (app antigo/API):
    // cai no padrão do cadastro, como sempre foi. O ambiente vira claim 'env' do JWT e passa a
    // decidir userIsPos() e o wa_type efetivo devolvido em /auth/me — o resto do sistema não muda.
    let envSel = (env === 'pre' || env === 'pos') ? env : null;
    const waT = String(user.wa_type || 'ambos');
    if (envSel) {
      const permitido = (waT === 'ambos') || (waT === envSel);
      if (!permitido) {
        const nomeAmb = envSel === 'pos' ? 'PÓS-venda' : 'PRÉ-venda';
        return res.status(403).json({ error: "Sem acesso: seu usuário não está configurado para o ambiente " + nomeAmb + ". Fale com o administrador." });
      }
    } else {
      envSel = (waT === 'pos') ? 'pos' : 'pre';
    }

    const tokenPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar: user.avatar,
      env: envSel
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      access_token: token,
      token_type: "bearer",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});

// 2. Auth Route: Me
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  // wa_type define o AMBIENTE do login: 'pos' (Alexandre → só 2030/pós-venda) vs pré/ambos.
  // allowed_stages: colunas do pipeline que este usuário pode VER ([] = todas do ambiente).
  let wa_type = 'ambos', allowed_stages = [], calendly_agenda = 0, nav_tabs = [];
  try {
    const u = await getRow("SELECT wa_type, allowed_stages, calendly_agenda, nav_tabs FROM users WHERE id = ?", [req.user.sub]);
    if (u && u.wa_type) wa_type = u.wa_type;
    if (u && u.allowed_stages) { try { const a = JSON.parse(u.allowed_stages); if (Array.isArray(a)) allowed_stages = a; } catch (e) {} }
    if (u) calendly_agenda = Number(u.calendly_agenda) ? 1 : 0;
    if (u && u.nav_tabs) { try { const n = JSON.parse(u.nav_tabs); if (Array.isArray(n)) nav_tabs = n; } catch (e) {} }
  } catch (e) {}
  // Ambiente escolhido no LOGIN (claim 'env' do JWT) vence o wa_type do cadastro: o frontend
  // inteiro decide pré/pós por cu.wa_type === 'pos', então devolver o ambiente EFETIVO aqui
  // faz tudo funcionar sem mudar mais nada. Usuário 'ambos' sem env no token segue 'ambos'.
  if (req.user.env === 'pos' || req.user.env === 'pre') wa_type = req.user.env;
  res.json({
    id: req.user.sub,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    avatar: req.user.avatar,
    wa_type,
    allowed_stages,
    calendly_agenda,
    nav_tabs
  });
});

// 2b. Users management (somente Administrador)
function requireAdmin(req, res) {
  if (!req.user || req.user.role !== 'Administrador') {
    res.status(403).json({ detail: "Apenas administradores" });
    return false;
  }
  return true;
}

// Nomes dos perfis (leve, SEM dados sensíveis) — alimenta a combo "Responsável" dos cards
// (pedido do Henry, 2026-07-08). Qualquer usuário logado pode ler.
app.get('/api/users/names', authenticateToken, async (req, res) => {
  try {
    const rows = await allRows("SELECT id, name FROM users ORDER BY name");
    res.json(rows || []);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const users = await allRows("SELECT id, name, email, role, avatar, wa_type, allowed_stages, calendly_agenda, nav_tabs FROM users ORDER BY name");
    res.json(users.map(u => {
      let a = [], n = [];
      if (u.allowed_stages) { try { const p = JSON.parse(u.allowed_stages); if (Array.isArray(p)) a = p; } catch (e) {} }
      if (u.nav_tabs) { try { const p = JSON.parse(u.nav_tabs); if (Array.isArray(p)) n = p; } catch (e) {} }
      return Object.assign({}, u, { allowed_stages: a, nav_tabs: n });
    }));
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, email, password, role, wa_type } = req.body;
  if (!name || !email || !password) return res.status(400).json({ detail: "Nome, e-mail e senha são obrigatórios" });
  const r = (role === 'Vendedor') ? 'Vendedor' : 'Administrador';
  const wt = ['pre', 'pos', 'ambos'].includes(wa_type) ? wa_type : 'ambos';
  const mail = String(email).trim().toLowerCase();
  try {
    const existing = await getRow("SELECT id FROM users WHERE email = ?", [mail]);
    if (existing) return res.status(409).json({ detail: "Já existe um usuário com este e-mail" });
    const id = 'u_' + Math.random().toString(36).substr(2, 9);
    const hash = bcrypt.hashSync(String(password), 10);
    const avatar = String(name).trim().slice(0, 2).toUpperCase();
    await runQuery("INSERT INTO users (id, email, password_hash, name, role, avatar, wa_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, mail, hash, String(name).trim(), r, avatar, wt]);
    res.json({ id, name: String(name).trim(), email: mail, role: r, avatar, wa_type: wt });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.patch('/api/users/:id', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  const { name, role, password, wa_type, allowed_stages, calendly_agenda, nav_tabs } = req.body;
  try {
    const u = await getRow("SELECT * FROM users WHERE id = ?", [id]);
    if (!u) return res.status(404).json({ detail: "Usuário não encontrado" });
    const updates = [], params = [];
    if (name !== undefined && String(name).trim()) {
      updates.push("name = ?"); params.push(String(name).trim());
      updates.push("avatar = ?"); params.push(String(name).trim().slice(0, 2).toUpperCase());
    }
    if (role !== undefined) { updates.push("role = ?"); params.push(role === 'Vendedor' ? 'Vendedor' : 'Administrador'); }
    if (wa_type !== undefined) { updates.push("wa_type = ?"); params.push(['pre', 'pos', 'ambos'].includes(wa_type) ? wa_type : 'ambos'); }
    // Colunas visíveis do pipeline (pedido do Henry): array de ids; [] = sem restrição (todas).
    if (allowed_stages !== undefined) {
      const arr = Array.isArray(allowed_stages) ? allowed_stages.map(s => String(s)).filter(Boolean).slice(0, 60) : [];
      updates.push("allowed_stages = ?"); params.push(arr.length ? JSON.stringify(arr) : '');
    }
    // Agenda de validações do Calendly no perfil (pedido do Henry, 2026-07-07): 0/1.
    if (calendly_agenda !== undefined) { updates.push("calendly_agenda = ?"); params.push(calendly_agenda ? 1 : 0); }
    // Guias da barra lateral OCULTAS para este usuário (pedido do Henry, 2026-07-08).
    if (nav_tabs !== undefined) {
      const nv = Array.isArray(nav_tabs) ? nav_tabs.map(s => String(s)).filter(Boolean).slice(0, 12) : [];
      updates.push("nav_tabs = ?"); params.push(nv.length ? JSON.stringify(nv) : '');
    }
    if (password) { updates.push("password_hash = ?"); params.push(bcrypt.hashSync(String(password), 10)); }
    if (updates.length) { params.push(id); await runQuery("UPDATE users SET " + updates.join(", ") + " WHERE id = ?", params); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.delete('/api/users/:id', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  if (id === req.user.sub) return res.status(400).json({ detail: "Você não pode excluir o próprio usuário" });
  try {
    await runQuery("DELETE FROM users WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

// 2c. Instagram (Meta) — Webhook de verificação + recebimento (Direct e comentários)
const IG_VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN || 'eccere_ig_2026';

// Verificação do webhook (a Meta chama via GET ao configurar)
app.get('/api/instagram/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === IG_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Busca o perfil público (nome + foto) de quem enviou o Direct, via Instagram Graph API.
// Campos disponíveis para usuários que mandaram mensagem: name, username, profile_pic.
async function fetchIgProfile(sid, token) {
  try {
    const r = await fetch('https://graph.instagram.com/v21.0/' + encodeURIComponent(sid) +
      '?fields=name,username,profile_pic&access_token=' + encodeURIComponent(token));
    const d = await r.json().catch(() => ({}));
    if (d && !d.error) {
      return { name: d.name || d.username || '', username: d.username || '', profilePic: d.profile_pic || '' };
    }
    if (d && d.error) console.error('[IG profile] erro:', JSON.stringify(d.error));
  } catch (e) { console.error('[IG profile] falha:', e && e.message); }
  return null;
}

// Grava uma mensagem/comentário do Instagram como conversa (account = 'ig')
async function storeIgMessage(senderId, text, from, name, msgId) {
  const jid = 'ig:' + senderId;
  const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  let convo = await getRow("SELECT * FROM conversations WHERE whatsapp_jid = ?", [jid]);
  let convoId;

  // Resolve nome + foto reais do remetente quando ainda estão genéricos/ausentes.
  let resolvedName = name || '';
  let resolvedAvatar = '';
  const isGeneric = (n) => !n || n === 'Instagram' || n === 'Instagram lead';
  const hasPhoto = convo && /^https?:/i.test(convo.avatar || '');
  if (from === 'them' && (!convo || (isGeneric(convo.name) && !resolvedName) || !hasPhoto)) {
    try {
      const conn = await getRow("SELECT access_token FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
      if (conn && conn.access_token) {
        const prof = await fetchIgProfile(senderId, conn.access_token);
        if (prof) {
          if (!resolvedName) resolvedName = prof.name;
          resolvedAvatar = prof.profilePic || '';
        }
      }
    } catch (e) {}
  }

  if (convo) {
    convoId = convo.id;
    // Atualiza nome/foto da conversa e do lead quando descobrimos dados melhores.
    if (resolvedName && isGeneric(convo.name)) {
      await runQuery("UPDATE conversations SET name = ? WHERE id = ?", [resolvedName, convoId]);
      await runQuery("UPDATE leads SET name = ? WHERE whatsapp_jid = ? AND (name IS NULL OR name = '' OR name = 'Instagram' OR name = 'Instagram lead')", [resolvedName, jid]);
    }
    if (resolvedAvatar && !hasPhoto) {
      await runQuery("UPDATE conversations SET avatar = ? WHERE id = ?", [resolvedAvatar, convoId]);
    }
    await runQuery("UPDATE conversations SET lastTime = ?, unread = " + (from === 'them' ? "unread + 1" : "0") + " WHERE id = ?", [timeStr, convoId]);
  } else {
    convoId = 'c_' + Math.random().toString(36).substr(2, 9);
    const nm = resolvedName || name || 'Instagram';
    const av = resolvedAvatar || nm.slice(0, 2).toUpperCase();
    await runQuery(
      "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, whatsapp_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [convoId, 'ig', nm, '', av, timeStr, from === 'them' ? 1 : 0, 0, jid]
    );
  }
  const mid = msgId || ('m_' + Math.random().toString(36).substr(2, 9));
  await runQuery(
    "INSERT OR IGNORE INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [mid, convoId, from, text, timeStr, Date.now(), 'text', null]
  );
}

// Recebe eventos do Instagram (Direct e comentários)
app.post('/api/instagram/webhook', async (req, res) => {
  res.sendStatus(200); // responder rápido (Meta exige < 5s)
  try {
    const body = req.body || {};
    if (body.object !== 'instagram') return;
    for (const entry of (body.entry || [])) {
      // Direct (mensagens)
      for (const ev of (entry.messaging || [])) {
        const sid = ev.sender && ev.sender.id;
        const txt = ev.message && ev.message.text;
        if (sid && txt) {
          await storeIgMessage(sid, txt, (ev.message && ev.message.is_echo) ? 'me' : 'them', null, ev.message && ev.message.mid);
        }
      }
      // Comentários
      for (const ch of (entry.changes || [])) {
        if (ch.field === 'comments' && ch.value && ch.value.text) {
          const fromId = (ch.value.from && ch.value.from.id) || ('cmt_' + (ch.value.id || ''));
          const fromName = (ch.value.from && ch.value.from.username) || 'Instagram';
          await storeIgMessage(fromId, '[Comentário] ' + ch.value.text, 'them', fromName, 'cmt_' + (ch.value.id || Math.random().toString(36).substr(2, 9)));
        }
      }
    }
  } catch (e) { console.error('[IG webhook] erro:', e); }
});

// 2d. Instagram OAuth (Instagram API with Instagram Login) + envio de Direct
const IG_APP_ID = process.env.IG_APP_ID || '1315059453545733';
const IG_APP_SECRET = process.env.IG_APP_SECRET || '';
const IG_REDIRECT_URI = process.env.IG_REDIRECT_URI || 'https://crm-api.eccere.com.br/api/instagram/callback';
const IG_SCOPES = 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://eccere.com.br/leads';

// Inicia o login: redireciona para a tela de autorização do Instagram
app.get('/api/instagram/connect', (req, res) => {
  const url = 'https://www.instagram.com/oauth/authorize'
    + '?enable_fb_login=0&force_authentication=1'
    + '&client_id=' + encodeURIComponent(IG_APP_ID)
    + '&redirect_uri=' + encodeURIComponent(IG_REDIRECT_URI)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(IG_SCOPES);
  res.redirect(url);
});

// Callback do OAuth: troca o code por token de longa duração e guarda
app.get('/api/instagram/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect(APP_BASE_URL + '/app/conexoes?ig=erro');
  if (!IG_APP_SECRET) { console.error('[IG OAuth] IG_APP_SECRET nao configurado'); return res.redirect(APP_BASE_URL + '/app/conexoes?ig=sem_segredo'); }
  try {
    const form = new URLSearchParams();
    form.set('client_id', IG_APP_ID);
    form.set('client_secret', IG_APP_SECRET);
    form.set('grant_type', 'authorization_code');
    form.set('redirect_uri', IG_REDIRECT_URI);
    form.set('code', String(code).replace(/#_$/, ''));
    const r1 = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: form });
    const d1 = await r1.json();
    if (!d1.access_token) { console.error('[IG OAuth] short token falhou', d1); return res.redirect(APP_BASE_URL + '/app/conexoes?ig=erro_token'); }
    const shortToken = d1.access_token;
    const igUserId = String(d1.user_id || '');
    const r2 = await fetch('https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=' + encodeURIComponent(IG_APP_SECRET) + '&access_token=' + encodeURIComponent(shortToken));
    const d2 = await r2.json();
    const longToken = d2.access_token || shortToken;
    let username = '';
    try { const r3 = await fetch('https://graph.instagram.com/me?fields=user_id,username&access_token=' + encodeURIComponent(longToken)); const d3 = await r3.json(); username = d3.username || ''; } catch (e) {}
    await runQuery("DELETE FROM ig_connections WHERE ig_user_id = ?", [igUserId]);
    await runQuery("INSERT INTO ig_connections (id, ig_user_id, username, access_token, connected_at) VALUES (?, ?, ?, ?, ?)",
      ['ig_' + igUserId, igUserId, username, longToken, new Date().toISOString()]);
    // (RE)INSCREVE o webhook de mensagens/comentários — SEM isto a Meta não entrega os Directs.
    try {
      const sub = await fetch('https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages,comments&access_token=' + encodeURIComponent(longToken), { method: 'POST' });
      const sj = await sub.json().catch(() => ({}));
      console.log('[IG OAuth] subscribed_apps:', JSON.stringify(sj));
    } catch (e) { console.error('[IG OAuth] subscribe falhou:', e && e.message); }
    return res.redirect(APP_BASE_URL + '/app/conexoes?ig=ok');
  } catch (e) {
    console.error('[IG OAuth] erro', e);
    return res.redirect(APP_BASE_URL + '/app/conexoes?ig=erro');
  }
});

// Status da conexao do Instagram (para o front exibir conectado)
app.get('/api/instagram/status', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT ig_user_id, username, access_token, connected_at FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
    if (!row) return res.json({ connected: false });
    const out = { connected: true, username: row.username, connected_at: row.connected_at };
    if (row.connected_at) out.days_since = Math.floor((Date.now() - new Date(row.connected_at).getTime()) / 86400000);
    // ?check=1 testa o token ao vivo e a inscrição do webhook (o que faz as msgs chegarem).
    if (req.query && (req.query.check === '1' || req.query.check === 'true')) {
      try {
        const r = await fetch('https://graph.instagram.com/me?fields=user_id,username&access_token=' + encodeURIComponent(row.access_token));
        const d = await r.json().catch(() => ({}));
        out.token_valid = !!(d && d.user_id);
        if (d && d.error) out.token_error = d.error.message || 'token inválido';
      } catch (e) { out.token_valid = false; out.token_error = e.message; }
      try {
        const s = await fetch('https://graph.instagram.com/v21.0/me/subscribed_apps?access_token=' + encodeURIComponent(row.access_token));
        const sd = await s.json().catch(() => ({}));
        const apps = (sd && sd.data) || [];
        const fields = apps.length ? (apps[0].subscribed_fields || []) : [];
        out.webhook_subscribed = Array.isArray(fields) && fields.indexOf('messages') !== -1;
        out.webhook_fields = fields;
        if (sd && sd.error) out.webhook_error = sd.error.message;
      } catch (e) { out.webhook_subscribed = false; out.webhook_error = e.message; }
    }
    res.json(out);
  } catch (e) { res.json({ connected: false }); }
});

// Desconecta o Instagram (remove o token guardado)
app.post('/api/instagram/disconnect', authenticateToken, async (req, res) => {
  try {
    await runQuery("DELETE FROM ig_connections");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// (Re)inscreve o webhook de mensagens/comentários usando o token guardado (sem refazer o login).
// Útil quando o token ainda é válido mas a inscrição lapsou — é o que faz os Directs voltarem a chegar.
app.post('/api/instagram/subscribe', authenticateToken, async (req, res) => {
  try {
    const conn = await getRow("SELECT * FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
    if (!conn || !conn.access_token) return res.status(400).json({ error: 'Instagram não conectado' });
    const r = await fetch('https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages,comments&access_token=' + encodeURIComponent(conn.access_token), { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (d && d.error) return res.status(502).json({ error: d.error.message || 'Falha ao inscrever o webhook' });
    res.json({ success: !!d.success || true, result: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backfill único: preenche nome + foto das conversas de Instagram já existentes que ainda
// estão genéricas ("Instagram" / sem foto). Admin dispara uma vez pela tela de Conexões.
app.post('/api/instagram/backfill-profiles', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  try {
    const conn = await getRow("SELECT access_token FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
    if (!conn || !conn.access_token) return res.status(400).json({ error: 'Instagram não conectado. Conecte o Instagram primeiro.' });
    const rows = await allRows("SELECT id, name, avatar, whatsapp_jid FROM conversations WHERE account = 'ig' AND whatsapp_jid LIKE 'ig:%'");
    let scanned = 0, updated = 0, failed = 0;
    for (const c of (rows || [])) {
      scanned++;
      const isGeneric = !c.name || c.name === 'Instagram' || c.name === 'Instagram lead';
      const hasPhoto = /^https?:/i.test(c.avatar || '');
      if (!isGeneric && hasPhoto) continue; // já tem nome e foto
      const sid = String(c.whatsapp_jid || '').replace(/^ig:/, '');
      if (!sid || sid.indexOf('cmt_') === 0) continue; // comentários não têm perfil de DM
      const prof = await fetchIgProfile(sid, conn.access_token);
      if (!prof) { failed++; continue; }
      const newName = (isGeneric && prof.name) ? prof.name : null;
      const newAvatar = (!hasPhoto && prof.profilePic) ? prof.profilePic : null;
      if (newName) {
        await runQuery("UPDATE conversations SET name = ? WHERE id = ?", [newName, c.id]);
        await runQuery("UPDATE leads SET name = ? WHERE whatsapp_jid = ? AND (name IS NULL OR name = '' OR name = 'Instagram' OR name = 'Instagram lead')", [newName, c.whatsapp_jid]);
      }
      if (newAvatar) await runQuery("UPDATE conversations SET avatar = ? WHERE id = ?", [newAvatar, c.id]);
      if (newName || newAvatar) updated++;
      await new Promise(r => setTimeout(r, 250)); // gentil com o rate limit da Graph API
    }
    res.json({ success: true, scanned, updated, failed });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Envia uma mensagem de Direct pelo Instagram usando o token guardado.
// opts.humanAgent = true → inclui a tag HUMAN_AGENT (janela de 7 dias). Só funciona se o
// recurso "Human Agent" estiver aprovado para o app no painel da Meta; caso contrário a Meta
// recusa e tratamos no chamador.
async function sendIgMessage(recipientId, text, opts) {
  const conn = await getRow("SELECT * FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
  if (!conn || !conn.access_token) throw new Error('Instagram nao conectado');
  const payload = { recipient: { id: recipientId }, message: { text: text } };
  if (opts && opts.humanAgent) { payload.messaging_type = 'MESSAGE_TAG'; payload.tag = 'HUMAN_AGENT'; }
  const resp = await fetch('https://graph.instagram.com/v21.0/me/messages?access_token=' + encodeURIComponent(conn.access_token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await resp.json();
  if (d.error) throw new Error((d.error && d.error.message) || 'Falha ao enviar Direct');
  return d;
}

// Renova o token de longa duração do Instagram (vale 60 dias; sem renovar, as msgs PARAM de chegar).
// O ig_refresh_token estende por mais 60 dias e exige que o token tenha >24h e ainda esteja válido.
async function refreshIgToken() {
  try {
    const conn = await getRow("SELECT * FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
    if (!conn || !conn.access_token) return;
    const r = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(conn.access_token));
    const d = await r.json().catch(() => ({}));
    if (d && d.access_token) {
      await runQuery("UPDATE ig_connections SET access_token = ?, connected_at = ? WHERE id = ?", [d.access_token, new Date().toISOString(), conn.id]);
      // garante que o webhook continua inscrito a cada renovação
      try { await fetch('https://graph.instagram.com/v21.0/me/subscribed_apps?subscribed_fields=messages,comments&access_token=' + encodeURIComponent(d.access_token), { method: 'POST' }); } catch (e) {}
      console.log('[IG] token renovado (+60 dias).');
    } else {
      console.error('[IG] refresh sem token (provável expiração — reconecte o Instagram):', JSON.stringify(d));
    }
  } catch (e) { console.error('[IG] refresh erro:', e && e.message); }
}
// Roda no boot (15s após subir) e depois 1x por dia.
setTimeout(refreshIgToken, 15000);
setInterval(refreshIgToken, 24 * 60 * 60 * 1000);

// 3. Leads Routes: Get All (active only)
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    // Chave do micro-cache: calcula o ambiente (pós/pré) UMA vez aqui em cima — antes o userIsPos
    // era chamado dentro do try do filtro (repetindo a consulta a cada request); agora é calculado
    // uma única vez e reaproveitado tanto na chave do cache quanto no filtro abaixo.
    const _isAllParam = String(req.query.all || '') === '1';
    const isPos = await userIsPos(req);
    const _cacheKey = _isAllParam ? 'all' : (isPos ? 'pos' : 'pre');
    const _cached = _leadsCache.get(_cacheKey);
    if (_cached && (Date.now() - _cached.t) < LEADS_CACHE_TTL_MS) {
      res.type('application/json').send(_cached.body);
      return;
    }
    // Ordena por prioridade (followup no topo, depois urgente/vermelho, depois média/amarelo, depois sem), e por data.
    const leads = await allRows("SELECT * FROM leads WHERE archived = 0 ORDER BY CASE priority WHEN 'followup' THEN 1 WHEN 'urgente' THEN 2 WHEN 'media' THEN 3 ELSE 4 END, createdAt DESC");
    let parsedLeads = leads.map(l => ({
      ...l,
      tags: l.tags ? JSON.parse(l.tags) : []
    }));
    // ?all=1 (pipeline381): devolve os leads dos DOIS ambientes, SEM o filtro pré/pós abaixo —
    // usado pelo filtro 👤 Responsável da guia WhatsApp p/ cruzar conversas com cards que podem
    // estar no ambiente oposto (caso JD Crawford). Mesmo padrão do GET /conversations?all=1.
    if (_isAllParam) {
      const _body = JSON.stringify(parsedLeads);
      _leadsCache.set(_cacheKey, { t: Date.now(), body: _body });
      res.type('application/json').send(_body);
      return;
    }
    // Filtra por LOGIN (sem mascarar, sempre o número real):
    //  - PÓS (Alexandre): só leads do 2030 OU vendas convertidas; 'stage' é remapeado p/ pos_stage
    //    (assim o pipeline nativo coloca os cards nas colunas do pós-venda).
    //  - PRÉ/admin: exclui os leads do 2030.
    try {
      const { posSet, posDigits } = await posLineInfo();
      // isPos já foi calculado acima (reaproveitado da chave do cache) — não chama userIsPos de novo.
      // COLUNA-PONTE: 'Comunicação com ambiente Pré/Pós-Venda'. Um lead está na ponte se foi colocado
      // nela por QUALQUER lado — stage='clientes_antigos' (pré) OU pos_stage='clientes_antigos_pos'
      // (pós). Quem está na ponte aparece nos DOIS ambientes, na coluna-ponte de cada board.
      const inBridge = (l) => l.bridge === 1;
      // PERTENCE AO PÓS por ATRIBUIÇÃO: um lead que foi colocado numa coluna pós REAL (pos_stage de uma
      // coluna do board pós, exceto a coluna-ponte) pertence ao ambiente PÓS — INDEPENDENTE da linha do
      // WhatsApp. Esse é o sinal que faltava: antes o ambiente vinha SÓ de leadIsPos (linha 2030), então
      // um card pré reclassificado p/ coluna pós perdia a ponte (bridge=0) e voltava SÓ p/ o pré. Agora
      // a coluna escolhida (combo ou arrasto) decide o ambiente, de forma robusta e simétrica.
      const hasPosStage = (l) => !!(l.pos_stage && POS_STAGES.includes(l.pos_stage) && l.pos_stage !== 'clientes_antigos_pos');
      // SELO da coluna-ponte: a DIREÇÃO é dada pela ORIGEM do card. Lead pós (2030) que foi p/ a ponte
      // veio do ambiente PÓS → assunto p/ o PRÉ ('pre'); lead pré que foi p/ a ponte → assunto p/ o PÓS
      // ('pos'). Derivado aqui (não persistido): classifica todos automaticamente e some fora da ponte.
      // 2026-07-05 (regra do Henry): se a MOVIMENTAÇÃO gravou o assunto (leads.bridge_subject),
      // ELE manda — a última movimentação vale sempre. A derivação pela linha é só fallback p/
      // cards que entraram na ponte antes desta regra.
      const bridgeSubject = (l) => (l.bridge_subject === 'pre' || l.bridge_subject === 'pos')
        ? l.bridge_subject
        : (leadIsPos(l, posSet, posDigits) ? 'pre' : 'pos');
      // LINHA RECLASSIFICADA (caso 3094→pós, 2026-07-02): a linha só define o ambiente enquanto o
      // lead ainda não foi TRABALHADO no pré. Se ele tem etapa pré ativa (tratamento/proposta/
      // followup/declinado) e nenhuma coluna pós, ele é do PRÉ — mesmo que a linha dele (account/
      // recv_number) tenha virado pós depois. Sem isso, leads antigos da 3094 sumiam do pré e
      // inundavam "Mensagens novas para organizar" no pós (caso JD Crawford). Leads 'novo' seguem
      // a linha (chegada genuína pelo WhatsApp do pós precisa aparecer lá).
      const WORKED_PRE = ['tratamento', 'proposta', 'followup', 'declinado'];
      const isPosByLine = (l) => leadIsPos(l, posSet, posDigits) && !(WORKED_PRE.includes(l.stage) && !hasPosStage(l) && l.bridge !== 1);
      if (isPos) {
        // PÓS: vê os leads do 2030, as vendas convertidas, os ATRIBUÍDOS a uma coluna pós e os da ponte.
        // Os da ponte vão p/ a coluna-ponte do board pós ('clientes_antigos_pos'); os demais, pela regra
        // normal (posStageFor).
        parsedLeads = parsedLeads
          .filter(l => isPosByLine(l) || l.stage === 'convertida' || hasPosStage(l) || inBridge(l))
          .map(l => Object.assign({}, l, inBridge(l)
            ? { stage: 'clientes_antigos_pos', bridge_subject: bridgeSubject(l) }
            : { stage: posStageFor(l) }));
      } else if (posSet.size) {
        // PRÉ/admin: exclui os leads do 2030 E os que foram movidos p/ uma coluna pós (hasPosStage),
        // EXCETO: (a) os que estão na coluna-ponte (cross-visíveis) e (b) as VENDAS CONVERTIDAS. Uma venda
        // convertida fica SEMPRE em "Venda convertida" no pré, mesmo depois de distribuída numa coluna do
        // pós — mover o card no pós só mexe em pos_stage (stage continua 'convertida'), então o card do pré
        // NÃO é alterado. ("Venda convertida" pré ↔ "Clientes concluídos" pós: cross-visíveis e independentes.)
        // 'convertida' passa SEMPRE (fix 2026-07-06, caso JD Crawford): lead de linha PÓS (ex.:
        // 3094) que virava "Venda convertida" era engolido pelo isPosByLine e SUMIA do pré —
        // 'convertida' não está em WORKED_PRE. Venda convertida é cross-visível por regra: fica
        // no pré E aparece no pós (Recém Contratados), independentemente da linha.
        parsedLeads = parsedLeads
          .filter(l => l.stage === 'convertida' || (!isPosByLine(l) && !hasPosStage(l)) || inBridge(l))
          .map(l => inBridge(l) ? Object.assign({}, l, { stage: 'clientes_antigos', bridge_subject: bridgeSubject(l) }) : l);
      }
    } catch (e) { /* em caso de falha, não filtra */ }
    const _body = JSON.stringify(parsedLeads);
    _leadsCache.set(_cacheKey, { t: Date.now(), body: _body });
    res.type('application/json').send(_body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3b. Leads Routes: Get Archived
app.get('/api/leads/archived', authenticateToken, async (req, res) => {
  try {
    const leads = await allRows("SELECT * FROM leads WHERE archived = 1 ORDER BY createdAt DESC");
    const parsedLeads = leads.map(l => ({
      ...l,
      tags: l.tags ? JSON.parse(l.tags) : []
    }));
    res.json(parsedLeads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3c. Leads Routes: Archive Lead (soft delete)
app.patch('/api/leads/:id/archive', authenticateToken, async (req, res) => {
  // Vendedor não pode excluir/arquivar leads
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para excluir leads" });
  }
  const { id } = req.params;
  try {
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

    await runQuery("UPDATE leads SET archived = 1 WHERE id = ?", [id]);

    // Also archive the associated conversation so it disappears from WhatsApp tab
    const phone = lead.phone ? lead.phone.replace(/\D/g, '') : null;
    if (phone) {
      await runQuery("UPDATE conversations SET archived = 1 WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '+',''), ' ',''), '-',''), '(','') LIKE ?", [`%${phone.slice(-8)}%`]);
    }

    sendWebhook('lead.archived', { ...lead, tags: lead.tags ? JSON.parse(lead.tags) : [], archived: 1 });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3d. Leads Routes: Restore Lead
app.patch('/api/leads/:id/restore', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

    await runQuery("UPDATE leads SET archived = 0 WHERE id = ?", [id]);

    // Restore the associated conversation
    const phone = lead.phone ? lead.phone.replace(/\D/g, '') : null;
    if (phone) {
      await runQuery("UPDATE conversations SET archived = 0 WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '+',''), ' ',''), '-',''), '(','') LIKE ?", [`%${phone.slice(-8)}%`]);
    }

    const restored = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    sendWebhook('lead.restored', { ...restored, tags: restored.tags ? JSON.parse(restored.tags) : [] });
    res.json({
      ...restored,
      tags: restored.tags ? JSON.parse(restored.tags) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Leads Routes: Patch Stage
app.patch('/api/leads/:id/stage', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { stage, force } = req.body;

  if (!stage) {
    return res.status(400).json({ error: "Estágio é obrigatório" });
  }

  try {
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    const cur = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!cur) return res.status(404).json({ error: "Lead não encontrado" });
    // COLUNA-PONTE: entrar nela (por qualquer board) marca a flag 'bridge' e PRESERVA o stage/pos_stage
    // de origem — não grava o valor-ponte. Assim, ao SAIR da ponte (mover p/ qualquer outra coluna), o
    // bridge volta a 0 e o card some da ponte nos DOIS ambientes, retornando à sua coluna de origem.
    if (stage === 'clientes_antigos' || stage === 'clientes_antigos_pos') {
      // SELO da ponte pela ÚLTIMA MOVIMENTAÇÃO (regra do Henry, 2026-07-05): quem move do PRÉ
      // marca "ASSUNTO PÓS-VENDA" ('pos'); quem move do PÓS marca "ASSUNTO PRÉ-VENDA" ('pre') —
      // SEMPRE sobrescreve a tag anterior. Persistido em leads.bridge_subject.
      let _subj = 'pos';
      try { _subj = (await userIsPos(req)) ? 'pre' : 'pos'; } catch (e) {}
      await runQuery("UPDATE leads SET bridge = 1, bridge_subject = ? WHERE id = ?", [_subj, id]);
      if (cur.bridge !== 1 || cur.bridge_subject !== _subj) logLeadHistory({ leadId: id, phone: cur.phone, name: cur.name, type: 'movimentacao', detail: 'Movido para a coluna-ponte (Comunicação Pré/Pós-Venda) — assunto ' + (_subj === 'pre' ? 'PRÉ' : 'PÓS') + '-venda', meta: { to: 'ponte', assunto: _subj } });
      const l2 = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
      return res.json({ ...l2, stage, tags: l2.tags ? JSON.parse(l2.tags) : [] });
    }
    // PÓS-VENDA: coluna pós (não-ponte) → grava pos_stage e SAI da ponte (bridge=0). NUNCA mexe no
    // 'stage' do pré-venda. (As colunas pós têm nomes próprios.)
    if (POS_STAGES.includes(stage)) {
      await runQuery("UPDATE leads SET pos_stage = ?, bridge = 0 WHERE id = ?", [stage, id]);
      // (A coluna On-hold foi extinta em 2026-07-03 — o conceito vive na PRIORIDADE 'onhold'.)
      if (cur.pos_stage !== stage) logLeadHistory({ leadId: id, phone: cur.phone, name: cur.name, type: 'movimentacao', detail: 'Movido para "' + stageLabel(stage) + '" (pós-venda)', meta: { to: stage } });
      const l2 = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
      return res.json({ ...l2, stage, tags: l2.tags ? JSON.parse(l2.tags) : [] });
    }
    // Estágios TERMINAIS: uma vez em "Venda convertida" ou "Lead declinou/cancelado", o lead NÃO muda
    // mais de etapa por processos automáticos (drag, reconcile, etc.). EXCEÇÃO: force=true OU lead na
    // ponte (bridge=1, estado transitório — precisa poder sair).
    if (!force && cur.bridge !== 1 && (cur.stage === 'convertida' || cur.stage === 'declinado') && stage !== cur.stage) {
      console.log(`[stage] BLOQUEADO: "${cur.name}" está em '${cur.stage}' (terminal) — mudança p/ '${stage}' ignorada.`);
      return res.json({ ...cur, tags: cur.tags ? JSON.parse(cur.tags) : [], _locked: true });
    }
    // REGRAS das colunas TERMINAIS — valida ANTES de transferir (vale p/ arrasto E combo):
    // "Venda convertida" exige tipo de serviço (tag) + valor contratado.
    if (stage === 'convertida' && cur.stage !== 'convertida') {
      let tags = []; try { tags = cur.tags ? JSON.parse(cur.tags) : []; } catch (e) { tags = []; }
      const hasServ = Array.isArray(tags) && tags.length > 0 && String(tags[0] || '').trim() !== '';
      const hasValue = Number(cur.value) > 0;
      if (!hasServ || !hasValue) {
        const faltam = [];
        if (!hasServ) faltam.push('o tipo de serviço (classificação)');
        if (!hasValue) faltam.push('o valor contratado');
        return res.status(422).json({ error: 'Não foi transferido para "Venda convertida": falta definir ' + faltam.join(' e ') + '.', _missing: { servico: !hasServ, valor: !hasValue } });
      }
    }
    // "Lead declinou/cancelado" exige o motivo do cancelamento preenchido.
    if (stage === 'declinado' && cur.stage !== 'declinado') {
      if (String(cur.decline_reason || '').trim() === '') {
        return res.status(422).json({ error: 'Não foi transferido para "Lead declinou/cancelado": preencha o motivo do cancelamento primeiro (abra o card → Etapa "Lead declinou/cancelado" → Motivo).', _missing: { motivo: true } });
      }
    }
    // PRÉ-VENDA: coluna pré (não-ponte) → grava stage, SAI da ponte (bridge=0) e LIMPA pos_stage. Limpar
    // o pos_stage é o que faz o card REALMENTE voltar ao pré (senão hasPosStage continuaria true e ele
    // ficaria preso no pós). Move pré ⇄ pós agora é simétrico e confiável.
    await runQuery("UPDATE leads SET stage = ?, pos_stage = NULL, bridge = 0 WHERE id = ?", [stage, id]);
    if (cur.stage !== stage) logLeadHistory({ leadId: id, phone: cur.phone, name: cur.name, type: 'movimentacao', detail: 'Movido para "' + stageLabel(stage) + '"', meta: { to: stage } });
    // Pós-transferência das colunas TERMINAIS:
    if (stage === 'convertida' && cur.stage !== 'convertida') {
      // DATA DA VENDA: padrão = dia da transferência (editável depois no card). Só preenche se vazio.
      const hoje = new Date().toISOString().slice(0, 10);
      await runQuery("UPDATE leads SET sale_date = ? WHERE id = ? AND (sale_date IS NULL OR TRIM(sale_date) = '')", [hoje, id]);
      const valStr = Number(cur.value) > 0 ? ' — valor R$ ' + Number(cur.value).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '';
      logLeadHistory({ leadId: id, phone: cur.phone, name: cur.name, type: 'venda', detail: 'Venda convertida em ' + hoje.split('-').reverse().join('/') + valStr });
    }
    if (stage === 'declinado' && cur.stage !== 'declinado') {
      // Registra o MOTIVO + a DATA DO FECHAMENTO no histórico (sobrevive ao recontato/reset).
      const hoje = new Date().toISOString().slice(0, 10);
      logLeadHistory({ leadId: id, phone: cur.phone, name: cur.name, type: 'cancelamento', detail: 'Cancelado/declinado em ' + hoje.split('-').reverse().join('/') + ' — motivo: ' + String(cur.decline_reason || '').trim() });
      // FECHAMENTO AUTOMÁTICO ao ENTRAR em "Lead declinou/cancelado" por qualquer via (arrasto/combo)
      // (decisão do Henry, 2026-07-15): replica o mesmo fechamento do botão "Encerrar atendimento"
      // (POST /api/leads/:id/close-service, ~L2312) — service_closed=1, limpa lastClientReply/priority
      // e ARQUIVA a conversa do WhatsApp. pos_stage/bridge já foram zerados acima. Reabertura: mesmo
      // mecanismo do close-service (whatsapp.js ~673-680) — nova mensagem do cliente reabre em "Novo Leads".
      try {
        await runQuery("UPDATE leads SET service_closed = 1, lastClientReply = NULL, priority = '' WHERE id = ?", [id]);
        const convo = await findConvoForLead(cur);
        if (convo) await runQuery("UPDATE conversations SET archived = 1, unread = 0 WHERE id = ?", [convo.id]);
      } catch (e) {}
      logLeadHistory({ leadId: id, phone: cur.phone, name: cur.name, type: 'movimentacao', detail: 'Atendimento ENCERRADO automaticamente ao mover para "Lead declinou/cancelado"', meta: { to: 'declinado', encerrado: 1, auto: 1 } });
    }
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    sendWebhook('lead.stage_changed', { ...lead, tags: lead.tags ? JSON.parse(lead.tags) : [] });
    res.json({
      ...lead,
      tags: lead.tags ? JSON.parse(lead.tags) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4a. HISTÓRICO do lead (linha do tempo): contato inicial + movimentações + anotações + mensagens.
// Mescla: (1) contato_inicial sintetizado de createdAt; (2) eventos do lead_history (por lead_id OU
// telefone — reconecta após deletar/recriar); (3) mensagens AO VIVO da conversa atual (enquanto existir;
// após deletar o contato, ficam só as do snapshot). Tudo ordenado por data/hora.
app.get('/api/leads/:id/history', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    const digits = lead ? String(lead.phone || '').replace(/\D/g, '') : '';
    const tail = digits.slice(-8);
    const items = [];
    if (lead && lead.createdAt) items.push({ type: 'contato_inicial', detail: 'Contato inicial' + (lead.source ? ' — origem: ' + lead.source : ''), at: lead.createdAt, who: '' });
    const hist = await allRows(
      "SELECT type, detail, meta, created_at FROM lead_history WHERE lead_id = ? OR (phone IS NOT NULL AND ? <> '' AND phone LIKE ?) ORDER BY created_at ASC",
      [id, tail, '%' + tail + '%']
    );
    for (const h of hist) {
      let who = '';
      try { const mt = h.meta ? JSON.parse(h.meta) : null; if (mt && mt.from) who = mt.from; } catch (e) {}
      items.push({ type: h.type, detail: h.detail || '', at: h.created_at, who });
    }
    // CANAL de chegada: se o lead não tem nenhum evento 'canal' gravado (ex.: não veio pelo formulário),
    // sintetiza um a partir do tracking/source atual, ancorado na data de criação.
    if (lead && !items.some(it => it.type === 'canal')) {
      items.push({ type: 'canal', detail: 'Chegou pelo canal: ' + synthChannel(lead), at: lead.createdAt || new Date().toISOString(), who: '' });
    }
    // Mensagens ao vivo (degrada com elegância se algo falhar — o histórico de eventos ainda volta).
    try {
      let convs = [];
      if (lead) {
        if (lead.whatsapp_jid) convs = await allRows("SELECT id FROM conversations WHERE whatsapp_jid = ?", [lead.whatsapp_jid]);
        if ((!convs || !convs.length) && tail.length >= 8) convs = await allRows("SELECT id FROM conversations WHERE phone LIKE ?", ['%' + tail + '%']);
      }
      for (const c of (convs || [])) {
        const msgs = await allRows("SELECT `from`, text, type, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp ASC", [c.id]);
        for (const m of msgs) {
          const ts = Number(m.timestamp) || 0;
          const ms = ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : Date.now();
          const txt = m.text || (m.type && m.type !== 'text' ? '[' + m.type + ']' : '');
          items.push({ type: 'mensagem', detail: txt, at: new Date(ms).toISOString(), who: m.from });
        }
      }
    } catch (e) { console.error('[history] merge mensagens ao vivo falhou:', e && e.message); }
    items.sort((a, b) => new Date(a.at) - new Date(b.at));
    res.json(items);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4a-bis. Adiciona uma ANOTAÇÃO manual (com data/hora) ao histórico do lead.
app.post('/api/leads/:id/history', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { note } = req.body || {};
  if (!note || !String(note).trim()) return res.status(400).json({ error: 'Anotação vazia' });
  try {
    const lead = await getRow("SELECT id, name, phone FROM leads WHERE id = ?", [id]);
    await logLeadHistory({ leadId: id, phone: lead ? lead.phone : '', name: lead ? lead.name : '', type: 'nota', detail: String(note).trim() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4b. Leads Routes: Patch Lead Details
app.patch('/api/leads/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, value, tags, comments, priority, lastClientReply, followup_date, client_dir, decline_reason, sale_date, casv_date, consulate_date, validation_date, access_email, responsible, source } = req.body;

  try {
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: "Lead não encontrado" });

    let updates = [];
    let params = [];

    if (name !== undefined) {
      updates.push("name = ?");
      params.push(name);
    }
    if (phone !== undefined) {
      updates.push("phone = ?");
      params.push(phone);
      // Synchronize conversation phone
      if (lead.whatsapp_jid) {
        await runQuery("UPDATE conversations SET phone = ? WHERE whatsapp_jid = ?", [phone, lead.whatsapp_jid]);
      } else if (lead.phone) {
        const oldClean = lead.phone.replace(/\D/g, '');
        if (oldClean.length >= 8) {
          await runQuery("UPDATE conversations SET phone = ? WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '+',''), ' ',''), '-',''), '(','') LIKE ?", [phone, `%${oldClean.slice(-8)}%`]);
        }
      }
    }
    if (email !== undefined) {
      updates.push("email = ?");
      params.push(email);
    }
    if (value !== undefined) {
      updates.push("value = ?");
      params.push(value);
    }
    if (tags !== undefined) {
      updates.push("tags = ?");
      params.push(JSON.stringify(tags));
    }
    if (comments !== undefined) {
      updates.push("comments = ?");
      params.push(comments);
    }
    if (priority !== undefined) {
      updates.push("priority = ?");
      params.push(priority);
    }
    // Origem manual (combo do modal): grava e TRAVA a classificação.
    if (source !== undefined) {
      updates.push("source = ?");
      params.push(String(source));
      updates.push("source_locked = 1");
    }
    if (lastClientReply !== undefined) {
      updates.push("lastClientReply = ?");
      params.push(lastClientReply);
    }
    if (followup_date !== undefined) {
      updates.push("followup_date = ?");
      params.push(followup_date || null);
    }
    if (decline_reason !== undefined) {
      updates.push("decline_reason = ?");
      params.push(decline_reason || null);
    }
    // 👤 Responsável pelo card (pedido do Henry, 2026-07-08): nome do perfil, opcional ('' limpa).
    if (responsible !== undefined) {
      updates.push("responsible = ?");
      params.push(String(responsible || '').slice(0, 80));
    }
    if (sale_date !== undefined) {
      updates.push("sale_date = ?");
      params.push(sale_date || null);
    }
    if (client_dir !== undefined) {
      updates.push("client_dir = ?");
      params.push(client_dir || null);
    }
    // Campos do Grupo Visto Americano (reforma 2026-07-02): datas CASV/Consulado/Reunião de
    // validação e e-mail de acesso (texto livre: aceitam data ou "ñ agendado").
    if (casv_date !== undefined) { updates.push("casv_date = ?"); params.push(String(casv_date || '')); }
    if (consulate_date !== undefined) { updates.push("consulate_date = ?"); params.push(String(consulate_date || '')); }
    if (validation_date !== undefined) { updates.push("validation_date = ?"); params.push(String(validation_date || '')); }
    if (access_email !== undefined) { updates.push("access_email = ?"); params.push(String(access_email || '')); }

    if (updates.length > 0) {
      params.push(id);
      await runQuery(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    const updatedLead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    sendWebhook('lead.updated', { ...updatedLead, tags: updatedLead.tags ? JSON.parse(updatedLead.tags) : [] });
    res.json({
      ...updatedLead,
      tags: updatedLead.tags ? JSON.parse(updatedLead.tags) : []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Stages Routes: Get All (self-healing: if old stages found, fix them)
const CORRECT_STAGES = [
  { id: "novo",       title: "Novo Leads",              color: "#71717a" },
  { id: "tratamento", title: "Tratamento inicial",      color: "#0ea5e9" },
  { id: "proposta",   title: "Proposta enviada",        color: "#f59e0b" },
  { id: "followup",   title: "Follow-up pagamento",     color: "#ec4899" },
  { id: "convertida", title: "Venda convertida",        color: "#16a34a" },
  { id: "declinado",  title: "Lead declinou/cancelado", color: "#ef4444" },
  { id: "clientes_antigos", title: "Comunicação com ambiente Pós-Venda",  color: "#6366f1" }
];

// CACHE do self-healing de /api/pipeline/stages (perf 2026-07-10): a cada clique em Pipeline o
// front pedia esta rota, que fazia SELECT * FROM stages + comparação com CORRECT_STAGES (e às vezes
// DELETE/INSERT) — um round-trip ao banco por clique, mesmo quando nada mudou. Guarda o resultado
// final (mesmo array que a rota devolveria) por até 60s; o ramo pós (POS_STAGES_FULL) continua fora
// do cache pois já é uma constante em memória, não toca no banco.
let _stagesCheckedAt = 0;
let _stagesCache = null;

app.get('/api/pipeline/stages', authenticateToken, async (req, res) => {
  try {
    // Fonte de verdade das colunas: o SERVIDOR decide pré/pós pelo ambiente da sessão
    // (claim 'env' do login, 09/07/2026) com fallback no wa_type do cadastro.
    if (await userIsPos(req)) return res.json(POS_STAGES_FULL);
    if (_stagesCache && (Date.now() - _stagesCheckedAt) < 60000) {
      // Cache hit: dentro da janela de 60s, devolve exatamente o mesmo array sem tocar o banco.
      return res.json(_stagesCache);
    }
    let stages = await allRows("SELECT * FROM stages");
    // Self-healing: if stages don't match expected set (id OU título), fix them. Inclui o título p/
    // que renomear uma coluna no CORRECT_STAGES propague ao banco automaticamente no próximo GET.
    const ids = stages.map(s => s.id + ' ' + s.title).sort().join('|');
    const expectedIds = CORRECT_STAGES.map(s => s.id + ' ' + s.title).sort().join('|');
    if (ids !== expectedIds) {
      console.log("Self-healing stages: current=" + ids + " expected=" + expectedIds);
      await runQuery("DELETE FROM stages");
      for (const s of CORRECT_STAGES) {
        await runQuery("INSERT INTO stages (id, title, color) VALUES (?, ?, ?)", [s.id, s.title, s.color]);
      }
      // Migrate leads with old stage IDs
      await runQuery("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
      await runQuery("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
      await runQuery("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'convertida', 'declinado', 'clientes_antigos')");
      stages = await allRows("SELECT * FROM stages");
    }
    // Grava o resultado final no cache de 60s (perf 2026-07-10) — próxima chamada nesta janela
    // devolve este mesmo array sem repetir o SELECT/self-healing.
    _stagesCache = stages;
    _stagesCheckedAt = Date.now();
    res.json(stages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Data no fuso de São Paulo (YYYY-MM-DD) — usado p/ agrupar por dia "do Brasil".
const _spDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const _spWdFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short' });
function spDateISO(d) { return _spDateFmt.format(d); }            // "2026-06-09"
function last7DaysSP() {
  const out = [];
  const now = Date.now();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const iso = _spDateFmt.format(d);
    const wd = _spWdFmt.format(d).replace(/\.$/, '').toLowerCase();
    const parts = iso.split('-');
    out.push({ iso, label: `${parts[2]}/${parts[1]}/${parts[0].slice(2)} (${wd})`, value: 0 });
  }
  return out;
}
// Intervalo de dias (Brasília) de fromIso..toIso (YYYY-MM-DD), inclusivo. Sem from/to => últimos
// `defDays` dias (padrão 15). Limita a 92 dias. Cada item: { iso, label "dd/mm/aa (wd)", value:0 }.
function daysRangeSP(fromIso, toIso, defDays) {
  const isISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const today = _spDateFmt.format(new Date());
  const end = isISO(toIso) ? toIso : today;
  const eMsRaw = Date.parse(end + 'T00:00:00Z');
  let start = isISO(fromIso)
    ? fromIso
    : new Date(eMsRaw - (Math.max(1, defDays || 15) - 1) * 86400000).toISOString().slice(0, 10);
  let sMs = Date.parse(start + 'T00:00:00Z'), eMs = eMsRaw;
  if (isNaN(sMs) || isNaN(eMs)) { sMs = Date.parse(today + 'T00:00:00Z'); eMs = sMs; }
  if (sMs > eMs) { const t = sMs; sMs = eMs; eMs = t; }
  if ((eMs - sMs) / 86400000 > 92) sMs = eMs - 92 * 86400000;
  const out = [];
  for (let ms = sMs; ms <= eMs; ms += 86400000) {
    const iso = new Date(ms).toISOString().slice(0, 10);
    const wd = _spWdFmt.format(new Date(ms + 12 * 3600 * 1000)).replace(/\.$/, '').toLowerCase();
    const parts = iso.split('-');
    out.push({ iso, label: `${parts[2]}/${parts[1]}/${parts[0].slice(2)} (${wd})`, value: 0 });
  }
  return out;
}

// 6. Dashboard Route (counts only active/non-archived leads)
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const totalLeads = await getRow("SELECT COUNT(*) as count FROM leads WHERE archived = 0");
    const totalConvs = await getRow("SELECT COUNT(*) as count FROM conversations WHERE (archived IS NULL OR archived = 0)");
    
    // Receita real = soma das VENDAS CONVERTIDAS (não arquivadas)
    const revenueRow = await getRow("SELECT SUM(value) as total FROM leads WHERE stage = 'convertida' AND archived = 0");
    const totalRevenue = revenueRow.total || 0;

    // Taxa de conversão real = vendas convertidas / total de leads (não arquivados)
    const closedLeads = await getRow("SELECT COUNT(*) as count FROM leads WHERE stage = 'convertida' AND archived = 0");
    const conversionRate = totalLeads.count > 0 ? ((closedLeads.count / totalLeads.count) * 100).toFixed(1) : 0;

    // Source distribution (non-archived)
    const sourceRows = await allRows("SELECT source, COUNT(*) as count FROM leads WHERE archived = 0 GROUP BY source");
    const colors = ["#0d9488", "#7c3aed", "#2563eb", "#ec4899", "#f59e0b", "#16a34a"];
    const leadsBySource = sourceRows.map((s, index) => ({
      source: s.source,
      count: s.count,
      color: colors[index % colors.length]
    }));

    // WhatsApp accounts status
    const whatsappAccounts = await allRows("SELECT id, label, number, color, status, unread FROM whatsapp_accounts");

    // Novos leads REAIS por dia no período (from/to; padrão últimos 15 dias, fuso de São Paulo).
    // IMPORTANTE (pedido do Henry, 2026-07-02): leads importados da planilha Excel do americano
    // (source='Planilha Americano') são LEGADO — ficam FORA das estatísticas por dia (barras,
    // canal e popup), senão o dia da importação vira um pico falso de 200+ "leads novos".
    const _range = daysRangeSP(req.query.from, req.query.to, 15);
    const weeklyLeads = [];
    for (const dia of _range) {
      const r = await getRow("SELECT COUNT(*) as count FROM leads WHERE substr(createdAt,1,10) = ? AND archived = 0 AND COALESCE(source,'') <> 'Planilha Americano'", [dia.iso]);
      weeklyLeads.push({ day: dia.label, value: (r && r.count) || 0 });
    }

    // Leads por CANAL de origem por dia (MESMA base do weeklyLeads → o total por dia BATE com
    // "Leads na Semana"). Canal derivado de lead.tracking; sem rastreamento = "Sem classificação".
    const _byDay = {};
    _range.forEach(d => { _byDay[d.iso] = { day: d.label, ga: 0, meta: 0, org: 0, semclass: 0, total: 0 }; });
    const _allInRange = await allRows(
      "SELECT createdAt, tracking, source FROM leads WHERE substr(createdAt,1,10) >= ? AND substr(createdAt,1,10) <= ? AND archived = 0 AND COALESCE(source,'') <> 'Planilha Americano'",
      [_range[0].iso, _range[_range.length - 1].iso]
    );
    _allInRange.forEach(l => {
      const k = String(l.createdAt || '').slice(0, 10);
      const slot = _byDay[k]; if (!slot) return;
      const cat = leadChannelCat(l); // mesma classificação do endpoint /dashboard/channel-leads (popup)
      slot[cat]++; slot.total++;
    });
    const weeklyByChannel = _range.map(d => _byDay[d.iso]);

    res.json({
      metrics: {
        totalLeads: totalLeads.count,
        leadsGrowth: 0,
        conversations: totalConvs.count,
        conversationsGrowth: 0,
        conversionRate: parseFloat(conversionRate),
        conversionGrowth: 0,
        revenue: totalRevenue,
        revenueGrowth: 0
      },
      leadsBySource,
      weeklyLeads,
      weeklyByChannel,
      recentActivity: [],
      whatsappAccounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6a2. Dashboard: lista os leads de um DIA + CANAL (popup ao clicar num segmento da barra).
// Usa EXATAMENTE a mesma base e classificação do gráfico "Leads por canal" (active-only + leadChannelCat),
// então a contagem do popup bate com a altura do segmento. Inclui todos os ambientes (igual ao gráfico).
app.get('/api/dashboard/channel-leads', authenticateToken, async (req, res) => {
  try {
    const date = String(req.query.date || '').slice(0, 10);
    const channel = String(req.query.channel || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ['ga', 'meta', 'org', 'semclass'].indexOf(channel) < 0) {
      return res.status(400).json({ error: 'Parâmetros: date=YYYY-MM-DD e channel=ga|meta|org|semclass' });
    }
    // Importados da planilha (legado) fora — mesma exclusão do gráfico, p/ o popup bater.
    const rows = await allRows("SELECT * FROM leads WHERE substr(createdAt,1,10) = ? AND archived = 0 AND COALESCE(source,'') <> 'Planilha Americano'", [date]);
    const leads = rows
      .filter(l => leadChannelCat(l) === channel)
      .map(l => Object.assign({}, l, { tags: l.tags ? (function () { try { return JSON.parse(l.tags); } catch (e) { return []; } })() : [] }));
    res.json(leads);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 6b. Dashboard: contratos assinados por dia (e-mails "Contrato Assinado pelo Cliente:")
// Achado 1.5: a varredura IMAP (até ~600 fetches sequenciais) rodava DENTRO da request; só havia
// cache de 5 min sem lock (duas requests concorrentes com cache frio disparavam 2 varreduras).
// Agora a varredura vira job de fundo (refreshSignedContracts), com guard _signedContractsRunning,
// rodando no boot (+30s) e a cada 10 min. A rota NUNCA varre IMAP — responde sempre do cache
// (stale-while-revalidate: cache expirado ainda é servido, e dispara um refresh em background;
// sem cache ainda, devolve o mesmo formato zerado e dispara o refresh).
let _signedCache = { key: '', ts: 0, data: null };
let _signedContractsRunning = false;
async function refreshSignedContracts(from, to) {
  if (_signedContractsRunning) return;
  _signedContractsRunning = true;
  try {
    // monta os dias do período (from/to; padrão 15 dias, fuso de São Paulo)
    const days = daysRangeSP(from, to, 15);
    const cacheKey = (from || '') + '|' + (to || '');
    try {
      const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
      let ImapFlow;
      try { ImapFlow = require('imapflow').ImapFlow; } catch (e) { ImapFlow = null; }
      if (acc && ImapFlow) {
        const client = new ImapFlow({
          host: acc.host, port: 993, secure: true,
          auth: { user: acc.email, pass: acc.password }, logger: false, tls: { rejectUnauthorized: false }
        });
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        try {
          // Início do 1º dia do período (em UTC, com folga de 1 dia para o filtro IMAP SINCE).
          const since = new Date(Date.parse(days[0].iso + 'T00:00:00Z') - 24 * 3600 * 1000);
          // Conta "Contrato Assinado pelo Cliente:".
          const matchSubj = (s) => s.includes('contrato assinado pelo cliente');
          // Estratégia robusta: tenta SEARCH SINCE (todas as msgs do período);
          // se falhar/vier vazio, faz fallback nas últimas 300 mensagens da caixa.
          // Em ambos os casos, o que conta é o filtro de ASSUNTO + janela do período.
          let iter = null;
          try {
            const uids = await client.search({ since }, { uid: true });
            if (uids && uids.length) iter = client.fetch(uids, { envelope: true, internalDate: true }, { uid: true });
          } catch (e) { iter = null; }
          if (!iter) {
            const total = (client.mailbox && client.mailbox.exists) || 0;
            const start = Math.max(1, total - 299);
            iter = client.fetch(start + ':*', { envelope: true, internalDate: true });
          }
          for await (const msg of iter) {
            const subj = ((msg.envelope && msg.envelope.subject) || '').toLowerCase();
            if (!matchSubj(subj)) continue;
            const dt = msg.internalDate || (msg.envelope && msg.envelope.date);
            if (!dt) continue;
            const dd = new Date(dt);
            if (dd < since) continue;
            const iso = spDateISO(dd); // dia no fuso de São Paulo
            const slot = days.find(x => x.iso === iso);
            if (slot) slot.value++;
          }
        } finally { lock.release(); }
        try { await client.logout(); } catch (e) {}
      }
    } catch (err) {
      console.error('signed-contracts error:', err && err.message);
    }
    const payload = { days: days.map(d => ({ day: d.label, value: d.value })) };
    _signedCache = { key: cacheKey, ts: Date.now(), data: payload };
  } finally {
    _signedContractsRunning = false;
  }
}
app.get('/api/dashboard/signed-contracts', authenticateToken, async (req, res) => {
  const from = req.query.from, to = req.query.to;
  const cacheKey = (from || '') + '|' + (to || '');
  if (_signedCache.data && _signedCache.key === cacheKey) {
    // cache de 5 min POR período (IMAP é lento; o front consulta com frequência); se expirou,
    // responde com o que tem e dispara um refresh em background (não bloqueia a request).
    if (Date.now() - _signedCache.ts >= 5 * 60 * 1000) refreshSignedContracts(from, to).catch(() => {});
    return res.json(_signedCache.data);
  }
  // Ainda sem cache para este período específico (boot recente ou período fora do default
  // pré-computado pelo job de fundo): devolve o formato zerado e dispara o refresh em background.
  const emptyDays = daysRangeSP(from, to, 15).map(d => ({ day: d.label, value: 0 }));
  refreshSignedContracts(from, to).catch(() => {});
  res.json({ days: emptyDays });
});

// 6c. Clientes que ASSINARAM o contrato (assunto "Contrato Assinado pelo Cliente: NOME").
// Varre a caixa (últimos 90 dias). De cada mensagem casada extrai (a) os e-mails do corpo/assunto e
// (b) o NOME que vem após "Cliente:" no assunto. O front marca o card como "assinado" quando o e-mail
// OU o nome do lead bate. Use ?debug=1 para ver os assuntos casados e o que foi extraído (segue
// varrendo IMAP na hora, é uma chamada manual/de depuração, não o fluxo normal do dashboard).
//
// Achado 1.5: mesma ideia da rota acima — a varredura vira job de fundo (scanSignedEmails +
// refreshSignedEmails), com guard _signedEmailsRunning, rodando no boot (+90s, escalonado em
// relação ao job de contratos) e a cada 10 min. A rota normal só lê o cache.
let _signedEmailsCache = { ts: 0, data: null };
let _signedEmailsRunning = false;
// Faz a varredura IMAP completa (90 dias) + marca leads no banco. Não mexe no cache — quem decide
// o que fazer com o resultado é o chamador (refreshSignedEmails grava no cache; debug só devolve).
async function scanSignedEmails(debug) {
  const emails = new Set();
  const names = new Set();
  const dbg = [];
  let scanOk = false; // só atualiza o cache se a varredura completou sem erro (evita gravar lista vazia por falha de IMAP)
  try {
    const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
    let ImapFlow, simpleParser;
    try { ImapFlow = require('imapflow').ImapFlow; simpleParser = require('mailparser').simpleParser; }
    catch (e) { ImapFlow = null; }
    if (acc && ImapFlow) {
      const client = new ImapFlow({
        host: acc.host, port: 993, secure: true,
        auth: { user: acc.email, pass: acc.password }, logger: false, tls: { rejectUnauthorized: false }
      });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const since = new Date(); since.setDate(since.getDate() - 90); since.setHours(0, 0, 0, 0);
        const matchSubj = (s) => s.includes('contrato assinado pelo cliente');
        const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
        const ownDomain = (acc.email || '').split('@')[1] || '';
        const collectEmails = (txt, sink) => {
          if (!txt) return;
          const m = String(txt).match(EMAIL_RE);
          if (m) m.forEach(e => {
            const lo = e.toLowerCase();
            if (ownDomain && lo.endsWith('@' + ownDomain.toLowerCase())) return; // ignora a própria empresa
            emails.add(lo); if (sink) sink.push(lo);
          });
        };
        // Extrai o nome após "cliente:" no assunto (mantém a capitalização original).
        const nameFromSubject = (rawSubj) => {
          if (!rawSubj) return '';
          const i = rawSubj.toLowerCase().indexOf('cliente:');
          if (i === -1) return '';
          let n = rawSubj.slice(i + 'cliente:'.length).trim();
          n = n.replace(/["'<>]/g, '').replace(/\s+/g, ' ').trim();
          return n.slice(0, 80);
        };
        // 1) UIDs candidatos: SEARCH SINCE; fallback nas últimas 300 mensagens.
        let uids = [];
        try { uids = await client.search({ since }, { uid: true }) || []; } catch (e) { uids = []; }
        if (!uids.length) {
          const total = (client.mailbox && client.mailbox.exists) || 0;
          const start = Math.max(1, total - 299);
          const seqUids = [];
          for await (const m of client.fetch(start + ':*', { uid: true })) seqUids.push(m.uid);
          uids = seqUids;
        }
        // 2) Filtra por assunto, captura nome (assunto) e e-mails (assunto + corpo).
        for (const uid of uids) {
          let env = null;
          try { env = await client.fetchOne(String(uid), { envelope: true, internalDate: true }, { uid: true }); } catch (e) { continue; }
          const rawSubj = (env && env.envelope && env.envelope.subject) || '';
          if (!matchSubj(rawSubj.toLowerCase())) continue;
          const dt = (env && (env.internalDate || (env.envelope && env.envelope.date)));
          if (dt && new Date(dt) < since) continue;
          const nm = nameFromSubject(rawSubj);
          if (nm) names.add(nm);
          const foundHere = [];
          collectEmails(rawSubj, foundHere);
          try {
            const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (full && full.source) {
              const p = await simpleParser(full.source);
              collectEmails(p.subject, foundHere); collectEmails(p.text, foundHere);
              if (p.html) collectEmails(String(p.html).replace(/<[^>]+>/g, ' '), foundHere);
            }
          } catch (e) { /* segue */ }
          if (debug) dbg.push({ subject: rawSubj, name: nm, emails: foundHere, date: dt });
        }
      } finally { lock.release(); }
      try { await client.logout(); } catch (e) {}
      scanOk = true; // chegou aqui = varredura completou
    } else if (debug) {
      dbg.push({ note: 'Sem conta de e-mail conectada ou imapflow ausente', hasAcc: !!acc });
    }
  } catch (err) {
    console.error('signed-emails error:', err && err.message);
    if (debug) dbg.push({ error: err && err.message });
  }

  // Marca os leads como assinados NO BANCO (persistente; nunca desmarca). Assim o selo "✔ Assinado"
  // volta junto com o lead em todo refresh, sem depender de cache do navegador.
  let marked = 0;
  try {
    if (emails.size || names.size) {
      const STOP = { msn:1, sr:1, sra:1, dr:1, dra:1, snr:1, cliente:1, contrato:1, assinado:1, de:1, da:1, do:1, dos:1, das:1, e:1 };
      const toks = (s) => String(s == null ? '' : s)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
        .split(' ').filter(t => t.length >= 3 && !STOP[t]);
      const nameSets = Array.from(names).map(toks).filter(a => a.length);
      const leads = await allRows("SELECT id, name, email, contract_signed, signed_override FROM leads WHERE archived = 0");
      for (const l of (leads || [])) {
        if (l.contract_signed) continue;
        if (l.signed_override) continue; // selo removido manualmente → nunca re-marca
        const em = (l.email || '').trim().toLowerCase();
        let hit = !!(em && emails.has(em));
        if (!hit) {
          const lt = toks(l.name);
          // Matching por NOME só quando o conjunto de tokens é IGUAL ao do contrato assinado
          // (mesmo nº de tokens e todos coincidindo) — ex.: "Maria Eduarda" NÃO casa com
          // "Maria Eduarda Sousa". Evita falso positivo de nomes comuns. E-mail continua sendo
          // o sinal forte. Casos legítimos sem e-mail podem ser confirmados manualmente.
          if (lt.length >= 2) {
            for (const st of nameSets) {
              if (st.length !== lt.length) continue;
              let all = true; for (const t of lt) { if (st.indexOf(t) === -1) { all = false; break; } }
              if (all) { hit = true; break; }
            }
          }
        }
        if (hit) {
          await runQuery("UPDATE leads SET contract_signed = 1 WHERE id = ?", [l.id]);
          marked++;
          try { const full = await getRow("SELECT * FROM leads WHERE id = ?", [l.id]); if (full) sendWebhook('lead.contract_signed', { ...full, tags: full.tags ? JSON.parse(full.tags) : [] }); } catch (e) {}
        }
      }
    }
  } catch (e) { console.error('signed-emails mark error:', e && e.message); }

  const payload = { emails: Array.from(emails), names: Array.from(names), marked };
  return { payload, dbg, scanOk };
}
async function refreshSignedEmails() {
  if (_signedEmailsRunning) return;
  _signedEmailsRunning = true;
  try {
    const { payload, scanOk } = await scanSignedEmails(false);
    if (scanOk) {
      // Varredura OK: atualiza o cache (une com o último bom p/ nunca encolher por uma leitura parcial do IMAP).
      if (_signedEmailsCache.data) {
        const e = new Set([...(_signedEmailsCache.data.emails || []), ...payload.emails]);
        const n = new Set([...(_signedEmailsCache.data.names || []), ...payload.names]);
        payload.emails = Array.from(e); payload.names = Array.from(n);
      }
      _signedEmailsCache = { ts: Date.now(), data: payload };
    }
    // Varredura falhou (IMAP indisponível): mantém o último cache bom (não grava lista vazia).
  } finally {
    _signedEmailsRunning = false;
  }
}
app.get('/api/dashboard/signed-emails', authenticateToken, async (req, res) => {
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  if (debug) {
    // Chamada manual de depuração: varre a IMAP na hora e devolve os detalhes (não usa nem grava cache).
    try {
      const { payload, dbg, scanOk } = await scanSignedEmails(true);
      payload.matched = dbg; payload.matchedCount = dbg.length; payload.scanOk = scanOk;
      return res.json(payload);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  if (_signedEmailsCache.data) {
    // cache de 5 min; se expirou, responde com o que tem e dispara um refresh em background.
    if (Date.now() - _signedEmailsCache.ts >= 5 * 60 * 1000) refreshSignedEmails().catch(() => {});
    return res.json(_signedEmailsCache.data);
  }
  // Ainda sem cache (boot recente): devolve o formato vazio esperado pelo front e dispara o refresh.
  refreshSignedEmails().catch(() => {});
  res.json({ emails: [], names: [], marked: 0 });
});

// 7. Conversations Routes: Get List (exclude archived leads' conversations)
// Etapa 4 (perf): busca a ULTIMA mensagem de TODAS as conversas em 1 unica query agregada
// (em vez de 1 query por conversa dentro de um loop). Usa o indice existente em
// messages(conversationId, timestamp). Empate de timestamp na mesma conversa: desempata por
// MAX(id), reproduzindo o comportamento pratico do antigo "ORDER BY timestamp DESC LIMIT 1".
// Retorna um Map conversationId -> { id, from, text, time, type, timestamp } (mesmos campos
// que o SELECT antigo devolvia para cada conversa).
async function getLastMessagesMap() {
  const rows = await allRows(
    "SELECT m.id, m.conversationId, m.`from`, m.text, m.time, m.type, m.timestamp " +
    "FROM messages m " +
    "JOIN (SELECT conversationId, MAX(timestamp) AS mx FROM messages GROUP BY conversationId) g " +
    "ON g.conversationId = m.conversationId AND g.mx = m.timestamp"
  );
  const map = new Map();
  for (const r of rows) {
    const existing = map.get(r.conversationId);
    if (!existing || r.id > existing.id) {
      map.set(r.conversationId, { id: r.id, from: r.from, text: r.text, time: r.time, type: r.type, timestamp: r.timestamp });
    }
  }
  return map;
}

app.get('/api/conversations', authenticateToken, async (req, res) => {
  const { account } = req.query;
  try {
    let convs;
    // Ordena pela mensagem mais recente (a conversa com atividade mais nova fica no topo).
    const ORDER = " ORDER BY (SELECT MAX(m.timestamp) FROM messages m WHERE m.conversationId = conversations.id) DESC";
    if (account && account !== 'all') {
      convs = await allRows("SELECT * FROM conversations WHERE account = ? AND (archived IS NULL OR archived = 0)" + ORDER, [account]);
    } else {
      convs = await allRows("SELECT * FROM conversations WHERE (archived IS NULL OR archived = 0)" + ORDER);
    }

    // Filtra por LOGIN: PÓS-venda (Alexandre) vê SÓ conversas das linhas pós (2030);
    // pré/admin excluem as conversas das linhas pós. Nunca mascara — só mostra/oculta.
    // ?all=1 (pedido do Henry, 2026-07-08): PULA o filtro de ambiente — usado pelo filtro por
    // RESPONSÁVEL da Caixa WhatsApp, que precisa enxergar pré E pós juntos.
    try {
      const { posSet } = await getSaleLineFilter();
      if (posSet.size && String(req.query.all) !== '1') {
        const isPos = await userIsPos(req);
        if (isPos) {
          // Pós: SÓ conversas cujo lead está NO PIPELINE pós (2030 + Vendas Concretizadas + Clientes
          // Antigos), incluindo o HISTÓRICO em linhas do pré (read-only, com o nº do pré). Conversas
          // SEM lead no pipeline (órfãs) NÃO aparecem.
          const { posSet: pLines, posDigits } = await posLineInfo();
          const allLeads = await allRows("SELECT whatsapp_jid, phone, stage, account, recv_number FROM leads WHERE archived = 0");
          const pipeJ = new Set(), pipeT = new Set();   // leads que estão no pipeline pós
          for (const l of allLeads) {
            const isHist = l.stage === 'convertida' || l.stage === 'clientes_antigos';
            if (!(leadIsPos(l, pLines, posDigits) || isHist)) continue;
            const t = String(l.phone || '').replace(/\D/g, '').slice(-8);
            if (l.whatsapp_jid) pipeJ.add(l.whatsapp_jid);
            if (t.length >= 8) pipeT.add(t);
          }
          const matchSet = (c, jset, tset) => {
            if (c.whatsapp_jid && jset.has(c.whatsapp_jid)) return true;
            const t = String(c.phone || '').replace(/\D/g, '').slice(-8);
            return t.length >= 8 && tset.has(t);
          };
          const numByAcc = {};
          try { const accs = await allRows("SELECT id, number FROM whatsapp_accounts"); accs.forEach(a => { numByAcc[a.id] = a.number; }); } catch (e) {}
          // Mostra TODAS as conversas dos leads do pipeline pós. As atendidas por uma linha DIFERENTE
          // do 2030 (números herdados do pré) também aparecem, com o nº do pré entre parênteses.
          convs = (convs || []).filter(c => matchSet(c, pipeJ, pipeT)).map(c => {
            if (posSet.has(c.account)) return c;                 // conversa na linha 2030 (pós): normal
            return Object.assign({}, c, { _saleHistory: 1, _saleLineNumber: numByAcc[c.account] || c.recv_number || '' });
          });
        } else {
          convs = (convs || []).filter(c => !posSet.has(c.account));
        }
      }
    } catch (e) { /* em caso de falha, não filtra */ }

    // Attach last message for each conversation (1 query agregada em vez de N — elimina o N+1)
    const lastMsgMap = await getLastMessagesMap();
    const detailedConvs = convs.map(c => ({
      ...c,
      online: Boolean(c.online),
      lastMessage: lastMsgMap.get(c.id) || null
    }));

    res.json(detailedConvs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7b. Conversations Routes: editar dados do contato (nome/telefone)
app.patch('/api/conversations/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, phone } = req.body || {};
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
    const updates = [], params = [];
    if (name !== undefined && String(name).trim()) { updates.push("name = ?"); params.push(String(name).trim()); }
    if (phone !== undefined && String(phone).trim()) { updates.push("phone = ?"); params.push(String(phone).trim()); }
    if (updates.length) {
      params.push(id);
      await runQuery("UPDATE conversations SET " + updates.join(', ') + " WHERE id = ?", params);
    }
    const updated = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    res.json({ ...updated, online: Boolean(updated.online) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Conversations Routes: Get Details (Messages list)
app.get('/api/conversations/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) {
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    const messages = await allRows(
      "SELECT id, \`from\`, text, time, type, timestamp, status, edited, deleted, our_number FROM messages WHERE conversationId = ? ORDER BY timestamp ASC",
      [id]
    );

    // Reset unread count
    await runQuery("UPDATE conversations SET unread = 0 WHERE id = ?", [id]);

    res.json({
      ...convo,
      online: Boolean(convo.online),
      messages
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8b. Marcar conversa como LIDA / NÃO LIDA (bolinha) — sinalização manual.
app.post('/api/conversations/:id/read', authenticateToken, async (req, res) => {
  try {
    await runQuery("UPDATE conversations SET unread = 0 WHERE id = ?", [req.params.id]);
    res.json({ success: true, unread: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/conversations/:id/mark-unread', authenticateToken, async (req, res) => {
  try {
    await runQuery("UPDATE conversations SET unread = CASE WHEN unread > 0 THEN unread ELSE 1 END WHERE id = ?", [req.params.id]);
    const c = await getRow("SELECT unread FROM conversations WHERE id = ?", [req.params.id]);
    res.json({ success: true, unread: (c && c.unread) || 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9. Conversations Routes: Send Message
app.post('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Texto é obrigatório" });
  }

  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) {
      return res.status(404).json({ error: "Conversa não encontrada" });
    }
    // Roteamento de linha no envio (vale para TODOS os celulares/ambientes):
    // - Pós: envia sempre por uma linha do pós CONECTADA (mesmo que a linha da conversa seja
    //   pré ou tenha caído — ex.: número duplicado com um slot caído).
    // - Pré/admin: não usa linha do pós; e se a linha da conversa CAIU, roteia para outra linha
    //   do mesmo ambiente (não-pós) que esteja conectada. Assim o envio não falha só porque
    //   aquela linha específica está desconectada (evita o "Falha ao enviar").
    try {
      const { posSet } = await getSaleLineFilter();
      const isOpenLine = (a) => !!(sessions[a] && sessions[a].ws && sessions[a].ws.isOpen);
      const isPos = posSet.size ? await userIsPos(req) : false;
      let convPos = posSet.has(convo.account);
      const lineOpen = isOpenLine(convo.account);
      if (posSet.size && isPos) {
        if (!convPos || !lineOpen) {
          const posConn = [...posSet].find(isOpenLine);
          if (posConn && posConn !== convo.account) {
            await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [posConn, id]);
            convo.account = posConn;
            convPos = true;
          } else if (!posConn) {
            return res.status(409).json({ error: 'Nenhuma linha do pós-venda está conectada. Conecte o número do pós-venda em Conexões.' });
          }
        }
      } else {
        // PRÉ/ADMIN: conversa presa numa linha do PÓS (card migrou de ambiente — fix 2026-07-04,
        // caso Yasmim/Levi: "Esta linha é do ambiente pós-venda" bloqueava o envio) OU linha
        // caída → roteia p/ uma linha do pré conectada, ESPELHO do que o pós já fazia acima.
        if ((posSet.size && convPos) || !lineOpen) {
          const preConn = Object.keys(sessions).find(a => isOpenLine(a) && !posSet.has(a));
          if (preConn && preConn !== convo.account) {
            await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [preConn, id]);
            convo.account = preConn;
          } else if (posSet.size && convPos) {
            return res.status(409).json({ error: 'Nenhuma linha do pré-venda está conectada para assumir esta conversa (ela está numa linha do pós). Conecte uma linha do pré em Conexões.' });
          }
        }
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }

    // Bookkeeping do envio (zera a bolinha, move lead p/ "tratamento", tira "novo lead",
    // carimba a linha). Roda DEPOIS de responder o card (fire-and-forget) — assim o envio
    // não espera estas consultas, várias das quais varrem a tabela inteira (phone LIKE com
    // função, sem índice). A chamada está logo após o res.json.
    const doSendBookkeeping = async () => {
    await runQuery("UPDATE conversations SET unread = 0 WHERE id = ?", [id]);
    try {
      if (convo.whatsapp_jid) {
        await runQuery("UPDATE leads SET lastClientReply = NULL WHERE whatsapp_jid = ?", [convo.whatsapp_jid]);
      }
      const cleanP = (convo.phone || '').replace(/\D/g, '');
      if (cleanP.length >= 8) {
        await runQuery("UPDATE leads SET lastClientReply = NULL WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?", [`%${cleanP.slice(-8)}%`]);
      }
      // Novos Leads: ao responder, move automaticamente para "Tratamento inicial" e aplica tag Follow-up.
      if (convo.whatsapp_jid) {
        await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'followup' WHERE stage = 'novo' AND whatsapp_jid = ?", [convo.whatsapp_jid]);
      }
      if (cleanP.length >= 8) {
        await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'followup' WHERE stage = 'novo' AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?", [`%${cleanP.slice(-8)}%`]);
      }
      // 1ª resposta humana (pela tela do CRM) também REMOVE a tag "Novo lead" — sai da 1ª coluna do Tratamento.
      if (convo.whatsapp_jid) {
        await runQuery("UPDATE leads SET priority = '' WHERE priority = 'novolead' AND whatsapp_jid = ?", [convo.whatsapp_jid]);
      }
      if (cleanP.length >= 8) {
        await runQuery("UPDATE leads SET priority = '' WHERE priority = 'novolead' AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?", [`%${cleanP.slice(-8)}%`]);
      }
      // CARIMBA a LINHA da conversa no lead (account + recv_number) QUANDO o lead ainda está SEM linha —
      // assim o card mostra "via <número>" da linha por onde a comunicação realmente acontece. (Não
      // sobrescreve quem já tem linha, p/ não trocar o ambiente de quem já está atribuído.)
      if (convo.account && convo.account !== 'ig') {
        const accRow = await getRow("SELECT number FROM whatsapp_accounts WHERE id = ?", [convo.account]);
        const accNum = (accRow && accRow.number) || '';
        if (accNum) {
          const EMPTY = "(account IS NULL OR TRIM(account) = '' OR recv_number IS NULL OR TRIM(recv_number) = '')";
          if (convo.whatsapp_jid) await runQuery("UPDATE leads SET account = ?, recv_number = ? WHERE whatsapp_jid = ? AND " + EMPTY, [convo.account, accNum, convo.whatsapp_jid]);
          if (cleanP.length >= 8) await runQuery("UPDATE leads SET account = ?, recv_number = ? WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? AND " + EMPTY, [convo.account, accNum, `%${cleanP.slice(-8)}%`]);
        }
      }
    } catch (e) { /* ignore */ }
    };

    // Instagram: envia pelo Direct e grava a mensagem
    if (convo.account === 'ig') {
      const recipientId = (convo.whatsapp_jid || '').replace(/^ig:/, '');
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const msgId = 'm_' + Math.random().toString(36).substr(2, 9);
      try {
        await sendIgMessage(recipientId, text);
      } catch (e) {
        let raw = String(e && e.message || '');
        const isWindow = /24|outside|window|allowed|messaging window/i.test(raw);
        // Fora da janela de 24h: tenta novamente com a tag HUMAN_AGENT (janela de 7 dias).
        // Só terá efeito se o recurso "Human Agent" estiver aprovado para o app na Meta.
        if (isWindow) {
          try {
            await sendIgMessage(recipientId, text, { humanAgent: true });
            // sucesso no retry → cai fora do catch seguindo o fluxo normal de gravação
            raw = '';
          } catch (e2) {
            raw = String(e2 && e2.message || raw);
          }
        }
        if (raw) {
          let friendly = 'Falha ao enviar no Instagram: ' + raw;
          if (/24|outside|window|allowed|messaging window/i.test(raw)) {
            friendly = 'O Instagram só permite responder até 24h após a última mensagem da pessoa (ou 7 dias com o recurso "Human Agent" aprovado pela Meta). Esta conversa está fora dessa janela — peça que ela envie uma nova mensagem para reabrir o contato.';
          } else if (/token|expired|session|OAuth|permission|#10|#200/i.test(raw)) {
            friendly = 'Não foi possível enviar: a conexão do Instagram pode ter expirado ou faltam permissões. Reconecte o Instagram em Configurações → Conexões. (' + raw + ')';
          }
          return res.status(502).json({ error: friendly });
        }
      }
      await runQuery("INSERT INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)", [msgId, id, 'me', text, timeStr, Date.now()]);
      await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, id]);
      res.json({ id: msgId, conversationId: id, from: 'me', text: text, time: timeStr, timestamp: Date.now() });
      doSendBookkeeping().catch(() => {});
      return;
    }

    const accountId = convo.account;
    const isConnected = sessions[accountId] && sessions[accountId].ws.isOpen;

    let messageObj;

    if (isConnected) {
      // Send real WhatsApp message
      messageObj = await sendWhatsAppMessage(accountId, id, text);
    } else {
      // Linha desconectada: NÃO grava mensagem fantasma (antes ela ficava com o relógio
      // "pendente" para sempre, dando impressão de que enviou). Avisa para reconectar.
      return res.status(409).json({ error: 'A linha do WhatsApp desta conversa está desconectada. Reconecte-a em Conexões e tente enviar de novo.' });
      // (bloco antigo de fallback offline removido)
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const msgId = 'm_' + Math.random().toString(36).substr(2, 9);

      await runQuery(
        "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
        [msgId, id, 'me', text, timeStr, Date.now()]
      );

      await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, id]);

      messageObj = {
        id: msgId,
        from: 'me',
        text,
        time: timeStr
      };
    }

    res.json(messageObj);
    doSendBookkeeping().catch(() => {});
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: err.message });
  }
});

// 9a-bis. Inicia a conversa de WhatsApp de um lead que ainda NÃO tem conversa e envia a 1ª mensagem.
// O front detecta automaticamente (sem botão extra): quando não há conversa, manda o texto por aqui.
// Cria a conversa na linha escolhida (account) e dispara a mensagem real. Requer a linha conectada.
app.post('/api/leads/:leadId/start-conversation', authenticateToken, async (req, res) => {
  const { leadId } = req.params;
  const account = String((req.body && req.body.account) || '').trim();
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Texto é obrigatório' });
  try {
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const jidLead = lead.whatsapp_jid || '';
    const digits = String(lead.phone || '').replace(/\D/g, '');
    if (!jidLead && digits.length < 8) {
      return res.status(400).json({ error: 'Este lead não tem WhatsApp (telefone) para iniciar conversa.' });
    }

    // Linha de envio: a escolhida; senão a do lead; senão a 1ª sessão conectada.
    const isOpen = (a) => sessions[a] && sessions[a].ws && sessions[a].ws.isOpen;
    let accountId = account || lead.account || '';
    if (!isOpen(accountId)) {
      const connected = Object.keys(sessions).find(isOpen);
      if (connected) accountId = connected;
    }
    // Ambiente PÓS: conversa nova deve sair por uma linha do pós CONECTADA (não por uma linha pré).
    try {
      const { posSet: _ps } = await getSaleLineFilter();
      if (_ps.size && (await userIsPos(req)) && !_ps.has(accountId)) {
        const _posConn = [...(_ps)].find(isOpen);
        if (_posConn) accountId = _posConn;
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }
    if (!isOpen(accountId)) {
      return res.status(409).json({ error: 'A linha de WhatsApp escolhida não está conectada. Conecte-a em Conexões e tente de novo.' });
    }

    // Já existe conversa? (por jid ou últimos 8 dígitos) → reaproveita em vez de duplicar.
    const last8 = digits.slice(-8);
    const all = await allRows("SELECT * FROM conversations WHERE (archived IS NULL OR archived = 0)");
    let convo = all.find(c =>
      (jidLead && c.whatsapp_jid === jidLead) ||
      (last8.length === 8 && String(c.phone || '').replace(/\D/g, '').slice(-8) === last8) ||
      (last8.length === 8 && String(c.whatsapp_jid || '').split('@')[0].replace(/\D/g, '').slice(-8) === last8)
    ) || null;

    if (!convo) {
      const convoId = 'c_' + Math.random().toString(36).substr(2, 9);
      const nm = lead.name || (digits || 'Lead');
      const av = String(nm).slice(0, 2).toUpperCase();
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
      await runQuery(
        "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, whatsapp_jid, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [convoId, accountId, nm, String(lead.phone || ''), av, timeStr, 0, 0, jidLead || null, 0]
      );
      convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
    }

    // Envia a 1ª mensagem real pelo WhatsApp (mesma rotina do envio normal).
    const messageObj = await sendWhatsAppMessage(accountId, convo.id, text);

    // 1ª resposta humana: tira de "Novo lead" e move 'novo' → 'tratamento' (igual ao responder).
    try {
      await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'followup' WHERE id = ? AND stage = 'novo'", [lead.id]);
      await runQuery("UPDATE leads SET priority = '' WHERE id = ? AND priority = 'novolead'", [lead.id]);
      await runQuery("UPDATE leads SET lastClientReply = NULL WHERE id = ?", [lead.id]);
      // CARIMBA a LINHA usada no lead (account + recv_number) → o card passa a mostrar "via <número>".
      // Você iniciou a conversa por esta linha, então é a linha de comunicação de fato do lead.
      const accRow = await getRow("SELECT number FROM whatsapp_accounts WHERE id = ?", [accountId]);
      const accNum = (accRow && accRow.number) || '';
      if (accNum) await runQuery("UPDATE leads SET account = ?, recv_number = ? WHERE id = ?", [accountId, accNum, lead.id]);
    } catch (e) { /* ignore */ }

    res.json({ conversation: { ...convo, account: accountId }, message: messageObj });
  } catch (err) {
    console.error('start-conversation error:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Falha ao iniciar conversa.' });
  }
});

// 9b. Conversations Routes: Send Voice Note (multipart com fallback base64 no body — achado 1.8)
app.post('/api/conversations/:id/audio', authenticateToken, uploadSingle('file'), async (req, res) => {
  const { id } = req.params;
  const { audio, mimetype } = req.body;
  if (!req.file && !audio) return res.status(400).json({ error: "Áudio é obrigatório" });

  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });

    const buffer = req.file ? req.file.buffer : Buffer.from(audio, 'base64');
    let accountId = convo.account;
    // Roteia pela linha do AMBIENTE do usuário — MESMA regra do envio de texto (fix 2026-07-04,
    // pedido do Henry: "tem que mandar mensagem e áudio independente se mudou ambiente ou
    // WhatsApp"). Card que migrou deixava a conversa presa na linha do outro lado e o áudio
    // falhava/saía pela linha errada. Pós → linha pós conectada; pré/admin → linha não-pós.
    try {
      const { posSet } = await getSaleLineFilter();
      const isOpenLine = (a) => !!(sessions[a] && sessions[a].ws && sessions[a].ws.isOpen);
      if (posSet.size) {
        const isPos = await userIsPos(req);
        const ok = (a) => isOpenLine(a) && (isPos ? posSet.has(a) : !posSet.has(a));
        if (!ok(accountId)) {
          const alt = Object.keys(sessions).find(ok);
          if (alt) { await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [alt, id]); convo.account = alt; accountId = alt; }
        }
      } else if (!isOpenLine(accountId)) {
        const alt = Object.keys(sessions).find(isOpenLine);
        if (alt) { await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [alt, id]); convo.account = alt; accountId = alt; }
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }
    const isConnected = sessions[accountId] && sessions[accountId].ws.isOpen;

    let messageObj;
    if (isConnected) {
      messageObj = await sendWhatsAppAudio(accountId, id, buffer);
    } else {
      // Offline fallback: store locally so it still appears in the CRM
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const msgId = 'm_' + Math.random().toString(36).substr(2, 9);
      const ext = (mimetype && mimetype.includes('ogg')) ? '.ogg' : ((mimetype && mimetype.includes('mp4')) ? '.mp4' : '.webm');
      const mediaPath = path.join(MEDIA_DIR, msgId + ext);
      try { fs.writeFileSync(mediaPath, buffer); } catch (e) {}
      await runQuery(
        "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [msgId, id, 'me', '[Mensagem de voz]', timeStr, Date.now(), 'audio', mediaPath]
      );
      await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, id]);
      messageObj = { id: msgId, from: 'me', text: '[Mensagem de voz]', time: timeStr, type: 'audio' };
    }
    res.json(messageObj);
  } catch (err) {
    console.error("Error sending audio:", err);
    res.status(500).json({ error: err.message });
  }
});

// 9b1b. Conversations Routes: enviar foto/vídeo/documento (multipart com fallback base64 — achado 1.8)
app.post('/api/conversations/:id/media', authenticateToken, uploadSingle('file'), async (req, res) => {
  const { id } = req.params;
  const { data, mimetype, fileName } = req.body || {};
  if (!req.file && !data) return res.status(400).json({ error: "Arquivo é obrigatório" });
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
    const buffer = req.file ? req.file.buffer : Buffer.from(data, 'base64');
    if (buffer.length > 16 * 1024 * 1024) return res.status(400).json({ error: "Arquivo acima de 16 MB" });
    let accountId = convo.account;
    // Mesma regra de roteamento por ambiente do texto/áudio (fix 2026-07-04) — ver rota /audio.
    try {
      const { posSet } = await getSaleLineFilter();
      const isOpenLine = (a) => !!(sessions[a] && sessions[a].ws && sessions[a].ws.isOpen);
      if (posSet.size) {
        const isPos = await userIsPos(req);
        const ok = (a) => isOpenLine(a) && (isPos ? posSet.has(a) : !posSet.has(a));
        if (!ok(accountId)) {
          const alt = Object.keys(sessions).find(ok);
          if (alt) { await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [alt, id]); convo.account = alt; accountId = alt; }
        }
      } else if (!isOpenLine(accountId)) {
        const alt = Object.keys(sessions).find(isOpenLine);
        if (alt) { await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [alt, id]); convo.account = alt; accountId = alt; }
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }
    const isConnected = sessions[accountId] && sessions[accountId].ws.isOpen;
    let messageObj;
    if (isConnected) {
      messageObj = await sendWhatsAppMedia(accountId, id, buffer, mimetype, fileName);
    } else {
      // Offline: guarda localmente para aparecer no CRM mesmo sem conexão
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const msgId = 'm_' + Math.random().toString(36).substr(2, 9);
      const mime = String(mimetype || '').toLowerCase();
      const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'document';
      let ext = path.extname(fileName || '');
      if (!ext) ext = type === 'image' ? '.jpg' : type === 'video' ? '.mp4' : '.bin';
      const mediaPath = path.join(MEDIA_DIR, msgId + ext);
      try { fs.writeFileSync(mediaPath, buffer); } catch (e) {}
      await runQuery(
        "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [msgId, id, 'me', fileName || '[Arquivo]', timeStr, Date.now(), type, mediaPath]
      );
      await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, id]);
      messageObj = { id: msgId, from: 'me', text: fileName || '[Arquivo]', time: timeStr, type: type };
    }
    res.json(messageObj);
  } catch (err) {
    console.error("Error sending media:", err);
    res.status(500).json({ error: err.message });
  }
});

// 9b2. Conversations Routes: Archive a conversation (esconde da lista de WhatsApp)
// Deletar um contato/conversa da Caixa de Entrada (remove a conversa e o histórico no CRM).
app.delete('/api/conversations/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: 'Conversa não encontrada' });
    // SNAPSHOT do histórico de comunicação ANTES de apagar — o histórico do cliente NÃO pode ser perdido
    // ao deletar o contato (requisito do Henry). Cada mensagem vira um evento 'mensagem' no lead_history
    // (vinculado pelo telefone; e por lead_id se existir um lead com esse número). Como a leitura mescla
    // mensagens AO VIVO só enquanto a conversa existe, não há duplicidade (após apagar, fica só o snapshot).
    try {
      const digits = String(convo.phone || '').replace(/\D/g, '');
      const tail = digits.slice(-8);
      let leadRow = null;
      if (convo.whatsapp_jid) leadRow = await getRow("SELECT id FROM leads WHERE whatsapp_jid = ? LIMIT 1", [convo.whatsapp_jid]);
      if (!leadRow && tail.length >= 8) leadRow = await getRow("SELECT id FROM leads WHERE phone LIKE ? LIMIT 1", ['%' + tail + '%']);
      const msgs = await allRows("SELECT `from`, text, type, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp ASC", [id]);
      for (const m of msgs) {
        const ts = Number(m.timestamp) || 0;
        const ms = ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : Date.now();
        const txt = m.text || (m.type && m.type !== 'text' ? '[' + m.type + ']' : '');
        await runQuery(
          "INSERT INTO lead_history (id, lead_id, phone, name, type, detail, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [_histId(), (leadRow && leadRow.id) || null, digits || null, convo.name || null, 'mensagem', txt, JSON.stringify({ from: m.from, snapshot: 1 }), new Date(ms).toISOString()]
        );
      }
    } catch (e) { console.error('[history] snapshot falhou:', e && e.message); }
    await runQuery("DELETE FROM messages WHERE conversationId = ?", [id]);
    await runQuery("DELETE FROM conversations WHERE id = ?", [id]);
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Editar o texto de uma mensagem JÁ enviada por nós (texto, janela ~15 min no WhatsApp).
app.patch('/api/conversations/:id/messages/:mid', authenticateToken, async (req, res) => {
  const { id, mid } = req.params;
  const { text } = req.body;
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Texto é obrigatório' });
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: 'Conversa não encontrada' });
    const msg = await getRow("SELECT * FROM messages WHERE id = ? AND conversationId = ?", [mid, id]);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.from !== 'me') return res.status(403).json({ error: 'Só dá para editar mensagens que você enviou.' });
    if (msg.type && msg.type !== 'text') return res.status(400).json({ error: 'Só mensagens de texto podem ser editadas.' });
    try {
      const { posSet } = await getSaleLineFilter();
      if (posSet.size) {
        const isPos = await userIsPos(req); const convPos = posSet.has(convo.account);
        if (isPos !== convPos) return res.status(403).json({ error: 'Sem permissão neste ambiente.' });
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }
    if (convo.account === 'ig') return res.status(400).json({ error: 'Edição não é suportada no Instagram.' });
    if (!(sessions[convo.account] && sessions[convo.account].ws && sessions[convo.account].ws.isOpen)) return res.status(409).json({ error: 'A linha do WhatsApp está desconectada.' });
    const r = await editWhatsAppMessage(convo.account, id, mid, String(text).trim());
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apagar PARA TODOS uma mensagem enviada por nós (texto ou áudio).
app.delete('/api/conversations/:id/messages/:mid', authenticateToken, async (req, res) => {
  const { id, mid } = req.params;
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: 'Conversa não encontrada' });
    const msg = await getRow("SELECT * FROM messages WHERE id = ? AND conversationId = ?", [mid, id]);
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.from !== 'me') return res.status(403).json({ error: 'Só dá para apagar para todos as mensagens que você enviou.' });
    try {
      const { posSet } = await getSaleLineFilter();
      if (posSet.size) {
        const isPos = await userIsPos(req); const convPos = posSet.has(convo.account);
        if (isPos !== convPos) return res.status(403).json({ error: 'Sem permissão neste ambiente.' });
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }
    if (convo.account === 'ig') return res.status(400).json({ error: 'Apagar não é suportado no Instagram.' });
    if (!(sessions[convo.account] && sessions[convo.account].ws && sessions[convo.account].ws.isOpen)) return res.status(409).json({ error: 'A linha do WhatsApp está desconectada.' });
    const r = await deleteWhatsAppMessage(convo.account, id, mid);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/conversations/:id/archive', authenticateToken, async (req, res) => {
  try {
    await runQuery("UPDATE conversations SET archived = 1 WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Migra a conversa para outra linha de WhatsApp (as próximas mensagens saem por ela).
app.patch('/api/conversations/:id/account', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { account } = req.body || {};
  if (!account) return res.status(400).json({ error: "account obrigatório" });
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
    const acc = await getRow("SELECT id, number FROM whatsapp_accounts WHERE id = ?", [account]);
    if (!acc) return res.status(400).json({ error: "Linha de WhatsApp inválida" });
    await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [account, id]);
    // Mantém o(s) lead(s) correspondente(s) em sincronia (linha de atendimento exibida no card).
    const newNumber = acc.number || null;
    if (convo.whatsapp_jid) {
      await runQuery("UPDATE leads SET account = ?, recv_number = ? WHERE whatsapp_jid = ?", [account, newNumber, convo.whatsapp_jid]);
    }
    const cleanP = (convo.phone || '').replace(/\D/g, '');
    if (cleanP.length >= 8) {
      await runQuery("UPDATE leads SET account = ?, recv_number = ? WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?", [account, newNumber, `%${cleanP.slice(-8)}%`]);
    }
    res.json({ success: true, account, number: newNumber });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9c. Media Routes: Serve a message's audio/media file.
// Auth via Authorization header OR ?token= (needed so <audio src> can load it).
app.get('/api/media/:msgId', async (req, res) => {
  const token = (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ detail: "Não autenticado" });
  try { jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(403).json({ detail: "Token inválido" }); }

  try {
    const msg = await getRow("SELECT mediaPath FROM messages WHERE id = ?", [req.params.msgId]);
    if (!msg || !msg.mediaPath || !fs.existsSync(msg.mediaPath)) {
      return res.status(404).json({ error: "Mídia não encontrada" });
    }
    const ext = path.extname(msg.mediaPath).toLowerCase();
    const ctypeMap = {
      '.ogg':'audio/ogg', '.webm':'audio/webm', '.m4a':'audio/mp4', '.mp3':'audio/mpeg', '.amr':'audio/amr',
      '.mp4':'video/mp4', '.3gp':'video/3gpp', '.mov':'video/quicktime',
      '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp',
      '.pdf':'application/pdf', '.doc':'application/msword',
      '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls':'application/vnd.ms-excel',
      '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt':'text/plain', '.zip':'application/zip'
    };
    const ctype = ctypeMap[ext] || 'application/octet-stream';
    // Cabeçalhos que fazem o áudio TOCAR NA HORA (antes demorava): Content-Length + Accept-Ranges
    // (o Chrome pede só o pedaço que precisa e calcula a duração sem baixar tudo — sumia o
    // "0:00/0:00") e Cache-Control (mídia é imutável: o re-render do chat não re-baixa nada).
    const st = fs.statSync(msg.mediaPath);
    res.setHeader('Content-Type', ctype);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(range));
      let start = (m && m[1]) ? parseInt(m[1], 10) : 0;
      let end = (m && m[2]) ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        res.setHeader('Content-Range', 'bytes */' + st.size);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + st.size);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(msg.mediaPath, { start: start, end: end }).pipe(res);
    }
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(msg.mediaPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Foto de perfil do WhatsApp (avatar) do contato. Token via query (para usar em <img src>).
// Se ainda não baixou, tenta baixar na hora usando qualquer sessão conectada.
app.get('/api/avatar', async (req, res) => {
  const token = (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).end();
  try { jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(403).end(); }
  try {
    let jid = (req.query.jid || '').trim();
    const phone = (req.query.phone || '').replace(/\D/g, '');
    if (!jid && phone.length >= 8) {
      const row = await getRow("SELECT whatsapp_jid FROM conversations WHERE whatsapp_jid IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", [`%${phone.slice(-8)}%`]);
      if (row && row.whatsapp_jid) jid = row.whatsapp_jid;
    }
    if (!jid) return res.status(404).end();
    // Instagram: a "foto" é o profile_pic da Graph API guardado em conversations.avatar.
    // Fazemos proxy (a URL do CDN da Meta expira), com cache curto.
    if (jid.indexOf('ig:') === 0) {
      const c = await getRow("SELECT avatar FROM conversations WHERE whatsapp_jid = ? LIMIT 1", [jid]);
      if (c && /^https?:/i.test(c.avatar || '')) {
        try {
          const r = await fetch(c.avatar);
          if (r.ok) {
            res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            const buf = Buffer.from(await r.arrayBuffer());
            return res.end(buf);
          }
        } catch (e) {}
      }
      return res.status(404).end();
    }
    const file = avatarFileForJid(jid);
    if (!fs.existsSync(file)) {
      const sock = Object.values(sessions || {}).find(s => s);
      if (sock) { try { await fetchAndStoreAvatar(sock, jid); } catch (e) {} }
    }
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(file).pipe(res);
  } catch (err) { res.status(500).end(); }
});

// Comprovante de pagamento do lead (anexo que persiste de Follow-up até Venda convertida).
// Upload em base64 (JSON), salvo no MEDIA_DIR; o caminho fica em leads.payment_proof.
app.post('/api/leads/:id/payment-proof', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { filename, content, contentType } = req.body || {};
    if (!content) return res.status(400).json({ error: 'Arquivo ausente' });
    const lead = await getRow("SELECT id, payment_proof FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const buf = Buffer.from(String(content).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ error: 'Arquivo vazio' });
    if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo acima de 12 MB' });
    let ext = (String(filename || '').match(/\.([a-z0-9]{2,5})$/i) || ['', ''])[1].toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf'].includes(ext)) {
      const ctMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
      ext = ctMap[String(contentType || '').toLowerCase()] || 'bin';
    }
    if (lead.payment_proof) { try { const old = path.join(MEDIA_DIR, path.basename(lead.payment_proof)); if (fs.existsSync(old)) fs.unlinkSync(old); } catch (e) {} }
    const fname = 'proof_' + id + '_' + Date.now() + '.' + ext;
    fs.writeFileSync(path.join(MEDIA_DIR, fname), buf);
    await runQuery("UPDATE leads SET payment_proof = ? WHERE id = ?", [fname, id]);
    res.json({ success: true, payment_proof: fname });
  } catch (e) { console.error('[payment-proof upload]', e && e.message); res.status(500).json({ error: e.message }); }
});

// Serve o comprovante (token via header OU ?token= para usar em <img>/nova aba).
app.get('/api/leads/:id/payment-proof', async (req, res) => {
  const token = (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).end();
  try { jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(403).end(); }
  try {
    const lead = await getRow("SELECT payment_proof FROM leads WHERE id = ?", [req.params.id]);
    if (!lead || !lead.payment_proof) return res.status(404).end();
    const file = path.join(MEDIA_DIR, path.basename(lead.payment_proof));
    if (!fs.existsSync(file)) return res.status(404).end();
    const ext = (lead.payment_proof.match(/\.([a-z0-9]+)$/i) || ['', ''])[1].toLowerCase();
    const ctMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };
    res.setHeader('Content-Type', ctMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.status(500).end(); }
});

// Remove o comprovante de pagamento do lead.
app.delete('/api/leads/:id/payment-proof', authenticateToken, async (req, res) => {
  try {
    const lead = await getRow("SELECT payment_proof FROM leads WHERE id = ?", [req.params.id]);
    if (lead && lead.payment_proof) { try { const f = path.join(MEDIA_DIR, path.basename(lead.payment_proof)); if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {} }
    await runQuery("UPDATE leads SET payment_proof = NULL WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 9d. Leads Routes: Find or create a conversation for a lead (open chat from lead modal)
// ENCERRAR ATENDIMENTO (pedido do Henry, 2026-07-05 — vale p/ cards do pré E do pós): exige o
// motivo de declínio/cancelamento, move o card p/ "Lead declinou/cancelado" com a marca
// service_closed=1 (fica VISÍVEL na coluna — decisão do Henry) e ARQUIVA a conversa do WhatsApp.
// Reabertura: no messages.upsert (whatsapp.js), lead com service_closed=1 que manda nova mensagem
// volta à coluna "Novo Leads" do PRÉ; a conversa desarquiva sozinha ao receber mensagem e TODO o
// histórico permanece (nada é apagado); motivo/encerramento ficam no lead_history.
app.post('/api/leads/:id/close-service', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'Informe o motivo do declínio/cancelamento.' });
  try {
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    await runQuery(
      "UPDATE leads SET stage = 'declinado', decline_reason = ?, pos_stage = NULL, bridge = 0, priority = '', lastClientReply = NULL, service_closed = 1 WHERE id = ?",
      [reason, id]
    );
    try {
      const convo = await findConvoForLead(lead);
      if (convo) await runQuery("UPDATE conversations SET archived = 1, unread = 0 WHERE id = ?", [convo.id]);
    } catch (e) {}
    try { logLeadHistory({ leadId: id, phone: lead.phone, name: lead.name, type: 'movimentacao', detail: 'Atendimento ENCERRADO — Lead declinou/cancelado. Motivo: ' + reason, meta: { to: 'declinado', motivo: reason, encerrado: 1 } }); } catch (e) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Localiza a conversa de um lead SEM filtro de ambiente (fix 2026-07-04, caso Sonia Silva):
// o chat do card procurava na lista GET /conversations (filtrada por ambiente) — se o histórico
// estava numa linha do OUTRO ambiente, mostrava "Ainda não há conversa" e, ao enviar, nascia uma
// 2ª conversa sem o histórico. Aqui usa findConvoForLead (jid → últimos 8 dígitos, varre tudo).
app.get('/api/leads/:id/conversation', authenticateToken, async (req, res) => {
  try {
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const convo = await findConvoForLead(lead);
    res.json(convo || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:id/open-conversation', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
    if (!lead.phone) return res.status(400).json({ error: "Lead sem telefone" });

    const digits = lead.phone.replace(/\D/g, '');
    const tail = digits.slice(-8);
    let convo = null;
    if (tail.length >= 8) {
      convo = await getRow(
        "SELECT * FROM conversations WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?",
        [`%${tail}%`]
      );
    }

    if (!convo) {
      const convoId = 'c_' + Math.random().toString(36).substr(2, 9);
      const avatar = (lead.name || '?').slice(0, 2).toUpperCase();
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      await runQuery(
        "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [convoId, lead.account || 'wa1', lead.name || tail, lead.phone, avatar, timeStr, 0, 0, 0]
      );
      convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
    } else if (convo.archived === 1) {
      await runQuery("UPDATE conversations SET archived = 0 WHERE id = ?", [convo.id]);
    }

    res.json({ ...convo, online: Boolean(convo.online) });
  } catch (err) {
    console.error("Error opening conversation:", err);
    res.status(500).json({ error: err.message });
  }
});

// 10. Channels Routes: Get Accounts list
// Ambiente de vendas: 'pre' (padrão) = só pré-venda → linhas marcadas como 'pos' (ex.: wa5/wa6)
// ficam OCULTAS para TODOS os logins (inclusive admin) e não recebem novos leads. O pós-venda
// terá um ambiente próprio depois. Para reexibir as linhas pós aqui: app_settings env_sale_mode='all'.
async function getSaleLineFilter() {
  const envRow = await getRow("SELECT value FROM app_settings WHERE key = 'env_sale_mode'");
  const mode = (envRow && envRow.value) ? String(envRow.value) : 'pre';
  const stRow = await getRow("SELECT value FROM app_settings WHERE key = 'wa_sale_types'");
  let map = {}; try { map = stRow && stRow.value ? JSON.parse(stRow.value) : {}; } catch (e) { map = {}; }
  const posSet = new Set(Object.keys(map).filter(k => map[k] === 'pos'));
  return { mode, posSet, map };
}

// O usuário logado é do ambiente PÓS-VENDA? (wa_type='pos' → vê só o 2030 + vendas convertidas)
async function userIsPos(req) {
  try {
    if (!req.user || !req.user.sub) return false;
    // Ambiente escolhido no LOGIN (claim 'env' do JWT, 09/07/2026) decide primeiro; tokens
    // antigos (sem env) caem no wa_type do cadastro, como antes.
    if (req.user.env === 'pos') return true;
    if (req.user.env === 'pre') return false;
    const u = await getRow("SELECT wa_type FROM users WHERE id = ?", [req.user.sub]);
    return !!(u && String(u.wa_type) === 'pos');
  } catch (e) { return false; }
}
// Linhas pós-venda: ids (wa5/wa6) + últimos 8 dígitos dos números, p/ identificar leads/conversas do 2030.
async function posLineInfo() {
  const { posSet } = await getSaleLineFilter();
  if (!posSet.size) return { posSet, posDigits: [] };
  const ph = Array.from(posSet);
  const accs = await allRows("SELECT id, number FROM whatsapp_accounts WHERE id IN (" + ph.map(() => '?').join(',') + ")", ph);
  const posDigits = accs.map(a => String(a.number || '').replace(/\D/g, '').slice(-8)).filter(d => d.length >= 8);
  return { posSet, posDigits };
}
function leadIsPos(l, posSet, posDigits) {
  if (posSet.has(l.account)) return true;
  const rn = String(l.recv_number || '').replace(/\D/g, '');
  return !!(rn && posDigits.some(d => rn.endsWith(d)));
}
// Colunas do pipeline PÓS-VENDA.
// 'para_classificar' ("Mensagens novas para organizar") foi EXTINTA em 2026-07-03 (pedido do
// Henry): cards foram movidos manualmente p/ as colunas certas; qualquer resto/novo cai em
// 'vendas_concretizadas' (Recém Contratados) — ver posStageFor e a migração do db.js.
// 'on_hold' (coluna) também foi EXTINTA em 2026-07-03: o conceito virou a PRIORIDADE 'onhold'
// (tarja vermelha ⛔ no card); os cards foram movidos p/ 'visto_amer_comconta' (migração db.js).
const POS_STAGES = ['clientes_antigos_pos', 'vendas_concretizadas',
  'amer_msgs_novas', 'visto_amer_semconta', 'visto_amer_comconta', 'visto_amer_agendado', 'visto_amer_envio_passaporte', 'visto_amer_concluido',
  'visto_cana_formulario', 'visto_cana_oficiais', 'visto_cana_aprovacao', 'visto_cana_envio', 'visto_cana_biometria', 'visto_cana_finalizado',
  'visto_port_formulario', 'visto_port_entrevista', 'visto_port_aprovacao', 'visto_port_agendamento', 'visto_port_finalizado',
  'visto_aust_formulario', 'visto_aust_oficiais', 'visto_aust_pagamento', 'visto_aust_finalizado',
  'visto_mex_formulario', 'visto_mex_entrevista', 'visto_mex_finalizado',
  'visto_bra_documentacao', 'visto_bra_entrevista',
  'ital_formulario', 'ital_aire', 'ital_passaporte',
  'outros'];
// Colunas do pipeline PÓS-VENDA (com título e cor) — o servidor entrega isto quando o usuário é 'pos'.
// Colunas com 'group' são raias internas agrupadas no frontend sob um título único (banner). Títulos
// são ÚNICOS (o frontend casa coluna→aba/banner por título); por isso o sufixo do visto onde repetiria.
const POS_STAGES_FULL = [
  { id: 'clientes_antigos_pos',   title: 'Comunicação com ambiente Pré-Venda', color: '#6366f1' },
  { id: 'vendas_concretizadas',   title: 'Recém Contratados',                  color: '#16a34a' },
  // Grupo Visto Americano (reforma 2026-07-02, planilha do Henry: branca/laranja/azul/verde/preta)
  // + triagem cinza (2026-07-04): mensagens não lidas das linhas do pós sem coluna caem aqui.
  { id: 'amer_msgs_novas',             title: 'Mensagens novas não classificadas', color: '#6b7280', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_semconta',         title: 'Conta para ser Criada',   color: '#ffffff', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_comconta',         title: 'Com conta e sem agendar', color: '#f97316', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_agendado',         title: 'Agendado',                color: '#1d4ed8', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_envio_passaporte', title: 'Envio de passaporte',     color: '#166534', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_concluido',        title: 'Concluído (Americano)',   color: '#000000', group: 'Grupo Visto Americano' },
  // Grupo Visto Canadense
  { id: 'visto_cana_formulario',  title: 'Formulário preenchido', color: '#ef4444', group: 'Grupo Visto Canadense' },
  { id: 'visto_cana_oficiais',    title: 'Formulário assinado',   color: '#ef4444', group: 'Grupo Visto Canadense' },
  { id: 'visto_cana_aprovacao',   title: 'Conta aberta',          color: '#ef4444', group: 'Grupo Visto Canadense' },
  { id: 'visto_cana_envio',       title: 'Taxa paga',             color: '#ef4444', group: 'Grupo Visto Canadense' },
  { id: 'visto_cana_biometria',   title: 'Biometria realizada',   color: '#ef4444', group: 'Grupo Visto Canadense' },
  { id: 'visto_cana_finalizado',  title: 'Finalizado',            color: '#ef4444', group: 'Grupo Visto Canadense' },
  // Grupo Visto Português
  { id: 'visto_port_formulario',  title: 'Formulário preenchido', color: '#15803d', group: 'Grupo Visto Português' },
  { id: 'visto_port_entrevista',  title: 'Documentos faltantes',  color: '#15803d', group: 'Grupo Visto Português' },
  { id: 'visto_port_aprovacao',   title: 'Formulários assinados', color: '#15803d', group: 'Grupo Visto Português' },
  { id: 'visto_port_agendamento', title: 'Agendamento realizado', color: '#15803d', group: 'Grupo Visto Português' },
  { id: 'visto_port_finalizado',  title: 'Finalizado',            color: '#15803d', group: 'Grupo Visto Português' },
  // Grupo Visto Australiano
  { id: 'visto_aust_formulario',  title: 'Formulário preenchido',        color: '#0891b2', group: 'Grupo Visto Australiano' },
  { id: 'visto_aust_oficiais',    title: 'Agendamento com a Vale Visto', color: '#0891b2', group: 'Grupo Visto Australiano' },
  { id: 'visto_aust_pagamento',   title: 'Aguardando resultado',         color: '#0891b2', group: 'Grupo Visto Australiano' },
  { id: 'visto_aust_finalizado',  title: 'Finalizado',                   color: '#0891b2', group: 'Grupo Visto Australiano' },
  // Grupo Visto Mexicano
  { id: 'visto_mex_formulario',   title: 'Contratado',                color: '#ca8a04', group: 'Grupo Visto Mexicano' },
  { id: 'visto_mex_entrevista',   title: 'Agendado com a Vale Visto', color: '#ca8a04', group: 'Grupo Visto Mexicano' },
  { id: 'visto_mex_finalizado',   title: 'Finalizado',                color: '#ca8a04', group: 'Grupo Visto Mexicano' },
  // Grupo Visto Brasileiro (novo)
  { id: 'visto_bra_documentacao', title: 'Cliente disponibiliza documentação', color: '#059669', group: 'Grupo Visto Brasileiro' },
  { id: 'visto_bra_entrevista',   title: 'VV agenda entrevista na PF',          color: '#059669', group: 'Grupo Visto Brasileiro' },
  // Grupo Passaporte Italiano / AIRE
  { id: 'ital_formulario',        title: 'Cliente preenche formulário (Italiano)', color: '#0ea5e9', group: 'Grupo Passaporte Italiano / AIRE' },
  { id: 'ital_aire',              title: 'VV agenda AIRE',                         color: '#0ea5e9', group: 'Grupo Passaporte Italiano / AIRE' },
  { id: 'ital_passaporte',        title: 'VV agenda passaporte (Italiano)',        color: '#0ea5e9', group: 'Grupo Passaporte Italiano / AIRE' },
  { id: 'outros',                 title: 'Outros',                             color: '#6b7280' }
];
function posStageFor(lead) {
  if (lead.pos_stage && POS_STAGES.includes(lead.pos_stage)) return lead.pos_stage;
  if (lead.stage === 'convertida') return 'vendas_concretizadas';
  if (lead.stage === 'clientes_antigos') return 'clientes_antigos_pos';
  // "Mensagens novas para organizar" foi extinta: o fallback agora é Recém Contratados.
  return 'vendas_concretizadas';
}

// ===== HISTÓRICO do lead (linha do tempo) — ver tabela lead_history (db.js) =====
function _histId() { return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const PRE_STAGE_LABELS = {
  novo: 'Novo Leads', tratamento: 'Tratamento inicial', proposta: 'Proposta enviada',
  followup: 'Follow-up pagamento', convertida: 'Venda convertida', declinado: 'Declinou/cancelou',
  clientes_antigos: 'Comunicação com ambiente Pós-Venda'
};
// Rótulo legível de uma etapa (pré OU pós), gravado no histórico no momento do evento.
function stageLabel(id) {
  if (!id) return '';
  const pos = POS_STAGES_FULL.find(s => s.id === id);
  if (pos) return pos.title;
  return PRE_STAGE_LABELS[id] || id;
}
// Insere um evento no histórico. Nunca lança (histórico é best-effort, não pode quebrar a ação principal).
async function logLeadHistory({ leadId, phone, name, type, detail, meta }) {
  try {
    const ph = String(phone || '').replace(/\D/g, '');
    await runQuery(
      "INSERT INTO lead_history (id, lead_id, phone, name, type, detail, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [_histId(), leadId || null, ph || null, name || null, type, detail || '', meta ? JSON.stringify(meta) : null, new Date().toISOString()]
    );
  } catch (e) { console.error('[history] log falhou:', e && e.message); }
}

app.get('/api/whatsapp/accounts', authenticateToken, async (req, res) => {
  try {
    const accounts = await allRows("SELECT * FROM whatsapp_accounts");
    const { posSet, map } = await getSaleLineFilter();
    let out = accounts.map(a => Object.assign({}, a, { sale_type: map[a.id] || 'pre' }));
    // Filtra por LOGIN: usuário PÓS-venda (Alexandre) vê SÓ as linhas pós (2030); pré/admin veem
    // TUDO menos as pós. ?all=1 mostra todas (gestão/Conexões). Nunca mascara — apenas mostra/oculta.
    if (req.query.all !== '1' && posSet.size) {
      const isPos = await userIsPos(req);
      out = isPos ? out.filter(a => posSet.has(a.id)) : out.filter(a => !posSet.has(a.id));
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Channels Routes: Trigger Connect
app.post('/api/whatsapp/accounts/:id/connect', authenticateToken, async (req, res) => {
  const { id } = req.params;
  // Se vier um telefone no corpo, conecta por CODIGO DE PAREAMENTO (digitado no celular) em vez do QR.
  const phone = (req.body && req.body.phone) ? String(req.body.phone) : null;
  try {
    const statusInfo = await connectWhatsApp(id, false, phone);
    res.json(statusInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 12. Channels Routes: Status Check
app.get('/api/whatsapp/accounts/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const sock = sessions[id];
    let status = 'disconnected';
    if (sock) {
      status = sock.ws.isOpen ? 'connected' : 'connecting';
    } else {
      // check database status
      const account = await getRow("SELECT status FROM whatsapp_accounts WHERE id = ?", [id]);
      if (account) status = account.status;
    }

    res.json({
      id,
      status,
      qr: sessionQrs[id] || null,
      pairCode: sessionPairCodes[id] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 13. Channels Routes: Disconnect
app.post('/api/whatsapp/accounts/:id/disconnect', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const statusInfo = await disconnectWhatsApp(id);
    res.json(statusInfo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. Email Routes: Connect (verify SMTP and save)
app.post('/api/email/connect', authenticateToken, async (req, res) => {
  const { email, password, host, port, secure } = req.body;
  if (!email || !password || !host) {
    return res.status(400).json({ error: "E-mail, senha e servidor SMTP sao obrigatorios" });
  }
  const p = parseInt(port, 10) || (secure ? 465 : 587);
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: p,
      secure: !!secure,
      auth: { user: email, pass: password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15000,
      greetingTimeout: 15000
    });
    await transporter.verify();

    const existing = await getRow("SELECT id FROM email_accounts WHERE email = ?", [email]);
    const now = new Date().toISOString();
    if (existing) {
      await runQuery(
        "UPDATE email_accounts SET host=?, port=?, secure=?, password=?, status='connected', connected_at=? WHERE email=?",
        [host, p, secure ? 1 : 0, password, now, email]
      );
    } else {
      const id = 'em_' + Math.random().toString(36).substr(2, 9);
      await runQuery(
        "INSERT INTO email_accounts (id, email, host, port, secure, password, status, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, email, host, p, secure ? 1 : 0, password, 'connected', now]
      );
    }
    res.json({ success: true, email, host, port: p });
  } catch (err) {
    console.error("Email connect error:", err && err.message);
    res.status(400).json({ error: (err && err.message) || "Falha na conexao SMTP" });
  }
});

// 15. Email Routes: Status (latest connected account, no password)
app.get('/api/email/status', authenticateToken, async (req, res) => {
  try {
    const acc = await getRow(
      "SELECT email, host, port, secure, status, connected_at FROM email_accounts ORDER BY connected_at DESC LIMIT 1"
    );
    if (!acc) return res.json({ connected: false });
    res.json({
      connected: acc.status === 'connected',
      email: acc.email,
      host: acc.host,
      port: acc.port,
      secure: Boolean(acc.secure)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16. Email Routes: List inbox messages (IMAP)
// Resolve o CAMINHO real da pasta no servidor IMAP — os nomes variam por servidor
// (Sent/INBOX.Sent/Enviados; spam/Junk/Lixo Eletrônico). Usa a flag special-use quando existe.
async function resolveMailboxPath(client, box) {
  const want = String(box || 'inbox').toLowerCase();
  if (want !== 'sent' && want !== 'spam') return 'INBOX';
  try {
    const boxes = await client.list();
    const bySpecial = (flag) => { const b = (boxes || []).find(x => x && x.specialUse === flag); return b && b.path; };
    const byName = (re) => { const b = (boxes || []).find(x => x && re.test(String(x.path || ''))); return b && b.path; };
    if (want === 'sent') return bySpecial('\\Sent') || byName(/sent|enviad/i) || 'INBOX';
    return bySpecial('\\Junk') || byName(/spam|junk|lixo/i) || 'INBOX';
  } catch (e) { return 'INBOX'; }
}

// ===== 📝 RASCUNHOS de e-mail (pedido do Henry, 2026-07-08) =====
// Compositor fechado com conteúdo salva aqui; a aba Rascunhos lista/reabre; enviar apaga.
app.get('/api/email/drafts', authenticateToken, async (req, res) => {
  try { res.json(await allRows("SELECT * FROM email_drafts ORDER BY updated_at DESC LIMIT 100")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/email/drafts', authenticateToken, async (req, res) => {
  try {
    const b = req.body || {};
    const id = (b.id && String(b.id)) || ('d_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    await runQuery(
      "INSERT INTO email_drafts (id, to_addr, cc, subject, body, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET to_addr = excluded.to_addr, cc = excluded.cc, subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at",
      [id, String(b.to || '').slice(0, 500), String(b.cc || '').slice(0, 500), String(b.subject || '').slice(0, 500), String(b.body || '').slice(0, 100000), Date.now()]
    );
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/email/drafts/:id', authenticateToken, async (req, res) => {
  try { await runQuery("DELETE FROM email_drafts WHERE id = ?", [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/email/messages', authenticateToken, async (req, res) => {
  try {
    const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
    if (!acc) return res.status(400).json({ error: "Nenhum e-mail conectado" });

    let ImapFlow;
    try { ImapFlow = require('imapflow').ImapFlow; }
    catch (e) { return res.status(500).json({ error: "Biblioteca IMAP nao instalada no servidor" }); }

    const client = new ImapFlow({
      host: acc.host,
      port: 993,
      secure: true,
      auth: { user: acc.email, pass: acc.password },
      logger: false,
      tls: { rejectUnauthorized: false }
    });

    const out = [];
    await client.connect();
    const q = String(req.query.q || '').trim();
    const want = String(req.query.box || 'inbox').toLowerCase();
    // PAGINAÇÃO (pedido do Henry): 100 por página. A janela crua cresce com a página (e é maior que
    // a página p/ compensar os filtrados pelo anti-propaganda); rawSat = ainda há mensagens mais
    // antigas fora da janela → habilita o botão "Próxima" mesmo sem saber a contagem exata.
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const PAGE = 30; // 30 por página (pedido do Henry: voltou ao tamanho anterior, com "Próxima ›")
    const RAW = Math.min(900, page * PAGE * 2 + 60);
    let rawSat = false;
    // ANTI-PROPAGANDA (pedido do Henry): e-mails com marcadores de marketing/spam saem da ENTRADA e
    // aparecem na aba SPAM. Sinais: assunto "[SPAM]" (SpamAssassin), X-Spam-Flag, List-Unsubscribe
    // (newsletters/propaganda), Precedence bulk/list e Auto-Submitted. NUNCA esconde remetente que é
    // LEAD do CRM nem os domínios da casa (allowlist) — propaganda some da entrada, cliente não.
    const HDRS = ['x-spam-flag', 'list-unsubscribe', 'precedence', 'auto-submitted'];
    // bodyStructure: p/ detectar ANEXOS sem baixar o e-mail (coluna 📎 da lista — Henry, 2026-07-06).
    const FETCH_OPTS = { envelope: true, internalDate: true, headers: HDRS, bodyStructure: true };
    // Nomes dos anexos a partir da estrutura MIME (disposition=attachment ou parte com filename).
    const _attNames = (msg) => {
      const names = [];
      const walk = (node) => {
        if (!node) return;
        if (Array.isArray(node.childNodes)) node.childNodes.forEach(walk);
        const disp = String(node.disposition || '').toLowerCase();
        const fn = (node.dispositionParameters && node.dispositionParameters.filename)
          || (node.parameters && node.parameters.name) || '';
        if (disp === 'attachment' || (fn && disp !== 'inline')) names.push(String(fn || 'anexo'));
      };
      try { walk(msg.bodyStructure); } catch (e) {}
      return names;
    };
    let _known = new Set();
    try { (await allRows("SELECT DISTINCT LOWER(TRIM(email)) AS e FROM leads WHERE email IS NOT NULL AND TRIM(email) <> ''")).forEach(r => { if (r && r.e) _known.add(r.e); }); } catch (e) {}
    // Regras MANUAIS por domínio (botões 🚫/✅ da lista): 'ham' nunca filtra; 'spam' sempre filtra.
    let _domSpam = [], _domHam = [];
    try { const r1 = await getRow("SELECT value FROM app_settings WHERE key = 'email_spam_domains'"); const a1 = JSON.parse((r1 && r1.value) || '[]'); if (Array.isArray(a1)) _domSpam = a1; } catch (e) {}
    try { const r2 = await getRow("SELECT value FROM app_settings WHERE key = 'email_ham_domains'"); const a2 = JSON.parse((r2 && r2.value) || '[]'); if (Array.isArray(a2)) _domHam = a2; } catch (e) {}
    const _fromAddr = (msg) => {
      const f = msg.envelope && msg.envelope.from && msg.envelope.from[0];
      return String((f && f.address) || '').toLowerCase();
    };
    const _isPromo = (msg) => {
      const a = _fromAddr(msg);
      const dom = String(a.split('@')[1] || '');
      if (dom && _domHam.includes(dom)) return false;             // "não é spam" manual (vence tudo)
      if (_known.has(a) || /@(valevisto|eccere)\./.test(a)) return false; // allowlist (leads + casa)
      if (dom && _domSpam.includes(dom)) return true;             // domínio marcado como spam
      const subj = String((msg.envelope && msg.envelope.subject) || '');
      if (/^\s*\[spam\]/i.test(subj)) return true;
      let h = ''; try { h = msg.headers ? msg.headers.toString('utf8') : ''; } catch (e) {}
      if (/^x-spam-flag:\s*yes/mi.test(h)) return true;
      if (/^list-unsubscribe:/mi.test(h)) return true;
      if (/^precedence:\s*(bulk|list|junk)/mi.test(h)) return true;
      if (/^auto-submitted:\s*auto/mi.test(h)) return true;
      return false;
    };
    const _push = (msg, boxTag) => {
      const f = msg.envelope && msg.envelope.from && msg.envelope.from[0];
      const t = msg.envelope && msg.envelope.to && msg.envelope.to[0];
      out.push({
        uid: msg.uid,
        box: boxTag || 'inbox',
        subject: (msg.envelope && msg.envelope.subject) || '(sem assunto)',
        from: f ? (f.name || f.address) : '',
        fromAddress: f ? f.address : '',
        to: t ? (t.name || t.address) : '',
        toAddress: t ? t.address : '',
        date: msg.internalDate || (msg.envelope && msg.envelope.date) || null,
        attachments: _attNames(msg)
      });
    };
    // Lê os últimos e-mails de uma pasta (com busca TEXT do servidor quando há filtro digitado),
    // aplicando o predicado `keep` de cada visão. Busca mais fundo (90) p/ compensar os filtrados.
    const readBox = async (path, keep, boxTag) => {
      const lock = await client.getMailboxLock(path);
      try {
        if (q) {
          let uids = [];
          try { uids = await client.search({ text: q }, { uid: true }); } catch (e) { uids = []; }
          if (!Array.isArray(uids)) uids = [];
          if (uids.length > RAW) rawSat = true;
          uids = uids.slice(-RAW);
          if (uids.length) {
            for await (const msg of client.fetch(uids.join(','), FETCH_OPTS, { uid: true })) { if (!keep || keep(msg)) _push(msg, boxTag); }
          }
        } else {
          const total = (client.mailbox && client.mailbox.exists) || 0;
          if (total > RAW) rawSat = true;
          if (total > 0) {
            const start = Math.max(1, total - (RAW - 1));
            for await (const msg of client.fetch(start + ':*', FETCH_OPTS)) { if (!keep || keep(msg)) _push(msg, boxTag); }
          }
        }
      } finally { lock.release(); }
    };
    if (want === 'sent') {
      await readBox(await resolveMailboxPath(client, 'sent'), null, 'sent');
    } else if (want === 'spam') {
      // Aba Spam = propaganda detectada NA ENTRADA + a pasta de spam do servidor.
      await readBox('INBOX', (m) => _isPromo(m), 'inbox');
      const junk = await resolveMailboxPath(client, 'spam');
      if (junk !== 'INBOX') await readBox(junk, null, 'spam');
    } else {
      // Entrada SEM propaganda.
      await readBox('INBOX', (m) => !_isPromo(m), 'inbox');
    }
    try { await client.logout(); } catch (e) {}
    out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const _start = (page - 1) * PAGE;
    res.json({ messages: out.slice(_start, _start + PAGE), page: page, hasMore: rawSat || out.length > page * PAGE });
  } catch (err) {
    console.error("IMAP error:", err && err.message);
    res.status(500).json({ error: (err && err.message) || "Falha ao ler e-mails" });
  }
});

// Regras manuais de DOMÍNIO para o anti-propaganda (botões 🚫 "é spam" / ✅ "não é spam" da lista).
// Guardadas em app_settings: email_spam_domains e email_ham_domains (JSON arrays). Adicionar num
// lado remove do outro (as listas nunca conflitam).
app.get('/api/email/domain-rules', authenticateToken, async (req, res) => {
  try {
    const g = async (k) => { const r = await getRow("SELECT value FROM app_settings WHERE key = ?", [k]); try { const a = JSON.parse((r && r.value) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
    res.json({ spam: await g('email_spam_domains'), ham: await g('email_ham_domains') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/email/domain-rules', authenticateToken, async (req, res) => {
  try {
    const dom = String((req.body && req.body.domain) || '').trim().toLowerCase().replace(/^@/, '');
    const action = String((req.body && req.body.action) || '');
    if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(dom)) return res.status(400).json({ error: 'Domínio inválido' });
    if (action !== 'spam' && action !== 'ham') return res.status(400).json({ error: "action deve ser 'spam' ou 'ham'" });
    const g = async (k) => { const r = await getRow("SELECT value FROM app_settings WHERE key = ?", [k]); try { const a = JSON.parse((r && r.value) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
    let spam = await g('email_spam_domains'), ham = await g('email_ham_domains');
    if (action === 'spam') { if (!spam.includes(dom)) spam.push(dom); ham = ham.filter(d => d !== dom); }
    else { if (!ham.includes(dom)) ham.push(dom); spam = spam.filter(d => d !== dom); }
    await setAppSetting('email_spam_domains', JSON.stringify(spam));
    await setAppSetting('email_ham_domains', JSON.stringify(ham));
    res.json({ ok: true, spam, ham });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 17. Email Routes: Read full message body (IMAP + parse)
app.get('/api/email/message/:uid', authenticateToken, async (req, res) => {
  try {
    const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
    if (!acc) return res.status(400).json({ error: "Nenhum e-mail conectado" });
    let ImapFlow, simpleParser;
    try { ImapFlow = require('imapflow').ImapFlow; simpleParser = require('mailparser').simpleParser; }
    catch (e) { return res.status(500).json({ error: "Bibliotecas de e-mail nao instaladas" }); }

    const client = new ImapFlow({
      host: acc.host, port: 993, secure: true,
      auth: { user: acc.email, pass: acc.password },
      logger: false, tls: { rejectUnauthorized: false }
    });
    await client.connect();
    const _mbox = await resolveMailboxPath(client, req.query.box);
    const lock = await client.getMailboxLock(_mbox);
    let parsed = null;
    try {
      const msg = await client.fetchOne(String(req.params.uid), { source: true }, { uid: true });
      if (msg && msg.source) {
        const p = await simpleParser(msg.source);
        parsed = {
          subject: p.subject || '(sem assunto)',
          from: p.from ? p.from.text : '',
          fromAddress: (p.from && p.from.value && p.from.value[0]) ? p.from.value[0].address : '',
          to: p.to ? p.to.text : '',
          toAddresses: (p.to && p.to.value) ? p.to.value.map(v => v.address).filter(Boolean) : [],
          cc: p.cc ? p.cc.text : '',
          ccAddresses: (p.cc && p.cc.value) ? p.cc.value.map(v => v.address).filter(Boolean) : [],
          date: p.date || null,
          html: p.html || null,
          text: p.text || '',
          // ANEXOS (Henry, 2026-07-06): metadados p/ a área de anexos do leitor. O download em si
          // é servido por GET /api/email/attachment?uid=&box=&idx= (idx = posição nesta lista —
          // MESMO parser/ordem do simpleParser, então o índice é estável).
          attachments: (p.attachments || []).map((a, i) => ({
            idx: i,
            filename: a.filename || ('anexo-' + (i + 1)),
            contentType: a.contentType || 'application/octet-stream',
            size: a.size || (a.content ? a.content.length : 0)
          }))
        };
      }
    } finally { lock.release(); }
    try { await client.logout(); } catch (e) {}
    if (!parsed) return res.status(404).json({ error: "E-mail nao encontrado" });
    res.json(parsed);
  } catch (err) {
    console.error("IMAP read error:", err && err.message);
    res.status(500).json({ error: (err && err.message) || "Falha ao abrir e-mail" });
  }
});

// 17c. Baixa/abre UM ANEXO do e-mail (Henry, 2026-07-06). Auth via header OU ?token= (necessário
// p/ <a href> abrir/salvar direto do navegador, igual ao /media). ?dl=1 força download ("Salvar");
// sem dl, Content-Disposition inline — PDF/imagem abrem numa aba nova ("Abrir").
app.get('/api/email/attachment', async (req, res) => {
  const token = (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ detail: "Não autenticado" });
  try { jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(403).json({ detail: "Token inválido" }); }
  try {
    const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
    if (!acc) return res.status(400).json({ error: "Nenhum e-mail conectado" });
    let ImapFlow, simpleParser;
    try { ImapFlow = require('imapflow').ImapFlow; simpleParser = require('mailparser').simpleParser; }
    catch (e) { return res.status(500).json({ error: "Bibliotecas de e-mail nao instaladas" }); }
    const client = new ImapFlow({
      host: acc.host, port: 993, secure: true,
      auth: { user: acc.email, pass: acc.password },
      logger: false, tls: { rejectUnauthorized: false }
    });
    await client.connect();
    const _mbox = await resolveMailboxPath(client, req.query.box);
    const lock = await client.getMailboxLock(_mbox);
    let att = null;
    try {
      const msg = await client.fetchOne(String(req.query.uid || ''), { source: true }, { uid: true });
      if (msg && msg.source) {
        const p = await simpleParser(msg.source);
        att = (p.attachments || [])[parseInt(req.query.idx, 10) || 0] || null;
      }
    } finally { lock.release(); }
    try { await client.logout(); } catch (e) {}
    if (!att || !att.content) return res.status(404).json({ error: "Anexo não encontrado" });
    const fname = String(att.filename || 'anexo').replace(/[\r\n"]/g, '');
    const ascii = fname.replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', att.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', (req.query.dl ? 'attachment' : 'inline')
      + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(fname));
    res.setHeader('Content-Length', att.content.length);
    res.end(att.content);
  } catch (err) {
    console.error("IMAP attachment error:", err && err.message);
    res.status(500).json({ error: (err && err.message) || "Falha ao baixar o anexo" });
  }
});

// 17d. Baixa TODOS os anexos de um e-mail num ZIP (pedido do Henry, 2026-07-06). Token na query.
// Depende do pacote 'archiver' (package.json) — instalado no npm install do deploy.
app.get('/api/email/attachments-zip', async (req, res) => {
  const token = (req.headers['authorization'] && req.headers['authorization'].split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ detail: "Não autenticado" });
  try { jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(403).json({ detail: "Token inválido" }); }
  try {
    let archiver;
    try { archiver = require('archiver'); }
    catch (e) { return res.status(500).json({ error: "Pacote 'archiver' não instalado — publique o backend (npm install roda no deploy)." }); }
    const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
    if (!acc) return res.status(400).json({ error: "Nenhum e-mail conectado" });
    let ImapFlow, simpleParser;
    try { ImapFlow = require('imapflow').ImapFlow; simpleParser = require('mailparser').simpleParser; }
    catch (e) { return res.status(500).json({ error: "Bibliotecas de e-mail nao instaladas" }); }
    const client = new ImapFlow({
      host: acc.host, port: 993, secure: true,
      auth: { user: acc.email, pass: acc.password },
      logger: false, tls: { rejectUnauthorized: false }
    });
    await client.connect();
    const _mbox = await resolveMailboxPath(client, req.query.box);
    const lock = await client.getMailboxLock(_mbox);
    let atts = [], subj = 'email';
    try {
      const msg = await client.fetchOne(String(req.query.uid || ''), { source: true }, { uid: true });
      if (msg && msg.source) {
        const p = await simpleParser(msg.source);
        subj = p.subject || 'email';
        atts = (p.attachments || []).filter(a => a && a.content);
      }
    } finally { lock.release(); }
    try { await client.logout(); } catch (e) {}
    if (!atts.length) return res.status(404).json({ error: "Este e-mail não tem anexos" });
    const zname = ('anexos_' + subj).replace(/[^\wÀ-ſ .\-]+/g, '_').trim().slice(0, 60) + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="' + zname.replace(/[^\x20-\x7E]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(zname));
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', () => { try { res.end(); } catch (e) {} });
    archive.pipe(res);
    const used = {};
    atts.forEach((a, i) => {
      const base = String(a.filename || ('anexo-' + (i + 1))).replace(/[\/\\]/g, '_');
      const n = (used[base] = (used[base] || 0) + 1);
      let name = base;
      if (n > 1) { const dot = base.lastIndexOf('.'); name = dot > 0 ? base.slice(0, dot) + ' (' + (n - 1) + ')' + base.slice(dot) : base + ' (' + (n - 1) + ')'; }
      archive.append(a.content, { name: name });
    });
    await archive.finalize();
  } catch (err) {
    console.error("IMAP zip error:", err && err.message);
    if (!res.headersSent) res.status(500).json({ error: (err && err.message) || "Falha ao gerar o ZIP" });
  }
});

// 18. Email Routes: Send (reply/forward/compose) via SMTP
app.post('/api/email/send', authenticateToken, async (req, res) => {
  const { to, cc, subject, text, html, attachments } = req.body;
  if (!to || !subject) return res.status(400).json({ error: "Destinatario e assunto sao obrigatorios" });
  // Anexos: [{ filename, content(base64), contentType }] — checa o tamanho total (20 MB).
  let cleanAtt = [];
  if (Array.isArray(attachments) && attachments.length) {
    let total = 0;
    for (const a of attachments) {
      if (!a || !a.content || !a.filename) continue;
      total += Buffer.byteLength(String(a.content), 'base64');
      if (total > 20 * 1024 * 1024) return res.status(400).json({ error: "Anexos acima de 20 MB no total" });
      cleanAtt.push({ filename: String(a.filename), content: String(a.content), contentType: a.contentType || undefined });
    }
  }
  try {
    // Envia pela MESMA rota dos contratos (mail() local do servidor da Vale Visto, que ENTREGA
    // no Gmail/Hotmail). O SMTP autenticado de fora era aceito mas descartado pelos destinos.
    const bodyHtml = html || (text ? ('<pre style="font-family:inherit;white-space:pre-wrap;">' + String(text).replace(/[<>&]/g, s => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[s])) + '</pre>') : ' ');
    const token = await ds160AdminToken();
    const er = await fetch(DS160_BASE + '/send_email.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to, cc: cc || '', subject, html: bodyHtml, attachments: cleanAtt })
    });
    const ej = await er.json().catch(() => ({}));
    if (!er.ok || !ej.success) return res.status(502).json({ error: (ej && ej.error) || "Falha ao enviar e-mail" });
    res.json({ success: true });
  } catch (err) {
    console.error("Email send error:", err && err.message);
    res.status(500).json({ error: (err && err.message) || "Falha ao enviar e-mail" });
  }
});

// 18b. Email Routes: Disconnect
app.post('/api/email/disconnect', authenticateToken, async (req, res) => {
  try {
    await runQuery("UPDATE email_accounts SET status = 'disconnected'");
    res.json({ success: true });
  } catch (err) {
    console.error("Email disconnect error:", err && err.message);
    res.status(500).json({ error: err.message });
  }
});

// 19. Leads Routes: Create lead from an email sender
app.post('/api/leads/from-email', authenticateToken, async (req, res) => {
  const { name, email } = req.body;
  if (!email) return res.status(400).json({ error: "E-mail do remetente e obrigatorio" });
  try {
    const existing = await getRow("SELECT * FROM leads WHERE email = ? AND archived = 0", [email]);
    if (existing) {
      return res.json({ ...existing, tags: existing.tags ? JSON.parse(existing.tags) : [], existed: true });
    }
    const id = 'l_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString().slice(0, 10);
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name || email, "", "", email, 0, "novo", "Email", "", "Henry Mancini", JSON.stringify([]), createdAt, 0]
    );
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    res.json({ ...lead, tags: [], created: true });
  } catch (err) {
    console.error("from-email error:", err && err.message);
    res.status(500).json({ error: err.message });
  }
});

// 19b. Leads Routes: Create lead from a conversation (Instagram/Meta ou WhatsApp)
app.post('/api/leads/from-conversation', authenticateToken, async (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: "conversationId é obrigatório" });
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [conversationId]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });

    // Dedupe por whatsapp_jid (ex.: ig:<id>) — se já existir lead ativo, devolve ele
    let existing = null;
    if (convo.whatsapp_jid) {
      existing = await getRow("SELECT * FROM leads WHERE whatsapp_jid = ? AND archived = 0", [convo.whatsapp_jid]);
    }
    if (existing) {
      return res.json({ ...existing, tags: existing.tags ? JSON.parse(existing.tags) : [], existed: true });
    }

    const id = 'l_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString().slice(0, 10);
    const src = convo.account === 'ig' ? 'Instagram' : 'WhatsApp';
    // Lead nascido de comentário no Instagram (não Direct puro) ganha a tag "comentário Meta" —
    // identificado pela existência de ao menos 1 mensagem com id 'cmt_%' na conversa de origem.
    let leadTags = [];
    if (convo.account === 'ig') {
      const cmtMsg = await getRow("SELECT id FROM messages WHERE conversationId = ? AND id LIKE 'cmt_%' LIMIT 1", [convo.id]);
      leadTags = cmtMsg ? ['comentário Meta'] : ['Meta'];
    }
    // pipeline433: lead do Meta nasce com o telefone extraído do texto da conversa (IG não
    // fornece o telefone do perfil) — só entra em ação quando a conversa ainda não tem um
    // telefone válido (>=10 dígitos). Varre as mensagens em ordem cronológica e procura um
    // telefone BR; prefere a PRIMEIRA ocorrência vinda de mensagem do cliente (from='them').
    let leadPhone = convo.phone || "";
    if (convo.account === 'ig' && (!convo.phone || String(convo.phone).replace(/\D/g, '').length < 10)) {
      try {
        const convoMsgs = await allRows("SELECT text, `from` FROM messages WHERE conversationId = ? ORDER BY timestamp ASC", [convo.id]);
        const phoneRe = /(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}/g;
        let foundClient = null, foundAny = null;
        for (const m of (convoMsgs || [])) {
          const txt = String((m && m.text) || '');
          if (!txt) continue;
          const matches = txt.match(phoneRe) || [];
          for (const raw of matches) {
            let digits = raw.replace(/\D/g, '');
            if (digits.length < 10 || digits.length > 13) continue;
            if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) digits = '55' + digits;
            if (!foundAny) foundAny = digits;
            if (m.from === 'them' && !foundClient) { foundClient = digits; break; }
          }
          if (foundClient) break;
        }
        const extracted = foundClient || foundAny;
        if (extracted) {
          leadPhone = '+' + extracted;
          await runQuery("UPDATE conversations SET phone = ? WHERE id = ?", [leadPhone, convo.id]);
        }
      } catch (e) { console.error('[from-conversation] falha ao extrair telefone do texto da conversa:', e && e.message); }
    }
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, whatsapp_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, convo.name || (src + ' lead'), "", leadPhone || "", "", 0, "novo", src, convo.account || 'ig', "Henry Mancini", JSON.stringify(leadTags), createdAt, 0, convo.whatsapp_jid || null]
    );
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    res.json({ ...lead, tags: leadTags, created: true });
  } catch (err) {
    console.error("from-conversation error:", err && err.message);
    res.status(500).json({ error: err.message });
  }
});

// 19b-2. Leads Routes: Get the original Meta (Instagram) comment that originated a lead.
// Busca a mensagem cmt_ mais antiga da conversa do lead e tenta trazer o comentário "ao vivo" via
// Graph API (texto/autor/data/link da publicação); se a Graph falhar (comentário apagado, token
// expirado, timeout), cai no texto gravado no banco (live:false). Cache em memória por lead id
// (TTL 10 min) para não bater na Graph a cada clique no botão do frontend.
const _metaCommentCache = new Map();
const META_COMMENT_CACHE_TTL_MS = 10 * 60 * 1000;
app.get('/api/leads/:id/meta-comment', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const cached = _metaCommentCache.get(id);
    if (cached && (Date.now() - cached.t) < META_COMMENT_CACHE_TTL_MS) {
      return res.json(cached.body);
    }

    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: "Lead não encontrado" });
    if (!lead.whatsapp_jid || !String(lead.whatsapp_jid).startsWith('ig:')) {
      return res.status(404).json({ error: "Lead não veio do Instagram" });
    }

    const convo = await getRow("SELECT * FROM conversations WHERE whatsapp_jid = ?", [lead.whatsapp_jid]);
    if (!convo) return res.status(404).json({ error: "Lead não nasceu de comentário" });

    const msg = await getRow("SELECT * FROM messages WHERE conversationId = ? AND id LIKE 'cmt_%' ORDER BY timestamp ASC LIMIT 1", [convo.id]);
    if (!msg) return res.status(404).json({ error: "Lead não nasceu de comentário" });

    const commentId = String(msg.id).slice(4); // remove prefixo 'cmt_'
    const storedText = String(msg.text || '').replace(/^\[Coment[aá]rio\]\s*/, '');
    let body = {
      text: storedText,
      username: convo.name || '',
      timestamp: msg.timestamp || null,
      permalink: null,
      stored_text: storedText,
      live: false
    };

    try {
      const conn = await getRow("SELECT access_token FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
      if (conn && conn.access_token) {
        const r = await fetch('https://graph.instagram.com/v21.0/' + encodeURIComponent(commentId) +
          '?fields=text,username,timestamp,media{permalink}&access_token=' + encodeURIComponent(conn.access_token),
          { signal: AbortSignal.timeout(6000) });
        const d = await r.json().catch(() => ({}));
        if (d && !d.error) {
          body = {
            text: d.text || storedText,
            username: d.username || convo.name || '',
            timestamp: d.timestamp || msg.timestamp || null,
            permalink: (d.media && d.media.permalink) || null,
            stored_text: storedText,
            live: true
          };
        } else if (d && d.error) {
          console.error('[Meta comment] erro Graph:', JSON.stringify(d.error));
        }
      }
    } catch (e) {
      console.error('[Meta comment] falha Graph:', e && e.message);
    }

    _metaCommentCache.set(id, { t: Date.now(), body });
    res.json(body);
  } catch (err) {
    console.error("meta-comment error:", err && err.message);
    res.status(500).json({ error: err.message });
  }
});

// 19c. Settings: horário de expediente + mensagem fora do horário
app.get('/api/settings/business-hours', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'business_hours'");
    if (row && row.value) {
      try { return res.json(JSON.parse(row.value)); } catch (e) { return res.json({}); }
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/business-hours', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const value = JSON.stringify(req.body || {});
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES ('business_hours', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [value]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 19d. Settings: tipo de cada linha de WhatsApp — Pré-venda / Pós-venda (mapa { accountId: 'pre'|'pos' }).
app.get('/api/settings/wa-sale-types', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'wa_sale_types'");
    if (row && row.value) { try { return res.json(JSON.parse(row.value)); } catch (e) { return res.json({}); } }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/wa-sale-types', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  try {
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES ('wa_sale_types', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [JSON.stringify(req.body || {})]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Respostas rápidas por /atalho (lista de { code, context, message }). Leitura p/ todos; gravação só admin.
app.get('/api/settings/quick-replies', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'quick_replies'");
    let arr = [];
    if (row && row.value) { try { arr = JSON.parse(row.value); } catch (e) { arr = []; } }
    res.json(Array.isArray(arr) ? arr : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/quick-replies', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const arr = Array.isArray(req.body) ? req.body : ((req.body && req.body.items) || []);
    const clean = arr
      .filter(x => x && (x.code || x.message))
      .map(x => ({ code: String(x.code || '').trim(), context: String(x.context || ''), message: String(x.message || '') }));
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES ('quick_replies', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [JSON.stringify(clean)]
    );
    res.json({ success: true, count: clean.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Guia "Identificação" (Configurações): regras 1ª mensagem → origem do lead ──
// GET devolve as regras; POST salva e RECLASSIFICA os leads existentes na hora,
// para o resultado refletir em todos os indicadores (funil, dashboard, pizzas).
app.get('/api/settings/origin-rules', authenticateToken, async (req, res) => {
  try { res.json({ rules: getOriginMsgRules() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/origin-rules', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const rules = (req.body && req.body.rules) || [];
    const saved = await setOriginMsgRules(rules);
    const reclassified = await reclassifyLeadsByFirstMsg();
    res.json({ success: true, count: saved.length, reclassified });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Guia "Resgate de leads" (Configurações): regra das colunas 3-4 do Tratamento inicial ──
app.get('/api/settings/lead-rescue', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'lead_rescue_rules'");
    let parsed = null;
    if (row && row.value) { try { parsed = JSON.parse(row.value); } catch (e) { parsed = null; } }
    const minMessages = (parsed && Number.isInteger(parsed.minMessages)) ? parsed.minMessages : 4;
    const requireClientMsg = (parsed && typeof parsed.requireClientMsg === 'boolean') ? parsed.requireClientMsg : true;
    res.json({ minMessages, requireClientMsg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/lead-rescue', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const minMessages = parseInt(req.body.minMessages);
    if (!Number.isInteger(minMessages) || minMessages < 1 || minMessages > 99) {
      return res.status(400).json({ error: 'minMessages inválido (1-99)' });
    }
    const requireClientMsg = !!req.body.requireClientMsg;
    await runQuery(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('lead_rescue_rules', ?)",
      [JSON.stringify({ minMessages, requireClientMsg })]
    );
    res.json({ success: true, minMessages, requireClientMsg });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Relação de serviços (classificação) — editável em Configurações, usada na combo "Classificação (Serviço)".
app.get('/api/settings/services', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'services'");
    let arr = [];
    if (row && row.value) { try { arr = JSON.parse(row.value); } catch (e) { arr = []; } }
    res.json(Array.isArray(arr) ? arr : []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/services', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const arr = Array.isArray(req.body) ? req.body : ((req.body && req.body.items) || []);
    const clean = arr.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES ('services', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [JSON.stringify(clean)]
    );
    res.json({ success: true, count: clean.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Enviar formulário de coleta de dados DS-160 (sistema de contratos gerencia_ds-160).
// Cria a credencial/token (DRAFT) e o PRÓPRIO servidor de contratos envia o e-mail ao cliente.
// Servidor-a-servidor: a senha de admin NÃO trafega pelo navegador.
const DS160_BASE = 'https://www.valevisto.com.br/api';
const DS160_ADMIN_USER = 'admin';
const DS160_ADMIN_PASS = process.env.DS160_ADMIN_PASS || 'ValeVisto@12';
app.post('/api/ds160/send-form', authenticateToken, async (req, res) => {
  try {
    const { leadId, email } = req.body || {};
    if (!leadId) return res.status(400).json({ error: 'leadId obrigatório' });
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const clientEmail = String(email || lead.email || '').trim();
    if (!clientEmail) return res.json({ needEmail: true });
    // 1) login admin no sistema de contratos → token
    const lr = await fetch(DS160_BASE + '/auth.php?action=login_admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: DS160_ADMIN_USER, password: DS160_ADMIN_PASS })
    });
    const lj = await lr.json().catch(() => ({}));
    if (!lr.ok || !lj.token) return res.status(502).json({ error: 'Falha ao autenticar no sistema de contratos.' });
    // 2) cria o rascunho DS-160 com token → o servidor de contratos envia o e-mail
    const cr = await fetch(DS160_BASE + '/submissions.php?action=create_draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + lj.token },
      body: JSON.stringify({ clientName: lead.name || clientEmail, clientEmail: clientEmail, clientRef: '', formType: 'ds-160' })
    });
    const cj = await cr.json().catch(() => ({}));
    if (!cr.ok || !cj.success) return res.status(502).json({ error: (cj && cj.error) || 'Falha ao gerar/enviar o formulário DS-160.' });
    // guarda o e-mail no lead se ainda não tinha
    if (!lead.email && clientEmail) { try { await runQuery("UPDATE leads SET email = ? WHERE id = ?", [clientEmail, leadId]); } catch (e) {} }
    res.json({ success: true, id: cj.id, email: clientEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// E-mail de preparação para a entrevista (1º visto): relação de vínculos + lista de documentos.
// Enviado pela conta de e-mail conectada no CRM (SMTP), ao e-mail do lead.
function buildPrepDocsEmail(firstName) {
  const ola = firstName ? ('Olá, <strong>' + firstName.replace(/[<>&]/g, '') + '</strong>,') : 'Olá,';
  const li = (t) => '<li style="margin-bottom:6px;">' + t + '</li>';
  return `<html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;color:#334155;line-height:1.6;}
    .container{max-width:640px;margin:0 auto;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;}
    .header{background:#1e293b;color:#fff;padding:18px;text-align:center;}
    .content{padding:20px 22px;}
    h3{color:#b91c1c;font-size:15px;margin:18px 0 6px;}
    .tip{background:#f1f5f9;border-left:4px solid #2563eb;padding:10px 14px;border-radius:6px;margin:14px 0;font-size:13px;}
    ul{margin:6px 0 0;padding-left:20px;font-size:13.5px;}
    .footer{font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding:14px 22px;}
  </style></head><body><div class="container">
    <div class="header"><h2 style="margin:0;color:#fff;">Vale Visto — Preparação para a Entrevista</h2>
      <div style="font-size:13px;opacity:.85;margin-top:4px;">Visto Americano — Relação de vínculos e documentos</div></div>
    <div class="content">
      <p>${ola}</p>
      <p>Estamos chegando em uma etapa importante: a <strong>entrevista no Consulado Americano</strong>. Para aumentar suas chances de aprovação, é fundamental comprovar seus <strong>vínculos com o Brasil</strong> (familiares, profissionais e patrimoniais). Abaixo está a relação de documentos <strong>aceitos</strong> pelo Consulado.</p>
      <div class="tip"><strong>Não é obrigatório</strong> ter todos. Separe os que você possui e leve no dia da entrevista — o agente consular pode solicitá-los para comprovação.<br><strong>Todos os documentos devem ser ORIGINAIS.</strong></div>
      <h3>Documentos pessoais e de vínculos</h3>
      <ul>
        ${li('<strong>Bens</strong> (casa, apartamento, sítio, fazenda, chácara ou terreno): leve a <strong>escritura</strong> (ideal) ou o contrato de compra; se financiado, o contrato de financiamento.')}
        ${li('<strong>Carteira de Trabalho</strong> (caso haja registro vigente).')}
        ${li('<strong>3 extratos bancários</strong> dos últimos 90 dias (3 meses).')}
        ${li('<strong>Declaração de Imposto de Renda</strong> atual.')}
        ${li('Se for <strong>a trabalho</strong>: carta em papel timbrado da empresa informando reuniões/palestras/treinamentos nos EUA (temos o modelo).')}
        ${li('<strong>Autônomos</strong>: carta de prestação de serviços com firma reconhecida (temos o modelo), ou papel timbrado da empresa contratante, ou contrato de trabalho.')}
        ${li('<strong>Profissionais com conselho</strong> (médicos, advogados, dentistas, veterinários, enfermeiros, corretores etc.): carteirinha do conselho (CRM, OAB, CRMV, COREN, CRECI...).')}
        ${li('<strong>Certidão de casamento</strong> (se casado).')}
        ${li('<strong>Certidão de união estável</strong> (apenas união estável pública feita em cartório).')}
        ${li('<strong>Certidão de nascimento dos filhos</strong> que ficarão no Brasil.')}
        ${li('<strong>Documento do carro</strong> em seu nome (CRV).')}
        ${li('<strong>Atestado de matrícula</strong> e carteirinha (se estiver cursando).')}
        ${li('<strong>Diploma</strong> da faculdade (se formado).')}
        ${li('<strong>Carta do custeador</strong> (apenas se a viagem for paga por alguém que não seja pais ou cônjuge).')}
        ${li('<strong>Cópia colorida do visto americano</strong> dos acompanhantes de viagem (se possuírem).')}
        ${li('<strong>Cópia colorida de documentos de parentes nos EUA</strong> (passaporte americano, green card ou visto vigente, se houver).')}
      </ul>
      <p style="font-size:13px;">Se for a um <strong>evento específico</strong> (feira, palestra, workshop, competição): leve a carta-convite da organização ou algo que comprove o evento (folder, página do site impressa).</p>
      <h3>Se você possui empresa</h3>
      <p style="font-size:13px;margin:0 0 4px;">Demonstre que a empresa se movimenta (leve o que tiver):</p>
      <ul>
        ${li('Declaração de Imposto de Renda Pessoa Jurídica.')}
        ${li('Notas fiscais emitidas (algumas antigas e as 10 últimas).')}
        ${li('Livro/ficha de registro de funcionários (se houver).')}
        ${li('Extratos bancários PJ dos últimos 90 dias.')}
        ${li('Contratos de prestação de serviço (se for o caso).')}
        ${li('Outras comprovações de movimentação (fotos de mídias sociais, site etc.).')}
        ${li('CNPJ (emitido no site da Receita Federal) e Contrato Social.')}
      </ul>
      <h3>Estudantes</h3>
      <ul>${li('Documento que comprove a frequência na instituição declarada (declaração de escolaridade, comprovante de matrícula, carteirinha escolar identificada etc.).')}</ul>
      <div class="tip">Dica: organize tudo em uma <strong>pasta transparente e incolor</strong> — assim o agente consular vê que você está bem documentado.</div>
      <p style="font-size:13px;">Ficou com alguma dúvida? Fale com um de nossos profissionais. <strong>Não vá com dúvidas para a entrevista</strong> — cada detalhe pode fazer a diferença.</p>
    </div>
    <div class="footer">Vale Visto — Assessoria e Documentação. Este e-mail é informativo e destinado à preparação da sua entrevista.</div>
  </div></body></html>`;
}
app.post('/api/prep/send-docs', authenticateToken, async (req, res) => {
  try {
    const { leadId, email } = req.body || {};
    if (!leadId) return res.status(400).json({ error: 'leadId obrigatório' });
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [leadId]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    const clientEmail = String(email || lead.email || '').trim();
    if (!clientEmail) return res.json({ needEmail: true });
    const firstName = String(lead.name || '').trim().split(/\s+/)[0] || '';
    // Envia pelo MESMO caminho dos contratos (mail() local do servidor da Vale Visto, que ENTREGA
    // no Gmail/Hotmail). O SMTP autenticado de fora é aceito mas descartado pelos destinos.
    const token = await ds160AdminToken();
    const er = await fetch(DS160_BASE + '/send_email.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        to: clientEmail,
        subject: 'Vale Visto - Documentos e vínculos para a sua entrevista (Visto Americano)',
        html: buildPrepDocsEmail(firstName)
      })
    });
    const ej = await er.json().catch(() => ({}));
    if (!er.ok || !ej.success) return res.status(502).json({ error: (ej && ej.error) || 'Falha ao enviar o e-mail.' });
    if (!lead.email && clientEmail) { try { await runQuery("UPDATE leads SET email = ? WHERE id = ?", [clientEmail, leadId]); } catch (e) {} }
    res.json({ success: true, email: clientEmail });
  } catch (e) { console.error('[prep/send-docs]', e && e.message); res.status(500).json({ error: (e && e.message) || 'Falha ao enviar' }); }
});

// 19b. Lista de CONTRATOS do sistema VALE VISTO (gerencia_ds-160) — proxy server-a-server.
// Faz login_admin e busca contracts.php. A senha de admin NÃO trafega pelo navegador.
let _contractsCache = { ts: 0, data: null };
async function ds160AdminToken() {
  const lr = await fetch(DS160_BASE + '/auth.php?action=login_admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: DS160_ADMIN_USER, password: DS160_ADMIN_PASS })
  });
  const lj = await lr.json().catch(() => ({}));
  if (!lr.ok || !lj.token) throw new Error('Falha ao autenticar no sistema de contratos.');
  return lj.token;
}
app.get('/api/contracts', authenticateToken, async (req, res) => {
  // cache de 30s (evita re-login a cada abertura/poll)
  if (_contractsCache.data && (Date.now() - _contractsCache.ts < 30 * 1000)) {
    return res.json(_contractsCache.data);
  }
  try {
    const token = await ds160AdminToken();
    const cr = await fetch(DS160_BASE + '/contracts.php', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !Array.isArray(cj)) {
      return res.status(502).json({ error: (cj && cj.error) || 'Falha ao buscar contratos.' });
    }
    // devolve só os campos usados pela tabela (sem assinaturas/base64)
    const list = cj.map(c => ({
      id: c.id,
      closedNumber: c.closed_number != null ? Number(c.closed_number) : null,
      clientName: c.client_name || '',
      clientEmail: c.client_email || '',
      status: c.status || 'pending_client',
      createdAt: c.created_at || null,
      clientSignedAt: c.client_signed_at || null,
      adminSignedAt: c.admin_signed_at || null,
      price: c.price || ''
    }));
    _contractsCache = { ts: Date.now(), data: list };
    res.json(list);
  } catch (e) {
    // em falha, devolve o último resultado bom se houver
    if (_contractsCache.data) return res.json(_contractsCache.data);
    res.status(502).json({ error: e.message });
  }
});

// 19c-0. Modelos de contrato reutilizáveis (lista) — proxy. DEFINIDO ANTES de /:id para não ser sombreado.
app.get('/api/contracts/templates', authenticateToken, async (req, res) => {
  try {
    const token = await ds160AdminToken();
    const cr = await fetch(DS160_BASE + '/templates.php', { headers: { 'Authorization': 'Bearer ' + token } });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !Array.isArray(cj)) return res.status(502).json({ error: (cj && cj.error) || 'Falha ao buscar modelos.' });
    res.json(cj.map(t => ({ id: t.id, title: t.title || '', content: t.content || '' })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 19c. Detalhe de UM contrato (para o "Visualizar" do CRM, sem abrir a página de assinatura).
app.get('/api/contracts/:id', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'ID obrigatório' });
  try {
    const token = await ds160AdminToken();
    const cr = await fetch(DS160_BASE + '/contracts.php?id=' + encodeURIComponent(id), {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const c = await cr.json().catch(() => null);
    if (!cr.ok || !c || c.error) return res.status(502).json({ error: (c && c.error) || 'Contrato não encontrado.' });
    // remove assinaturas base64 (pesadas e desnecessárias no resumo)
    delete c.client_signature; delete c.admin_signature;
    // monta URL do PDF assinado (quando concluído) e do anexo do cliente
    const pdfUrl = (c.status === 'completed') ? (DS160_BASE + '/uploads/contracts/' + encodeURIComponent(id) + '/contrato_assinado_' + encodeURIComponent(id) + '.pdf') : null;
    // FIX 2026-07-03 ("Documento do cliente dava 404"): o anexo é salvo DENTRO da pasta da API
    // (__DIR__/uploads/... em contracts.php) → a URL certa é /api/uploads/... como a do pdfUrl
    // acima. A versão antiga tirava o /api da base e caía em /uploads/... (404 do HostGator).
    const attachmentUrl = c.client_attachment_path ? (DS160_BASE + '/' + String(c.client_attachment_path).replace(/^\/+/, '')) : null;
    // 2026-07-20 (Henry): documentos de TODOS os solicitantes (client_attachments_json).
    let attachmentsUrls = [];
    try {
      const arr = c.client_attachments_json ? JSON.parse(c.client_attachments_json) : [];
      if (Array.isArray(arr)) attachmentsUrls = arr.map(p => DS160_BASE + '/' + String(p).replace(/^\/+/, ''));
    } catch (e) {}
    if (!attachmentsUrls.length && attachmentUrl) attachmentsUrls = [attachmentUrl];
    res.json({ ...c, pdfUrl, attachmentUrl, attachmentsUrls });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 19c-bis. Salvar novo modelo de contrato — proxy. (O GET /contracts/templates é definido ANTES de /:id.)
app.post('/api/contracts/templates', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  const title = (req.body && req.body.title || '').trim();
  const content = (req.body && req.body.content || '').trim();
  if (!title || !content) return res.status(400).json({ error: 'Título e conteúdo são obrigatórios' });
  try {
    const token = await ds160AdminToken();
    const cr = await fetch(DS160_BASE + '/contracts.php?action=save_template', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content })
    });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !cj || !cj.success) return res.status(502).json({ error: (cj && cj.error) || 'Falha ao salvar modelo.' });
    res.json(cj);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 19d. Cancelar contrato a partir do CRM (proxy → contracts.php?action=cancel). Só Administrador.
app.post('/api/contracts/:id/cancel', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'ID obrigatório' });
  try {
    const token = await ds160AdminToken();
    const cr = await fetch(DS160_BASE + '/contracts.php?action=cancel', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !cj || !cj.success) return res.status(502).json({ error: (cj && cj.error) || 'Falha ao cancelar.' });
    _contractsCache = { ts: 0, data: null };
    res.json(cj);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 19e. Homologar/assinar contrato pela Vale Visto a partir do CRM (proxy → action=admin_sign). Só Admin.
app.post('/api/contracts/:id/admin-sign', authenticateToken, async (req, res) => {
  // 2026-07-18 (decisão do Henry, caso Levi): VENDEDOR PODE assinar/homologar contratos.
  // O guard de 403 foi removido SÓ desta rota; criar/cancelar contrato segue admin-only.
  const id = String(req.params.id || '').trim();
  const adminSignature = (req.body && req.body.adminSignature) || '';
  if (!id || !adminSignature) return res.status(400).json({ error: 'ID e assinatura obrigatórios' });
  try {
    const token = await ds160AdminToken();
    const cr = await fetch(DS160_BASE + '/contracts.php?action=admin_sign', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, adminSignature })
    });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !cj || !cj.success) return res.status(502).json({ error: (cj && cj.error) || 'Falha ao assinar.' });
    _contractsCache = { ts: 0, data: null };
    res.json(cj);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 19f. Criar contrato/proposta a partir do CRM (proxy → contracts.php?action=create). Só Administrador.
// Recebe os campos do formulário embutido da guia "Contratos" e monta o payload no mesmo
// formato usado pelo painel gerencia_ds-160. Quando o texto não vem preenchido, busca o
// modelo padrão (T-DEFAULT) no servidor — assim o contrato sai com o mesmo texto legal do painel.
async function ds160DefaultTemplate(token) {
  try {
    const r = await fetch(DS160_BASE + '/templates.php?id=T-DEFAULT', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const j = await r.json().catch(() => null);
    if (r.ok && j && j.content) return j.content;
  } catch (e) {}
  return '';
}
app.post('/api/contracts', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  const b = req.body || {};
  const clientName = String(b.clientName || '').trim();
  const clientEmail = String(b.clientEmail || '').trim();
  if (!clientName || !clientEmail) return res.status(400).json({ error: 'Nome e e-mail do cliente são obrigatórios.' });

  const applicantsRange = String(b.applicantsRange || '1').trim();
  const basePrice = Number(b.basePrice) || 0;
  const paymentTerms = String(b.paymentTerms || 'À vista via PIX').trim();
  const customClauses = String(b.customClauses || '').trim();

  // Serviços opcionais (mesmos rótulos do painel)
  const optionalServices = [];
  if (b.optionalSp) optionalServices.push({ label: 'Representação em São Paulo para renovação visto americano', price: Number(b.optionalSpPrice) || 0 });
  if (b.optionalPassport) optionalServices.push({ label: 'Solicitação de passaporte brasileiro', price: Number(b.optionalPassportPrice) || 0 });

  try {
    const token = await ds160AdminToken();
    let contractText = String(b.contractText || '').trim();
    if (!contractText) contractText = await ds160DefaultTemplate(token);

    const cr = await fetch(DS160_BASE + '/contracts.php?action=create', {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName,
        clientEmail,
        contractText,
        paymentTerms,
        price: String(basePrice),
        servicesScope: { applicantsRange, basePrice, optionalServices, customClauses }
      })
    });
    const cj = await cr.json().catch(() => null);
    if (!cr.ok || !cj || !cj.success) return res.status(502).json({ error: (cj && cj.error) || 'Falha ao criar contrato.' });
    _contractsCache = { ts: 0, data: null }; // invalida cache para a lista atualizar
    res.json(cj); // { success, id }
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// 20. Leads Routes: Create lead manually (botão "Novo Lead")
app.post('/api/leads', authenticateToken, async (req, res) => {
  const { name, phone, email, value, stage, source, company, priority, account, tags } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome é obrigatório" });
  // Regra: todo lead precisa de telefone OU e-mail (necessário p/ casar com a conversa e o rastreamento).
  const _hasPhone = String(phone || '').replace(/\D/g, '').length >= 8;
  const _hasEmail = /.+@.+\..+/.test(String(email || '').trim());
  if (!_hasPhone && !_hasEmail) return res.status(400).json({ error: "Informe telefone OU e-mail (todo lead precisa de pelo menos um)." });
  try {
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    // NUNCA DUPLICAR: se já existir um lead ATIVO com o mesmo telefone (últimos 8 dígitos) OU o mesmo
    // e-mail, devolve o existente em vez de criar outro card.
    const _last8 = String(phone || '').replace(/\D/g, '').slice(-8);
    const _em = String(email || '').trim().toLowerCase();
    let dup = null;
    if (_last8.length === 8) {
      dup = await getRow("SELECT * FROM leads WHERE archived = 0 AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", [`%${_last8}%`]);
    }
    if (!dup && _em) {
      dup = await getRow("SELECT * FROM leads WHERE archived = 0 AND email IS NOT NULL AND LOWER(TRIM(email)) = ? LIMIT 1", [_em]);
    }
    if (dup) {
      // REAPROVEITAMENTO AUTOMÁTICO (aprovado pelo Henry, 2026-07-02, caso Maria Eduarda): se quem
      // cadastra escolheu uma etapa do PÓS e o card existente é um lead TERMINAL do pré (declinado/
      // convertida) que ainda não pertence ao pós, o card é MOVIDO para a etapa pedida — antes ele só
      // era devolvido e o usuário pós "criava" sem ver nada. Negociação ATIVA do pré nunca é puxada.
      const _wantsPos = POS_STAGES.includes(stage) && stage !== 'clientes_antigos_pos';
      const _dupInPos = (dup.bridge === 1) || (dup.pos_stage && POS_STAGES.includes(dup.pos_stage) && dup.pos_stage !== 'clientes_antigos_pos');
      const _dupTerminalPre = ['declinado', 'convertida'].includes(dup.stage);
      if (_wantsPos && !_dupInPos && _dupTerminalPre) {
        await runQuery("UPDATE leads SET pos_stage = ?, bridge = 0 WHERE id = ?", [stage, dup.id]);
        // Complementa dados VAZIOS/mais pobres com o que foi digitado (nunca apaga nada existente).
        if (email && !(dup.email || '').trim()) await runQuery("UPDATE leads SET email = ? WHERE id = ?", [String(email).trim(), dup.id]);
        if (name && String(name).trim().length > String(dup.name || '').trim().length) await runQuery("UPDATE leads SET name = ? WHERE id = ?", [String(name).trim(), dup.id]);
        try { logLeadHistory({ leadId: dup.id, phone: dup.phone, name: dup.name, type: 'movimentacao', detail: 'Recadastrado no pós-venda — card do pré (' + dup.stage + ') reaproveitado e movido para "' + stageLabel(stage) + '"', meta: { to: stage } }); } catch (e) {}
        const upd = await getRow("SELECT * FROM leads WHERE id = ?", [dup.id]);
        return res.json({ ...upd, tags: upd.tags ? JSON.parse(upd.tags) : [], existed: true, movedToPos: true });
      }
      return res.json({ ...dup, tags: dup.tags ? JSON.parse(dup.tags) : [], existed: true });
    }
    const id = 'l_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString().slice(0, 10);
    const safeTags = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t) : [];
    // Se veio a linha de atendimento (wa1..wa4), carimba o recv_number com o número dela
    let recvNumber = null;
    if (account) {
      try {
        const acc = await getRow("SELECT number FROM whatsapp_accounts WHERE id = ?", [account]);
        recvNumber = (acc && acc.number) || null;
      } catch (e) {}
    }
    // PÓS-VENDA: se a etapa escolhida é uma COLUNA do pipeline pós (ex.: visto_amer_primeiro), grava
    // em 'pos_stage' — NUNCA no 'stage' do pré-venda (mesma regra do PATCH /stage). O lead é carimbado
    // como pós (recv_number de uma linha 2030) p/ aparecer SÓ no board pós e não vazar no pré, e
    // stage='convertida' (terminal) o mantém visível ao usuário pós sem reset de automações.
    let finalStage = stage || "novo";
    let posStage = null;
    let bridgeVal = 0;
    const _isBridge = (stage === 'clientes_antigos' || stage === 'clientes_antigos_pos');
    // VALIDAÇÃO: etapa desconhecida NUNCA entra no banco (gravava no 'stage' do pré e o card sumia
    // dos dois boards — bug do visto_amer_busca, opção fantasma no dropdown do frontend, 2026-07-02).
    const _PRE_OK = ['novo', 'tratamento', 'proposta', 'followup', 'convertida', 'declinado', 'clientes_antigos'];
    if (stage && !_isBridge && !_PRE_OK.includes(stage) && !POS_STAGES.includes(stage)) {
      return res.status(400).json({ error: 'Etapa inválida ("' + stage + '") — atualize a página (Ctrl+F5) e escolha uma etapa da lista.' });
    }
    // Função auxiliar: carimba uma linha 2030 no recv_number (p/ o lead pertencer ao ambiente pós).
    const _stampPos = async () => {
      if (recvNumber) return;
      try {
        const { posSet } = await getSaleLineFilter();
        if (posSet.size) {
          const ph = Array.from(posSet);
          const acc = await getRow("SELECT number FROM whatsapp_accounts WHERE id IN (" + ph.map(() => '?').join(',') + ") AND number IS NOT NULL LIMIT 1", ph);
          if (acc && acc.number) recvNumber = acc.number;
        }
      } catch (e) {}
    };
    if (_isBridge) {
      // Criado direto na COLUNA-PONTE: marca bridge=1; o stage de origem fica como 'convertida' (home
      // não-sentinela). Se veio do board pós, carimba como 2030.
      bridgeVal = 1;
      finalStage = "convertida";
      if (stage === 'clientes_antigos_pos') await _stampPos();
    } else if (POS_STAGES.includes(stage)) {
      posStage = stage;
      finalStage = "convertida";
      await _stampPos();
    }
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, pos_stage, bridge, source, account, owner, tags, createdAt, archived, priority, recv_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name.trim(), company || "", phone || "", email || "", Number(value) || 0, finalStage, posStage, bridgeVal, source || "Manual", account || "", (req.user && req.user.name) || "Henry Mancini", JSON.stringify(safeTags), createdAt, 0, priority || "", recvNumber]
    );
    // Criado DIRETO na ponte: grava o assunto pela regra da última movimentação (quem criou).
    if (bridgeVal === 1) {
      try { await runQuery("UPDATE leads SET bridge_subject = ? WHERE id = ?", [(await userIsPos(req)) ? 'pre' : 'pos', id]); } catch (e) {}
    }
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    sendWebhook('lead.created', { ...lead, tags: safeTags });
    res.json({ ...lead, tags: safeTags, created: true });
  } catch (err) {
    console.error("create lead error:", err && err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start Express Server
// Acha a conversa de um lead de forma robusta: por whatsapp_jid e, em fallback,
// pelos 8 últimos dígitos do telefone normalizado (resistente a formatação).
async function findConvoForLead(l) {
  let convo = null;
  if (l.whatsapp_jid) {
    convo = await getRow("SELECT id FROM conversations WHERE whatsapp_jid = ?", [l.whatsapp_jid]);
  }
  if (!convo && l.phone) {
    const p = String(l.phone).replace(/\D/g, '');
    if (p.length >= 8) {
      convo = await getRow("SELECT id FROM conversations WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?", [`%${p.slice(-8)}%`]);
    }
  }
  return convo;
}

// Reconciliação do "controle de tempo" (bolinha) e da tag "Novo lead", baseada SEMPRE na
// última mensagem real de cada conversa — é a fonte única da verdade. Roda no boot e a cada 5 min
// então o estado se autocorrige independentemente de a mensagem ter vindo pelo CRM, pelo celular
// ou pela IA (não depende de o "casamento" por telefone ter acertado na hora do envio).
//
// Regras:
//  • Cliente aguardando (bolinha acesa) SOMENTE se a última msg é do cliente ('them') E é MAIS NOVA
//    que o marcador "não é demanda" (not_demand_ts). Caso contrário, zera lastClientReply.
//  • Tag "Novo lead" (priority='novolead') é removida quando existe QUALQUER mensagem nossa de um
//    HUMANO (from='me' E ai=0) na conversa — ou seja, alguém de fato atendeu. Mensagens da IA
//    (ai=1) NÃO contam, então o card recém-transferido pela IA continua na 1ª coluna até o humano falar.
//
// Achado 1.6: antes, cada lead chamava findConvoForLead() (uma query LIKE fazendo table scan em
// conversations POR LEAD) + guard de sobreposição inexistente + intervalo de 60s. Agora: 1 SELECT
// de todas as conversas por passada, casamento em memória (Map por whatsapp_jid e por telefone
// normalizado, mesma semântica de findConvoForLead — que continua intacta e em uso em outros
// pontos), guard _reconcileRunning para nunca rodar duas passadas ao mesmo tempo, e intervalo de 5 min.
let _reconcileRunning = false;
async function reconcileReplyDots() {
  if (_reconcileRunning) return;
  _reconcileRunning = true;
  try {
    const leads = await allRows("SELECT id, whatsapp_jid, phone, priority, not_demand_ts FROM leads WHERE archived = 0");
    // Carrega TODAS as conversas de uma vez (em vez de 1 query LIKE por lead) e monta índices em
    // memória replicando a MESMA semântica de findConvoForLead(): match exato por whatsapp_jid,
    // senão pelos últimos 8 dígitos do telefone (equivalente ao LIKE '%últimos8dígitos%' do SQL
    // original, já que depois de tirar +, espaço, -, ( o telefone fica só com dígitos no final).
    const convos = await allRows("SELECT id, phone, whatsapp_jid FROM conversations");
    // Contagem agregada de mensagens por conversa (para as colunas 3-4 do "Tratamento inicial",
    // separadas por engajamento — regra configurável na guia "Resgate de leads" das Configurações).
    const msgAgg = await allRows("SELECT conversationId, COUNT(*) AS total, SUM(CASE WHEN `from`='them' THEN 1 ELSE 0 END) AS fromClient FROM messages GROUP BY conversationId");
    const msgAggByConvo = new Map();
    for (const m of msgAgg) msgAggByConvo.set(m.conversationId, { total: Number(m.total) || 0, fromClient: Number(m.fromClient) || 0 });
    const convoByJid = new Map();
    const convoByPhoneTail = new Map();
    for (const c of convos) {
      if (c.whatsapp_jid && !convoByJid.has(c.whatsapp_jid)) convoByJid.set(c.whatsapp_jid, c.id);
      const digits = String(c.phone || '').replace(/\D/g, '');
      if (digits.length >= 8) {
        const tail = digits.slice(-8);
        if (!convoByPhoneTail.has(tail)) convoByPhoneTail.set(tail, c.id);
      }
    }
    const findConvoIdFast = (l) => {
      if (l.whatsapp_jid && convoByJid.has(l.whatsapp_jid)) return convoByJid.get(l.whatsapp_jid);
      if (l.phone) {
        const p = String(l.phone).replace(/\D/g, '');
        if (p.length >= 8) {
          const tail = p.slice(-8);
          if (convoByPhoneTail.has(tail)) return convoByPhoneTail.get(tail);
        }
      }
      return null;
    };
    for (const l of leads) {
      const convoId = findConvoIdFast(l);
      if (!convoId) continue;
      const last = await getRow("SELECT `from`, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [convoId]);
      if (!last) continue;

      // last_client_ts: timestamp da última mensagem DO CLIENTE (persistente; usado para ordenar
      // todas as colunas por antiguidade da msg do cliente). Backfill/auto-correção contínua.
      try {
        const lastThem = await getRow("SELECT MAX(timestamp) AS ts FROM messages WHERE conversationId = ? AND `from` = 'them'", [convoId]);
        const lct = Number(lastThem && lastThem.ts) || 0;
        if (lct) await runQuery("UPDATE leads SET last_client_ts = ? WHERE id = ? AND COALESCE(last_client_ts,0) <> ?", [lct, l.id, lct]);
      } catch (e) {}

      // conv_msg_count / conv_client_msg_count: contagem de mensagens da conversa (total e do
      // cliente), usada para separar as colunas 3-4 do "Tratamento inicial" por engajamento.
      try {
        const agg = msgAggByConvo.get(convoId);
        if (agg) {
          await runQuery(
            "UPDATE leads SET conv_msg_count = ?, conv_client_msg_count = ? WHERE id = ? AND (COALESCE(conv_msg_count,-1) <> ? OR COALESCE(conv_client_msg_count,-1) <> ?)",
            [agg.total, agg.fromClient, l.id, agg.total, agg.fromClient]
          );
        }
      } catch (e) {}

      const lastTs = Number(last.timestamp) || 0;
      const ndTs = Number(l.not_demand_ts) || 0;
      const awaiting = (last.from === 'them') && (lastTs > ndTs);
      if (awaiting) {
        const iso = lastTs ? new Date(lastTs).toISOString() : new Date().toISOString();
        await runQuery("UPDATE leads SET lastClientReply = ? WHERE id = ?", [iso, l.id]);
      } else {
        await runQuery("UPDATE leads SET lastClientReply = NULL WHERE id = ?", [l.id]);
      }

      // Limpa "Novo lead" se um humano já respondeu nesta conversa.
      if (l.priority === 'novolead') {
        const human = await getRow("SELECT id FROM messages WHERE conversationId = ? AND `from` = 'me' AND COALESCE(ai,0) = 0 LIMIT 1", [convoId]);
        if (human) await runQuery("UPDATE leads SET priority = '' WHERE id = ? AND priority = 'novolead'", [l.id]);
      }
    }
  } catch (e) {
    console.error("reconcileReplyDots error:", e && e.message);
  } finally {
    _reconcileRunning = false;
  }
}
// Autocorreção contínua: a cada 5 min (achado 1.6 — antes 60s; além da chamada no boot).
setInterval(() => { reconcileReplyDots().catch(() => {}); }, 5 * 60 * 1000);

// Coluna "Mensagens novas não classificadas" (Grupo Visto Americano — pedido do Henry 2026-07-04):
// toda conversa NÃO LIDA numa linha do PÓS cujo contato não está em NENHUMA coluna do pós vira
// card nessa coluna (cinza, antes da Sem conta). Regras de segurança:
//  • sem lead → CRIA o card (padrão do POST: stage='convertida' + pos_stage) já com jid/telefone;
//  • lead já classificado no pós (pos_stage válido) ou na ponte → NÃO mexe;
//  • lead que o PRÉ está trabalhando (tratamento/proposta/followup) → NÃO rouba (lição JD Crawford).
async function sweepPosUnclassified() {
  try {
    const { posSet } = await getSaleLineFilter();
    if (!posSet.size) return;
    const convs = await allRows("SELECT * FROM conversations WHERE (archived IS NULL OR archived = 0) AND unread > 0");
    for (const c of convs) {
      if (!posSet.has(c.account)) continue;
      const tail = String(c.phone || String(c.whatsapp_jid || '').split('@')[0] || '').replace(/\D/g, '').slice(-8);
      let lead = null;
      if (c.whatsapp_jid) lead = await getRow("SELECT * FROM leads WHERE archived = 0 AND whatsapp_jid = ? LIMIT 1", [c.whatsapp_jid]);
      if (!lead && tail.length === 8) lead = await getRow("SELECT * FROM leads WHERE archived = 0 AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + tail]);
      if (!lead) {
        const id = 'l_' + Math.random().toString(36).substr(2, 9);
        await runQuery(
          "INSERT INTO leads (id, name, company, phone, email, value, stage, pos_stage, bridge, source, account, owner, tags, createdAt, archived, priority, whatsapp_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [id, (c.name || c.phone || 'Contato WhatsApp'), '', c.phone || '', '', 0, 'convertida', 'amer_msgs_novas', 0, 'WhatsApp', c.account || '', 'CRM', '[]', new Date().toISOString(), 0, '', c.whatsapp_jid || null]
        );
        try { logLeadHistory({ leadId: id, phone: c.phone, name: c.name, type: 'movimentacao', detail: 'Card criado em "Mensagens novas não classificadas" (mensagem não lida na linha do pós)', meta: { to: 'amer_msgs_novas' } }); } catch (e) {}
        continue;
      }
      if (lead.bridge === 1) continue;
      if (lead.pos_stage && POS_STAGES.includes(lead.pos_stage)) continue;
      if (['tratamento', 'proposta', 'followup'].includes(lead.stage)) continue;
      await runQuery("UPDATE leads SET pos_stage = 'amer_msgs_novas' WHERE id = ?", [lead.id]);
      try { logLeadHistory({ leadId: lead.id, phone: lead.phone, name: lead.name, type: 'movimentacao', detail: 'Movido para "Mensagens novas não classificadas" (mensagem não lida na linha do pós)', meta: { to: 'amer_msgs_novas' } }); } catch (e) {}
    }
  } catch (e) { console.error('sweepPosUnclassified:', e && e.message); }
}
setInterval(() => { sweepPosUnclassified().catch(() => {}); }, 60 * 1000);
setTimeout(() => { sweepPosUnclassified().catch(() => {}); }, 20 * 1000); // 1ª passada logo após o boot

// "A última mensagem do cliente não é uma demanda": marca de forma PERSISTENTE até quando
// o controle de tempo deve ficar zerado (= timestamp da última msg do cliente). Só volta a
// acender se o cliente mandar uma mensagem MAIS NOVA. Sobrevive a reconciliações/reinícios.
app.post('/api/leads/:id/not-demand', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  try {
    const lead = await getRow("SELECT id, whatsapp_jid, phone FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    let ts = Date.now();
    const convo = await findConvoForLead(lead);
    if (convo) {
      const last = await getRow("SELECT timestamp FROM messages WHERE conversationId = ? AND `from` = 'them' ORDER BY timestamp DESC LIMIT 1", [convo.id]);
      if (last && Number(last.timestamp)) ts = Number(last.timestamp);
    }
    await runQuery("UPDATE leads SET not_demand_ts = ?, lastClientReply = NULL WHERE id = ?", [ts, id]);
    res.json({ success: true, not_demand_ts: ts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remover o selo "Assinado" de forma PERSISTENTE (falso positivo). Marca signed_override = 1
// para que a varredura de e-mails nunca re-marque este lead como assinado.
app.post('/api/leads/:id/unsign', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  try {
    const lead = await getRow("SELECT id FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    await runQuery("UPDATE leads SET contract_signed = 0, signed_override = 1 WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// pipeline436: Boleto da taxa consular (coluna Com conta e sem agendar) — registra um NOVO envio
// (múltiplos permitidos) e re-arma a tag GERAR AGENDAMENTO (dismissed volta a 0).
app.post('/api/leads/:id/boleto', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  const due = String((req.body && req.body.due) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Data de vencimento inválida (use YYYY-MM-DD).' });
  try {
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    let arr = [];
    try { arr = JSON.parse(lead.boletos || '[]'); if (!Array.isArray(arr)) arr = []; } catch (e) { arr = []; }
    const sentIso = new Date().toISOString();
    arr.push({ due, sent: sentIso });
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    await runQuery("UPDATE leads SET boletos = ?, boleto_tag_dismissed = 0 WHERE id = ?", [JSON.stringify(arr), id]);
    const [dy, dm, dd] = due.split('-');
    try { logLeadHistory({ leadId: id, phone: lead.phone, name: lead.name, type: 'nota', detail: `Boleto da taxa consular enviado — vencimento ${dd}/${dm}/${dy}` }); } catch (e) {}
    const updatedLead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    res.json({ ...updatedLead, tags: updatedLead.tags ? JSON.parse(updatedLead.tags) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// pipeline436: dispensa a tag GERAR AGENDAMENTO (✕ no badge do card ou botão no modal).
app.post('/api/leads/:id/boleto-dismiss', authenticateToken, async (req, res) => {
  const id = String(req.params.id || '').trim();
  try {
    const lead = await getRow("SELECT id FROM leads WHERE id = ?", [id]);
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
    bustLeadsCache(); // escreve em leads → derruba o micro-cache do GET /api/leads
    await runQuery("UPDATE leads SET boleto_tag_dismissed = 1 WHERE id = ?", [id]);
    const updatedLead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    res.json({ ...updatedLead, tags: updatedLead.tags ? JSON.parse(updatedLead.tags) : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== IA (Gemini): configurações + teste =====
app.get('/api/settings/ai', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try { res.json(await getAiSettings()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/ai', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try {
    const cur = await getAiSettings();
    const b = req.body || {};
    ['gemini_key', 'model', 'novo_instructions', 'fu_instructions', 'movement_rules'].forEach(k => { if (b[k] !== undefined) cur[k] = String(b[k]); });
    ['enabled', 'novo_enabled', 'fu_enabled'].forEach(k => { if (b[k] !== undefined) cur[k] = !!b[k]; });
    if (b.fu_hours !== undefined) cur.fu_hours = Math.max(1, Math.min(168, Number(b.fu_hours) || 24));
    if (b.fu_max !== undefined) cur.fu_max = Math.max(0, Math.min(30, Number(b.fu_max) || 2));
    // pipeline431: ticks de coluna do follow-up (Henry) — col3 = regra do Resgate; col4 = demais
    if (b.fu_col3 !== undefined) cur.fu_col3 = !!b.fu_col3;
    if (b.fu_col4 !== undefined) cur.fu_col4 = !!b.fu_col4;
    await saveAiSettings(cur);
    res.json(cur);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/ai/test', authenticateToken, async (req, res) => {
  try {
    const cfg = await getAiSettings();
    if (req.body && req.body.gemini_key) cfg.gemini_key = String(req.body.gemini_key);
    if (req.body && req.body.model) cfg.model = String(req.body.model);
    const out = await callGemini(cfg, 'Responda apenas: OK', [{ role: 'user', text: 'teste de conexão' }], false);
    res.json({ ok: true, resposta: String(out).slice(0, 100) });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ===== CALENDLY (2026-07-07): configurações + teste + sincronização manual =====
// O cliente agenda a Reunião de Validação no Calendly → o CRM preenche validation_date no card
// e registra no histórico (ver calendly.js). Varredura automática a cada 5 min.
app.get('/api/settings/calendly', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try {
    const cfg = await getCalendlySettings();
    // O token NUNCA volta cru para a interface — só o sinal de que existe.
    res.json(Object.assign({}, cfg, { token: cfg.token ? '(configurado)' : '' }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/calendly', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try {
    const cur = await getCalendlySettings();
    const b = req.body || {};
    // token só é sobrescrito se vier NÃO-VAZIO (mesma proteção da chave Gemini contra autofill).
    if (b.token !== undefined && String(b.token).trim() !== '') cur.token = String(b.token).trim();
    if (b.event_keyword !== undefined) cur.event_keyword = String(b.event_keyword).trim();
    if (b.enabled !== undefined) cur.enabled = !!b.enabled;
    await saveCalendlySettings(cur);
    res.json(cur);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/calendly/test', authenticateToken, async (req, res) => {
  try {
    const cfg = await getCalendlySettings();
    const token = (req.body && String(req.body.token || '').trim()) || cfg.token;
    const out = await testCalendly(token);
    res.json(out);
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/api/calendly/sync', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try { res.json(await calendlySweep(logLeadHistory)); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// Reuniões de validação ATIVAS (Calendly) — alimenta a caixinha do card Agendado e a agenda do
// dia (perfil do Alexandre). Aberto a qualquer usuário logado (leitura, sem token do Calendly).
app.get('/api/calendly/meetings', authenticateToken, async (req, res) => {
  try {
    const rows = await allRows(
      "SELECT ce.uuid, ce.lead_id, ce.start_time, ce.card_date, ce.location, ce.invitee_name, ce.invitee_email, ce.qa_notes, ce.reschedule_url, " +
      "l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email, l.comments AS lead_comments " +
      "FROM calendly_events ce LEFT JOIN leads l ON l.id = ce.lead_id " +
      "WHERE ce.status = 'active' ORDER BY ce.start_time ASC", []
    );
    res.json(rows || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard: follow-ups automáticos (col 3-4) disparados por dia nos últimos 7 dias (fuso Brasília).
app.get('/api/dashboard/followups-weekly', authenticateToken, async (req, res) => {
  try {
    const range = daysRangeSP(req.query.from, req.query.to, 15);
    // Janela em ms: do início do 1º dia ao fim do último dia, em Brasília (UTC-3).
    const sinceMs = Date.parse(range[0].iso + 'T00:00:00Z') + 3 * 3600 * 1000;
    const untilMs = Date.parse(range[range.length - 1].iso + 'T00:00:00Z') + 3 * 3600 * 1000 + 24 * 3600 * 1000;
    const rows = await allRows("SELECT ts FROM followup_log WHERE ts >= ? AND ts < ?", [sinceMs, untilMs]);
    // Bucket por dia em Brasília (UTC-3): desloca 3h e pega a data UTC → AAAA-MM-DD local.
    const keyBr = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const counts = {};
    rows.forEach(r => { const k = keyBr(r.ts); counts[k] = (counts[k] || 0) + 1; });
    const days = range.map(d => { const p = d.iso.split('-'); return { day: d.iso, label: p[2] + '/' + p[1], count: counts[d.iso] || 0 }; });
    const total = days.reduce((s, d) => s + d.count, 0);
    res.json({ days, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard: PESSOAS que receberam follow-up automático num DIA (clique na barra). Dedupe por lead
// (count = nº de disparos no dia). Brasília (UTC-3). ?day=YYYY-MM-DD.
app.get('/api/dashboard/followups-day', authenticateToken, async (req, res) => {
  try {
    const day = String(req.query.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'Parâmetro day inválido (use YYYY-MM-DD).' });
    const sinceMs = Date.parse(day + 'T00:00:00Z') + 3 * 3600 * 1000;
    const untilMs = sinceMs + 24 * 3600 * 1000;
    const rows = await allRows("SELECT ts, lead_id, lead_name FROM followup_log WHERE ts >= ? AND ts < ? ORDER BY ts ASC", [sinceMs, untilMs]);
    const byLead = {};
    rows.forEach(r => {
      const k = r.lead_id || ('n:' + r.lead_name);
      const b = (byLead[k] = byLead[k] || { lead_id: r.lead_id || null, name: r.lead_name || '', count: 0, lastTs: 0 });
      b.count++; if (r.ts > b.lastTs) b.lastTs = r.ts;
    });
    const people = Object.values(byLead).sort((a, b) => b.lastTs - a.lastTs);
    res.json({ day, total: rows.length, people });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard: TEMPO MÉDIO DE RESPOSTA do VENDEDOR às mensagens dos clientes na coluna 1 do
// "Tratamento inicial" (leads stage='tratamento', pré-venda). Mede só a resposta HUMANA:
// cliente = `from='them'`; resposta = `from='me' AND ai=0` (a IA grava ai=1 e NÃO conta — senão
// a média mediria o robô, ~1s; a auto-resposta de fora do horário também é excluída pelo texto).
// Para cada demanda do cliente, mede da ÚLTIMA mensagem do cliente até a 1ª resposta humana (mesma
// referência da "bolinha de tempo"). avgMs = média; count = nº de respostas medidas na janela;
// pending = demandas em que a ÚLTIMA mensagem ainda é do cliente (bolinha acesa, aguardando humano).
// Janela em minutos via ?minutes= (padrão 60 = última hora). O front atualiza a cada 15s.
app.get('/api/dashboard/response-time', authenticateToken, async (req, res) => {
  try {
    const minutes = Math.max(1, Math.min(60 * 24 * 60, parseInt(req.query.minutes, 10) || 60)); // 1 min .. 60 dias
    const now = Date.now();
    const since = now - minutes * 60 * 1000;
    const BUFFER_MS = 6 * 3600 * 1000; // contexto p/ detectar o início de demandas próximas de "since"

    const leads = await allRows("SELECT phone, whatsapp_jid FROM leads WHERE archived = 0 AND stage = 'tratamento'");
    if (!leads.length) return res.json({ avgMs: null, count: 0, pending: 0, minutes });

    const { posSet } = await getSaleLineFilter(); // exclui as linhas pós-venda (2030)
    const convs = await allRows("SELECT id, account, phone, whatsapp_jid FROM conversations WHERE (archived IS NULL OR archived = 0)");
    const norm = (p) => String(p || '').replace(/\D/g, '');
    const convIds = [];
    for (const l of leads) {
      const lt = norm(l.phone).slice(-8);
      const conv = convs.find(c =>
        (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
        (lt.length === 8 && norm(c.phone).slice(-8) === lt)
      );
      if (conv && conv.account && !posSet.has(conv.account)) convIds.push(conv.id);
    }
    if (!convIds.length) return res.json({ avgMs: null, count: 0, pending: 0, minutes });

    // Texto da auto-resposta de fora do horário (from='me', ai=0) — não conta como resposta humana.
    let autoMsg = null;
    try {
      const bhRow = await getRow("SELECT value FROM app_settings WHERE key = 'business_hours'");
      const bh = bhRow && bhRow.value ? JSON.parse(bhRow.value) : null;
      if (bh && bh.message) autoMsg = String(bh.message).trim();
    } catch (e) {}
    const isHumanReply = (m) =>
      m.from === 'me' && Number(m.ai) === 0 && !(autoMsg && String(m.text || '').trim() === autoMsg);

    const ph = convIds.map(() => '?').join(',');
    const msgs = await allRows(
      "SELECT conversationId, `from`, COALESCE(ai,0) AS ai, text, timestamp FROM messages WHERE conversationId IN (" + ph + ") AND timestamp >= ? ORDER BY conversationId, timestamp ASC",
      [...convIds, since - BUFFER_MS]
    );

    // Varre por conversa. demandTs = ÚLTIMA mensagem do cliente sem resposta HUMANA depois (igual à
    // bolinha). Resposta humana fecha a demanda e mede o tempo. Mensagens da IA (ai=1)/auto NÃO
    // fecham a demanda nem contam. pending = conversa cuja ÚLTIMA mensagem ainda é do cliente.
    let totalMs = 0, count = 0, pending = 0;
    let curConv = null, demandTs = null, lastFrom = null;
    const finishConv = () => {
      if (lastFrom === 'them' && demandTs !== null && demandTs >= since) pending++;
      demandTs = null; lastFrom = null;
    };
    for (const m of msgs) {
      if (m.conversationId !== curConv) { finishConv(); curConv = m.conversationId; }
      const ts = m.timestamp || 0;
      if (m.from === 'them') {
        demandTs = ts; lastFrom = 'them';            // (re)inicia/atualiza a demanda na última msg do cliente
      } else if (m.from === 'me') {
        lastFrom = 'me';
        if (isHumanReply(m) && demandTs !== null) {
          if (demandTs >= since && ts >= demandTs) { totalMs += (ts - demandTs); count++; }
          demandTs = null;                            // demanda atendida por humano
        }
        // IA/auto (ai=1 ou texto da auto-resposta): ignora — não fecha nem conta.
      }
    }
    finishConv();

    res.json({ avgMs: count ? Math.round(totalMs / count) : null, count, pending, minutes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dashboard: bloqueios do filtro anti-invenção da IA por dia (últimos 7 dias, Brasília) + por tipo + amostras.
app.get('/api/dashboard/guardrail-weekly', authenticateToken, async (req, res) => {
  try {
    const range = daysRangeSP(req.query.from, req.query.to, 15);
    const sinceMs = Date.parse(range[0].iso + 'T00:00:00Z') + 3 * 3600 * 1000;
    const untilMs = Date.parse(range[range.length - 1].iso + 'T00:00:00Z') + 3 * 3600 * 1000 + 24 * 3600 * 1000;
    const rows = await allRows("SELECT ts, kind FROM ai_guardrail_log WHERE ts >= ? AND ts < ?", [sinceMs, untilMs]);
    const keyBr = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const counts = {}, byKind = {};
    rows.forEach(r => { const k = keyBr(r.ts); counts[k] = (counts[k] || 0) + 1; byKind[r.kind || '?'] = (byKind[r.kind || '?'] || 0) + 1; });
    const days = range.map(d => { const p = d.iso.split('-'); return { day: d.iso, label: p[2] + '/' + p[1], count: counts[d.iso] || 0 }; });
    const total = days.reduce((s, d) => s + d.count, 0);
    const recentes = await allRows("SELECT ts, kind, sample FROM ai_guardrail_log WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 6", [sinceMs, untilMs]);
    res.json({ days, total, byKind, recentes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dispara a IA para responder o BACKLOG de Novo Leads (cliente aguardando). Envia mensagens reais.
app.post('/api/ai/process-novo-backlog', authenticateToken, async (req, res) => {
  try {
    const r = await processNovoBacklog(req.body && req.body.limit);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// BOAS-VINDAS PROATIVAS: leads que preencheram o formulário mas ficaram SEM linha (o número estava
// desconectado quando entraram) e NUNCA foram contatados. Atribui a linha (12) 98248-3094 e envia a 1ª
// mensagem (texto fixo). Mantém o lead em 'novo' — a IA assume quando o cliente responder. MANUAL
// (disparado pelo Henry), em horário comercial, linha conectada, idempotente e com teto. ?dryRun=1 só conta.
const WELCOME_LINE_DIGITS = '5512982483094'; // (12) 98248-3094
const WELCOME_TEXT = 'Bem-vindo à Vale Visto! Sou o Thiago, como posso ajudar?';
function _digits(s) { return String(s || '').replace(/\D/g, ''); }
async function resolveWelcomeAccount() {
  const accs = await allRows("SELECT id, number FROM whatsapp_accounts");
  const want = WELCOME_LINE_DIGITS.slice(-8);
  const a = (accs || []).find(x => _digits(x.number).slice(-8) === want);
  return a ? a.id : null;
}
function _inBusinessHours() {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const wd = p.find(x => x.type === 'weekday').value;
    const h = parseInt(p.find(x => x.type === 'hour').value, 10);
    return (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd) && h >= 9 && h < 18) || (wd === 'Sat' && h >= 9 && h < 13);
  } catch (e) { return true; }
}
// Seleciona os leads ELEGÍVEIS: em 'novo', sem linha, com telefone e SEM conversa com mensagem (nunca
// contatados nem escreveram — se já têm histórico, é o backlog da IA, não boas-vindas).
async function _eligibleWelcomeLeads() {
  const leads = await allRows("SELECT * FROM leads WHERE archived = 0 AND stage = 'novo' AND (account IS NULL OR TRIM(account) = '') AND phone IS NOT NULL AND TRIM(phone) <> '' ORDER BY createdAt ASC");
  const out = [];
  for (const l of leads) {
    const digits = _digits(l.phone);
    if (digits.length < 8) continue;
    const tail = digits.slice(-8);
    let convo = null;
    if (l.whatsapp_jid) convo = await getRow("SELECT id FROM conversations WHERE whatsapp_jid = ? LIMIT 1", [l.whatsapp_jid]);
    if (!convo) convo = await getRow("SELECT id FROM conversations WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + tail]);
    if (convo) { const anyMsg = await getRow("SELECT id FROM messages WHERE conversationId = ? LIMIT 1", [convo.id]); if (anyMsg) continue; }
    out.push(l);
  }
  return out;
}
app.post('/api/ai/welcome-form-leads', authenticateToken, async (req, res) => {
  try {
    const dryRun = String((req.query && req.query.dryRun) || (req.body && req.body.dryRun) || '') === '1';
    const cap = Math.max(1, Math.min(50, Number(req.body && req.body.limit) || 25));
    const accountId = await resolveWelcomeAccount();
    if (!accountId) return res.status(400).json({ error: 'Linha de boas-vindas (12) 98248-3094 não encontrada nas contas conectadas.' });
    const isOpen = !!(sessions[accountId] && sessions[accountId].ws && sessions[accountId].ws.isOpen);
    const eligible = await _eligibleWelcomeLeads();
    if (dryRun) {
      return res.json({ ok: true, dryRun: true, count: eligible.length, lineConnected: isOpen, businessHours: _inBusinessHours(), sample: eligible.slice(0, 12).map(l => ({ id: l.id, name: l.name, phone: l.phone })) });
    }
    if (!_inBusinessHours()) return res.status(400).json({ error: 'Fora do horário comercial (Seg–Sex 9h–18h, Sáb 9h–13h). Envio bloqueado.' });
    if (!isOpen) return res.status(409).json({ error: 'A linha (12) 98248-3094 está desconectada. Conecte-a e tente de novo.' });
    let sent = 0; const errors = [];
    const num = '+' + WELCOME_LINE_DIGITS;
    for (const l of eligible) {
      if (sent >= cap) break;
      if (!antiban.isBusinessHours()) { errors.push('fora do horário comercial — boas-vindas pausadas'); break; }
      const _g = await antiban.canSendProactive(accountId);
      if (!_g.ok) { errors.push('número protegido: ' + _g.reason + ' — pausado'); break; }
      try {
        const digits = _digits(l.phone); const tail = digits.slice(-8); const jidLead = l.whatsapp_jid || '';
        let convo = null;
        if (jidLead) convo = await getRow("SELECT * FROM conversations WHERE whatsapp_jid = ? LIMIT 1", [jidLead]);
        if (!convo) convo = await getRow("SELECT * FROM conversations WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + tail]);
        if (!convo) {
          const convoId = 'c_' + Math.random().toString(36).substr(2, 9);
          const nm = l.name || digits; const av = String(nm).slice(0, 2).toUpperCase();
          const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
          await runQuery("INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, whatsapp_jid, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [convoId, accountId, nm, String(l.phone || ''), av, timeStr, 0, 0, jidLead || null, 0]);
          convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
        } else {
          await runQuery("UPDATE conversations SET account = ? WHERE id = ?", [accountId, convo.id]);
        }
        await antiban.pace(accountId);                                   // espaça com jitter (20–60s)
        await sendWhatsAppMessage(accountId, convo.id, antiban.varyText(WELCOME_TEXT)); // texto variado
        await antiban.recordSend(accountId);                             // contabiliza no cap/warm-up
        await runQuery("UPDATE leads SET account = ?, recv_number = ? WHERE id = ?", [accountId, num, l.id]);
        logLeadHistory({ leadId: l.id, phone: l.phone, name: l.name, type: 'nota', detail: 'Boas-vindas automáticas enviadas pela linha (12) 98248-3094.' });
        sent++;
      } catch (e) { errors.push((l.name || l.id) + ': ' + (e && e.message)); }
    }
    res.json({ ok: true, sent, eligibleTotal: eligible.length, remaining: Math.max(0, eligible.length - sent), errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AUDITORIA: por linha CONECTADA (exceto pós/2030), conversas cuja ÚLTIMA mensagem é do cliente — ou
// seja, cliente aguardando nossa resposta (possíveis mensagens "perdidas" que precisam de atenção).
app.get('/api/audit/awaiting-reply', authenticateToken, async (req, res) => {
  try {
    let posSet = new Set();
    try { const r = await getSaleLineFilter(); posSet = r.posSet || new Set(); } catch (e) {}
    const accs = await allRows("SELECT id, number, label FROM whatsapp_accounts");
    const numById = {}; const labelById = {};
    (accs || []).forEach(a => { numById[a.id] = a.number; labelById[a.id] = a.label; });
    const convs = await allRows("SELECT * FROM conversations WHERE (archived IS NULL OR archived = 0)");
    const lastMsgMap = await getLastMessagesMap(); // 1 query agregada em vez de 1 por conversa — elimina o N+1
    const groups = {};
    for (const c of convs) {
      if (c.account === 'ig') continue;
      if (posSet.has(c.account)) continue; // pós/2030 fora
      const last = lastMsgMap.get(c.id);
      if (!last || last.from !== 'them') continue; // só os que estão aguardando NOSSA resposta
      const ts = Number(last.timestamp) || 0; const ms = ts > 0 ? (ts < 1e12 ? ts * 1000 : ts) : Date.now();
      const key = c.account || 'sem_linha';
      (groups[key] = groups[key] || { account: key, line: numById[key] || key, label: labelById[key] || '', connected: !!(sessions[key] && sessions[key].ws && sessions[key].ws.isOpen), items: [] }).items.push({
        id: c.id, name: c.name, phone: c.phone, lastText: (last.text || '').slice(0, 120), at: new Date(ms).toISOString()
      });
    }
    const out = Object.values(groups).map(g => { g.items.sort((a, b) => new Date(b.at) - new Date(a.at)); g.count = g.items.length; return g; })
      .sort((a, b) => b.count - a.count);
    res.json({ lines: out, total: out.reduce((s, g) => s + g.count, 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== IA: protocolo de FOLLOW-UP (colunas 2-3 do Tratamento inicial) =====
// A cada 30 min procura leads em 'tratamento' SEM prioridade e SEM bolinha
// (nós falamos por último) parados há X horas; manda follow-up gerado pela IA.
let _fuRunning = false;
async function aiFollowUpSweep() {
  if (_fuRunning) return;
  _fuRunning = true;
  try {
    const cfg = await getAiSettings();
    if (!cfg.enabled || !cfg.fu_enabled || !cfg.gemini_key) return;
    // JANELA DE HORÁRIO COMERCIAL: o follow-up automático só pode SAIR entre 9h e 17h, de
    // segunda a sexta (fuso de Brasília — process.env.TZ já é America/Sao_Paulo no topo do arquivo).
    // Essa trava fica no BACKEND de propósito: a regra "envie em horário comercial" no prompt não
    // garante nada, pois o LLM só gera o TEXTO — quem decide a HORA do disparo é este código.
    // (Antes não havia trava, por isso saíam mensagens às 22h/03h.) Para mudar a janela, ajuste
    // FU_START_HOUR / FU_END_HOUR / os dias abaixo.
    {
      const FU_START_HOUR = 9;   // começa às 9h
      const FU_END_HOUR = 17;    // para às 17h (último envio até 16:59)
      const _now = new Date();
      const _day = _now.getDay();    // 0=Dom, 1=Seg ... 5=Sex, 6=Sáb (já em horário de Brasília)
      const _hour = _now.getHours();
      const _diaUtil = (_day >= 1 && _day <= 5);
      const _dentroHora = (_hour >= FU_START_HOUR && _hour < FU_END_HOUR);
      if (!_diaUtil || !_dentroHora) {
        console.log(`[IA follow-up] fora da janela comercial (seg–sex ${FU_START_HOUR}h–${FU_END_HOUR}h): dia=${_day} hora=${_hour}h — nada enviado nesta rodada.`);
        return;
      }
    }
    const horasMs = (cfg.fu_hours || 24) * 3600 * 1000;
    const leads = await allRows(
      "SELECT * FROM leads WHERE archived = 0 AND stage = 'tratamento' AND (priority IS NULL OR priority = '') AND lastClientReply IS NULL AND COALESCE(ai_fu_count, 0) < ?",
      [cfg.fu_max || 2]
    );
    if (!leads.length) return;
    // pipeline431: ticks de coluna do follow-up (Henry) — col3 = regra do Resgate; col4 = demais
    const fuCol3 = cfg.fu_col3 !== false;
    const fuCol4 = cfg.fu_col4 !== false;
    let minMessages = 4, requireClientMsg = true;
    try {
      const _rr = await getRow("SELECT value FROM app_settings WHERE key = 'lead_rescue_rules'");
      const _parsed = _rr && _rr.value ? JSON.parse(_rr.value) : null;
      if (_parsed && Number.isInteger(_parsed.minMessages)) minMessages = _parsed.minMessages;
      if (_parsed && typeof _parsed.requireClientMsg === 'boolean') requireClientMsg = _parsed.requireClientMsg;
    } catch (e) {}
    const { posSet: _posLines } = await getSaleLineFilter(); // IA não atua nas linhas pós (2030)
    const convs = await allRows("SELECT id, account, phone, whatsapp_jid FROM conversations WHERE (archived IS NULL OR archived = 0)");
    const norm = (p) => String(p || '').replace(/\D/g, '');
    // ANTI-SPAM: no máximo PER_RUN_CAP follow-ups por rodada (a cada 30 min) e com intervalo
    // aleatório entre envios. Evita disparar 100+ mensagens de uma vez (risco de ban do WhatsApp).
    const PER_RUN_CAP = 12;
    let processed = 0;
    for (const l of leads) {
      if (processed >= PER_RUN_CAP) { console.log(`[IA follow-up] limite da rodada (${PER_RUN_CAP}) atingido; o restante segue na próxima.`); break; }
      try {
        // pipeline431: ticks de coluna do follow-up (Henry) — col3 = regra do Resgate; col4 = demais
        const _q = (Number(l.conv_msg_count) || 0) >= minMessages && (!requireClientMsg || (Number(l.conv_client_msg_count) || 0) >= 1);
        const _col = _q ? 3 : 4;
        if ((_col === 3 && !fuCol3) || (_col === 4 && !fuCol4)) continue;
        const lt = norm(l.phone).slice(-8);
        const conv = convs.find(c =>
          (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
          (lt.length === 8 && norm(c.phone).slice(-8) === lt)
        );
        if (!conv || !conv.account) continue;
        if (_posLines.has(conv.account)) continue; // pós-venda (2030): sem follow-up da IA
        const last = await getRow("SELECT `from`, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [conv.id]);
        if (!last || last.from !== 'me') continue;              // só quando NÓS falamos por último (cliente não respondeu)
        if (Date.now() - (last.timestamp || 0) < horasMs) continue; // espaça os envios: ≥ fu_hours desde a última msg
        // (removido o guard ai_fu_last > last.timestamp: como o próprio follow-up vira a última msg,
        //  ele bloqueava permanentemente o 2º envio. A cadência já é controlada pela janela acima
        //  + last.from==='me' + ai_fu_count < fu_max.)
        // Re-checa o estágio AGORA (o lead pode ter virado Venda convertida entre a consulta e o envio).
        // REGRA: JAMAIS enviar mensagem automática para quem está em 'convertida' (ou fora do 'tratamento').
        const freshNow = await getRow("SELECT stage, archived FROM leads WHERE id = ?", [l.id]);
        if (!freshNow || freshNow.archived || freshNow.stage !== 'tratamento') { console.log(`[IA follow-up] "${l.name}": pulado (estágio agora = ${freshNow && freshNow.stage}).`); continue; }
        const tentativa = (l.ai_fu_count || 0) + 1;
        const texto = await getFollowUpReply(conv.id, l.name, tentativa);
        if (!texto) continue;
        const _gate = await antiban.canSendProactive(conv.account); // cap diário/horário + warm-up do número
        if (!_gate.ok) { console.log(`[IA follow-up] número ${conv.account}: ${_gate.reason} — pausando a rodada.`); break; }
        await antiban.pace(conv.account);                           // intervalo + jitter (20–60s) anti-rajada
        await sendWhatsAppMessage(conv.account, conv.id, antiban.varyText(texto)); // texto variado
        await antiban.recordSend(conv.account);
        const fuTs = Date.now();
        await runQuery("UPDATE leads SET ai_fu_count = ?, ai_fu_last = ? WHERE id = ?", [tentativa, fuTs, l.id]);
        try { await runQuery("INSERT INTO followup_log (ts, lead_id, lead_name) VALUES (?, ?, ?)", [fuTs, l.id, l.name]); } catch (e) {}
        processed++;
        console.log(`[IA follow-up] "${l.name}": tentativa ${tentativa} enviada (${processed}/${PER_RUN_CAP}).`);
      } catch (e) { console.error('[IA follow-up]', l && l.name, e && e.message); }
    }
  } catch (e) { console.error('[IA follow-up sweep]', e && e.message); }
  finally { _fuRunning = false; }
}

// ===== Regra 1.3b: auto-declínio por falta de resposta após os follow-ups =====
// Lead nas colunas 3/4 do Tratamento (stage 'tratamento', sem prioridade, sem bolinha = cliente NÃO
// respondeu) que JÁ recebeu TODAS as tentativas de follow-up (ai_fu_count >= fu_max) e cuja última
// tentativa foi há mais de 48h → move para "Lead declinou/cancelou". Roda no boot e a cada 30 min.
const AUTO_DECLINE_AFTER_MS = 48 * 3600 * 1000; // 48h após a última tentativa (definido com o Henry)
let _declineRunning = false;
async function autoDeclineExhaustedFollowups() {
  if (_declineRunning) return;
  _declineRunning = true;
  try {
    const cfg = await getAiSettings();
    const fuMax = cfg.fu_max || 2;
    if (fuMax < 1) return; // follow-up desligado → não declina automaticamente
    const cutoff = Date.now() - AUTO_DECLINE_AFTER_MS;
    const leads = await allRows(
      "SELECT * FROM leads WHERE archived = 0 AND stage = 'tratamento' AND (priority IS NULL OR priority = '') " +
      "AND lastClientReply IS NULL AND COALESCE(ai_fu_count,0) >= ? AND COALESCE(ai_fu_last,0) > 0 AND COALESCE(ai_fu_last,0) <= ?",
      [fuMax, cutoff]
    );
    let moved = 0;
    for (const l of leads) {
      // Segurança extra: se a última mensagem da conversa for do cliente, ele respondeu → NÃO declina.
      const convo = await findConvoForLead(l);
      if (convo) {
        const last = await getRow("SELECT `from` FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [convo.id]);
        if (last && last.from === 'them') continue;
      }
      const reason = 'Sem resposta após ' + (l.ai_fu_count || fuMax) + ' follow-up(s)';
      await runQuery("UPDATE leads SET stage = 'declinado', priority = '', decline_reason = ? WHERE id = ? AND stage = 'tratamento'", [reason, l.id]);
      const note = '🚫 [Automático] Movido para "Lead declinou/cancelou": ' + reason +
        ', 48h após a última tentativa (' + new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ').';
      await runQuery("UPDATE leads SET comments = TRIM(COALESCE(comments,'') || char(10) || ?) WHERE id = ?", [note, l.id]);
      moved++;
      try { const full = await getRow("SELECT * FROM leads WHERE id = ?", [l.id]); if (full) sendWebhook('lead.stage_changed', { ...full, tags: full.tags ? JSON.parse(full.tags) : [] }); } catch (e) {}
      console.log(`[auto-declínio] "${l.name}" → Lead declinou/cancelou (sem resposta após ${l.ai_fu_count || fuMax} follow-up(s)).`);
    }
    if (moved) console.log(`[auto-declínio] total: ${moved} lead(s) movidos para declinou/cancelou.`);
  } catch (e) { console.error('[auto-declínio]', e && e.message); }
  finally { _declineRunning = false; }
}

// ===== Integrações: API de entrada (marketing) + export + configurações =====
async function checkApiKey(req, res, next) {
  try {
    const key = req.headers['x-api-key'] || req.query.key;
    const cfg = await getIntegrationSettings();
    if (!cfg.api_key || !key || key !== cfg.api_key) {
      return res.status(401).json({ error: 'API key inválida' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ===== Google Ads (conta Vale Visto): métricas diárias para o dashboard =====
// GET: o dashboard lê os dias + totais, filtrado pelas MESMAS datas dos outros gráficos.
app.get('/api/dashboard/google-ads', authenticateToken, async (req, res) => {
  try {
    const days = daysRangeSP(req.query.from, req.query.to, 15);
    const fromIso = days[0].iso, toIso = days[days.length - 1].iso;
    const rows = await allRows(
      "SELECT date, clicks, cost, conversions, impressions FROM google_ads_daily WHERE date >= ? AND date <= ? ORDER BY date ASC",
      [fromIso, toIso]
    );
    const byDate = {}; rows.forEach(r => { byDate[r.date] = r; });
    const series = days.map(d => {
      const r = byDate[d.iso] || {};
      return { date: d.iso, label: d.label, clicks: Number(r.clicks || 0), cost: Number(r.cost || 0), conversions: Number(r.conversions || 0), impressions: Number(r.impressions || 0) };
    });
    const sum = (k) => series.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const clicks = sum('clicks'), cost = sum('cost'), conversions = sum('conversions'), impressions = sum('impressions');
    res.json({
      from: fromIso, to: toIso, days: series,
      totals: { clicks, cost, conversions, impressions, cpc: clicks > 0 ? cost / clicks : 0, costPerConv: conversions > 0 ? cost / conversions : 0 }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST (X-API-Key): a sincronização (Supermetrics → CRM) grava/atualiza os dias (upsert por data).
// Aceita também os DETALHAMENTOS (opcionais, mesma chamada ou chamadas separadas):
//   campaigns: [{date, campaign, clicks, cost, conversions, impressions}]  → google_ads_campaign_daily
//   keywords:  [{date, keyword,  clicks, cost, conversions, impressions}]  → google_ads_keyword_daily
//   searches:  [{date, term, clicks}]                                      → google_ads_search_daily
app.post('/api/integrations/google-ads-daily', checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const campaigns = Array.isArray(b.campaigns) ? b.campaigns : [];
    const keywords = Array.isArray(b.keywords) ? b.keywords : [];
    const searches = Array.isArray(b.searches) ? b.searches : [];
    if (!rows.length && !campaigns.length && !keywords.length && !searches.length) return res.status(400).json({ error: 'rows/campaigns/keywords/searches vazios' });
    const now = new Date().toISOString();
    const okDate = (r) => { const d = String(r.date || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null; };
    let n = 0;
    for (const r of rows) {
      const date = okDate(r); if (!date) continue;
      await runQuery(
        "INSERT INTO google_ads_daily (date, clicks, cost, conversions, impressions, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, cost=excluded.cost, conversions=excluded.conversions, impressions=excluded.impressions, updated_at=excluded.updated_at",
        [date, Math.round(Number(r.clicks) || 0), Number(r.cost) || 0, Number(r.conversions) || 0, Math.round(Number(r.impressions) || 0), now]
      );
      n++;
    }
    let nc = 0;
    for (const r of campaigns) {
      const date = okDate(r); const name = String(r.campaign || '').trim().slice(0, 200);
      if (!date || !name) continue;
      await runQuery(
        "INSERT INTO google_ads_campaign_daily (date, campaign, clicks, cost, conversions, impressions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(date, campaign) DO UPDATE SET clicks=excluded.clicks, cost=excluded.cost, conversions=excluded.conversions, impressions=excluded.impressions, updated_at=excluded.updated_at",
        [date, name, Math.round(Number(r.clicks) || 0), Number(r.cost) || 0, Number(r.conversions) || 0, Math.round(Number(r.impressions) || 0), now]
      );
      nc++;
    }
    let nk = 0;
    for (const r of keywords) {
      const date = okDate(r); const name = String(r.keyword || '').trim().slice(0, 200);
      if (!date || !name) continue;
      await runQuery(
        "INSERT INTO google_ads_keyword_daily (date, keyword, clicks, cost, conversions, impressions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(date, keyword) DO UPDATE SET clicks=excluded.clicks, cost=excluded.cost, conversions=excluded.conversions, impressions=excluded.impressions, updated_at=excluded.updated_at",
        [date, name, Math.round(Number(r.clicks) || 0), Number(r.cost) || 0, Number(r.conversions) || 0, Math.round(Number(r.impressions) || 0), now]
      );
      nk++;
    }
    let ns = 0;
    for (const r of searches) {
      const date = okDate(r); const term = String(r.term || '').trim().slice(0, 200);
      if (!date || !term) continue;
      await runQuery(
        "INSERT INTO google_ads_search_daily (date, term, clicks, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(date, term) DO UPDATE SET clicks=excluded.clicks, updated_at=excluded.updated_at",
        [date, term, Math.round(Number(r.clicks) || 0), now]
      );
      ns++;
    }
    res.json({ success: true, upserted: n, campaigns: nc, keywords: nk, searches: ns });
  } catch (e) { console.error('[google-ads-daily ingest]', e && e.message); res.status(500).json({ error: e.message }); }
});

// GET: detalhamento do Google Ads AGREGADO no período — campanhas, palavras-chave e principais
// buscas — para as tabelas do painel verde do dashboard. Tx conv = conversões ÷ cliques.
app.get('/api/dashboard/google-ads-breakdown', authenticateToken, async (req, res) => {
  try {
    const days = daysRangeSP(req.query.from, req.query.to, 15);
    const fromIso = days[0].iso, toIso = days[days.length - 1].iso;
    const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const campaigns = await allRows(
      "SELECT campaign AS name, SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(conversions) AS conversions, SUM(impressions) AS impressions " +
      "FROM google_ads_campaign_daily WHERE date >= ? AND date <= ? GROUP BY campaign HAVING SUM(clicks) > 0 OR SUM(cost) > 0 ORDER BY SUM(cost) DESC LIMIT ?",
      [fromIso, toIso, lim]
    );
    const keywords = await allRows(
      "SELECT keyword AS name, SUM(clicks) AS clicks, SUM(cost) AS cost, SUM(conversions) AS conversions, SUM(impressions) AS impressions " +
      "FROM google_ads_keyword_daily WHERE date >= ? AND date <= ? GROUP BY keyword HAVING SUM(clicks) > 0 OR SUM(cost) > 0 ORDER BY SUM(cost) DESC LIMIT ?",
      [fromIso, toIso, lim]
    );
    const searches = await allRows(
      "SELECT term AS name, SUM(clicks) AS clicks FROM google_ads_search_daily WHERE date >= ? AND date <= ? GROUP BY term HAVING SUM(clicks) > 0 ORDER BY SUM(clicks) DESC LIMIT ?",
      [fromIso, toIso, lim]
    );
    const enrich = (r) => ({
      name: r.name, clicks: Number(r.clicks) || 0, cost: Number(r.cost) || 0, conversions: Number(r.conversions) || 0,
      cpl: (Number(r.conversions) || 0) > 0 ? (Number(r.cost) || 0) / Number(r.conversions) : 0,
      txConv: (Number(r.clicks) || 0) > 0 ? (Number(r.conversions) || 0) / Number(r.clicks) * 100 : 0
    });
    res.json({ from: fromIso, to: toIso, campaigns: campaigns.map(enrich), keywords: keywords.map(enrich), searches: searches.map(s => ({ name: s.name, clicks: Number(s.clicks) || 0 })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET: Ponto ótimo de investimento (Google Ads) — janela FIXA de 30 dias, auto-calibrada com
// dados reais (google_ads_daily + leads do CRM). Contrato fixo consumido pelo frontend
// (crmRenderOptPoint): { window, ads, funnel, ticket, updated_at }.
app.get('/api/dashboard/optimal-point', authenticateToken, async (req, res) => {
  try {
    const days = daysRangeSP(req.query.from, req.query.to, 30);
    const fromIso = days[0].iso, toIso = days[days.length - 1].iso;

    const adsRows = await allRows(
      "SELECT date, clicks, cost, conversions, impressions FROM google_ads_daily WHERE date >= ? AND date <= ?",
      [fromIso, toIso]
    );
    let cost = 0, clicks = 0, conversions = 0, impressions = 0, activeDays = 0;
    adsRows.forEach(r => {
      const c = Number(r.cost) || 0;
      cost += c;
      clicks += Number(r.clicks) || 0;
      conversions += Number(r.conversions) || 0;
      impressions += Number(r.impressions) || 0;
      if (c > 0) activeDays++;
    });
    const cpc = clicks > 0 ? cost / clicks : 0;

    const leadRows = await allRows(
      "SELECT createdAt, tracking, source, stage, value FROM leads WHERE substr(createdAt,1,10) >= ? AND substr(createdAt,1,10) <= ? AND archived = 0 AND COALESCE(source,'') <> 'Planilha Americano'",
      [fromIso, toIso]
    );
    let leadsGA = 0, convGA = 0;
    const ticketGaVals = [];
    const ticketAllVals = [];
    leadRows.forEach(l => {
      const cat = leadChannelCat(l);
      const isConv = l.stage === 'convertida';
      const val = Number(l.value) || 0;
      if (cat === 'ga') {
        leadsGA++;
        if (isConv) {
          convGA++;
          if (val > 0) ticketGaVals.push(val);
        }
      }
      if (isConv && val > 0) ticketAllVals.push(val);
    });
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const daysCount = days.length || 30;
    const spendMonthly = cost * 30.4 / daysCount;
    const clicksMonthly = clicks * 30.4 / daysCount;
    const leadsGAMonthly = leadsGA * 30.4 / daysCount;
    const c2qPct = clicks > 0 ? (leadsGA / clicks) * 100 : 0;
    const closePct = leadsGA > 0 ? (convGA / leadsGA) * 100 : 0;

    res.json({
      window: { from: fromIso, to: toIso, days: daysCount },
      ads: { cost, clicks, conversions, impressions, cpc, activeDays, spendMonthly, clicksMonthly },
      funnel: { leadsGA, convGA, leadsGAMonthly, c2qPct, closePct },
      ticket: { ga: avg(ticketGaVals), all: avg(ticketAllVals), n: convGA },
      updated_at: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings: premissas da calculadora de ponto ótimo (margem de contribuição e teto de cliques/mês).
app.get('/api/settings/optimal-point', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'optimal_point'");
    if (row && row.value) {
      try { return res.json(JSON.parse(row.value)); } catch (e) { return res.json({}); }
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/optimal-point', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const value = JSON.stringify(req.body || {});
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES ('optimal_point', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [value]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ponto ótimo — META ADS (pedido do Henry, 2026-07-21): mesmo CONTRATO do
// /dashboard/optimal-point, mas com cost = spend de meta_ads_daily e funil do canal 'meta'
// (leadChannelCat). Mantém os NOMES de campos (leadsGA/convGA/ticket.ga) de propósito:
// o front usa um renderizador único para os dois cards. ──
app.get('/api/dashboard/optimal-point-meta', authenticateToken, async (req, res) => {
  try {
    const days = daysRangeSP(req.query.from, req.query.to, 30);
    const fromIso = days[0].iso, toIso = days[days.length - 1].iso;

    const adsRows = await allRows(
      "SELECT date, clicks, spend, results, impressions FROM meta_ads_daily WHERE date >= ? AND date <= ?",
      [fromIso, toIso]
    );
    let cost = 0, clicks = 0, conversions = 0, impressions = 0, activeDays = 0;
    adsRows.forEach(r => {
      const c = Number(r.spend) || 0;
      cost += c;
      clicks += Number(r.clicks) || 0;
      conversions += Number(r.results) || 0;
      impressions += Number(r.impressions) || 0;
      if (c > 0) activeDays++;
    });
    const cpc = clicks > 0 ? cost / clicks : 0;

    const leadRows = await allRows(
      "SELECT createdAt, tracking, source, stage, value FROM leads WHERE substr(createdAt,1,10) >= ? AND substr(createdAt,1,10) <= ? AND archived = 0 AND COALESCE(source,'') <> 'Planilha Americano'",
      [fromIso, toIso]
    );
    let leadsGA = 0, convGA = 0;
    const ticketGaVals = [];
    const ticketAllVals = [];
    leadRows.forEach(l => {
      const cat = leadChannelCat(l);
      const isConv = l.stage === 'convertida';
      const val = Number(l.value) || 0;
      if (cat === 'meta') {
        leadsGA++;
        if (isConv) {
          convGA++;
          if (val > 0) ticketGaVals.push(val);
        }
      }
      if (isConv && val > 0) ticketAllVals.push(val);
    });
    const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const daysCount = days.length || 30;
    res.json({
      window: { from: fromIso, to: toIso, days: daysCount },
      ads: { cost, clicks, conversions, impressions, cpc, activeDays, spendMonthly: cost * 30.4 / daysCount, clicksMonthly: clicks * 30.4 / daysCount },
      funnel: { leadsGA, convGA, leadsGAMonthly: leadsGA * 30.4 / daysCount, c2qPct: clicks > 0 ? (leadsGA / clicks) * 100 : 0, closePct: leadsGA > 0 ? (convGA / leadsGA) * 100 : 0 },
      ticket: { ga: avg(ticketGaVals), all: avg(ticketAllVals), n: convGA },
      updated_at: new Date().toISOString()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Settings: premissas do ponto ótimo do META (margem/teto próprios — saturação difere do Google).
app.get('/api/settings/optimal-point-meta', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'optimal_point_meta'");
    if (row && row.value) {
      try { return res.json(JSON.parse(row.value)); } catch (e) { return res.json({}); }
    }
    res.json({});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings/optimal-point-meta', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') {
    return res.status(403).json({ detail: "Sem permissão para alterar configurações" });
  }
  try {
    const value = JSON.stringify(req.body || {});
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES ('optimal_point_meta', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [value]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// META ADS — gasto da conta por período (lê meta_ads_daily). Mesma estrutura do google-ads.
app.get('/api/dashboard/meta-ads', authenticateToken, async (req, res) => {
  try {
    const days = daysRangeSP(req.query.from, req.query.to, 15);
    const fromIso = days[0].iso, toIso = days[days.length - 1].iso;
    const rows = await allRows(
      "SELECT date, spend, clicks, impressions, reach, results, engagements FROM meta_ads_daily WHERE date >= ? AND date <= ? ORDER BY date ASC",
      [fromIso, toIso]
    );
    const byDate = {}; rows.forEach(r => { byDate[r.date] = r; });
    const series = days.map(d => {
      const r = byDate[d.iso] || {};
      return { date: d.iso, label: d.label, spend: Number(r.spend || 0), clicks: Number(r.clicks || 0), impressions: Number(r.impressions || 0), reach: Number(r.reach || 0), results: Number(r.results || 0), engagements: Number(r.engagements || 0) };
    });
    const sum = (k) => series.reduce((a, x) => a + (Number(x[k]) || 0), 0);
    const spend = sum('spend'), clicks = sum('clicks'), impressions = sum('impressions'), reach = sum('reach'), results = sum('results'), engagements = sum('engagements');
    res.json({
      from: fromIso, to: toIso, days: series,
      totals: {
        spend, clicks, impressions, reach, results, engagements,
        cpc: clicks > 0 ? spend / clicks : 0, costPerResult: results > 0 ? spend / results : 0,
        ctr: impressions > 0 ? clicks / impressions * 100 : 0, frequency: reach > 0 ? impressions / reach : 0
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST (X-API-Key): sincronização (Pipeboard/Supermetrics → CRM) grava/atualiza o gasto do Meta por dia.
// Body: { rows: [{ date:'YYYY-MM-DD', spend, clicks, impressions, reach, results }] }.
app.post('/api/integrations/meta-ads-daily', checkApiKey, async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'rows vazio' });
    const now = new Date().toISOString();
    let n = 0;
    for (const r of rows) {
      const date = String(r.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      await runQuery(
        "INSERT INTO meta_ads_daily (date, spend, clicks, impressions, reach, results, engagements, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET spend=excluded.spend, clicks=excluded.clicks, impressions=excluded.impressions, reach=excluded.reach, results=excluded.results, engagements=excluded.engagements, updated_at=excluded.updated_at",
        [date, Number(r.spend) || 0, Math.round(Number(r.clicks) || 0), Math.round(Number(r.impressions) || 0), Math.round(Number(r.reach) || 0), Number(r.results) || 0, Math.round(Number(r.engagements) || 0), now]
      );
      n++;
    }
    res.json({ success: true, upserted: n });
  } catch (e) { console.error('[meta-ads-daily ingest]', e && e.message); res.status(500).json({ error: e.message }); }
});

// ===== CONEXÃO DIRETA com a conta do Meta Ads (API de Marketing) =====
async function getMetaAdsCfg() {
  const a = await getRow("SELECT value FROM app_settings WHERE key = 'meta_ad_account_id'");
  const t = await getRow("SELECT value FROM app_settings WHERE key = 'meta_ads_token'");
  return { account_id: (a && a.value) || '', token: (t && t.value) || '' };
}
async function setAppSetting(key, value) {
  await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}
// Busca o gasto DIÁRIO na API de Marketing do Meta e faz upsert em meta_ads_daily. Retorna nº de dias.
async function syncMetaAds(fromIso, toIso) {
  const cfg = await getMetaAdsCfg();
  if (!cfg.account_id || !cfg.token) throw new Error('Configure o ID da conta de anúncios e o token do Meta primeiro.');
  const acct = /^act_/.test(cfg.account_id) ? cfg.account_id : ('act_' + String(cfg.account_id).replace(/\D/g, ''));
  const until = (toIso && /^\d{4}-\d{2}-\d{2}$/.test(toIso)) ? toIso : new Date().toISOString().slice(0, 10);
  const since = (fromIso && /^\d{4}-\d{2}-\d{2}$/.test(fromIso)) ? fromIso : new Date(Date.now() - 32 * 864e5).toISOString().slice(0, 10);
  let next = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(acct) + '/insights'
    + '?level=account&time_increment=1&limit=500'
    + '&fields=spend,impressions,clicks,reach,actions'
    + '&time_range=' + encodeURIComponent(JSON.stringify({ since, until }))
    + '&access_token=' + encodeURIComponent(cfg.token);
  let n = 0, guard = 0;
  while (next && guard < 20) {
    guard++;
    const r = await fetch(next);
    const d = await r.json();
    if (d && d.error) throw new Error('Meta: ' + (d.error.message || JSON.stringify(d.error)));
    const rows = (d && Array.isArray(d.data)) ? d.data : [];
    for (const x of rows) {
      const date = String(x.date_start || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      let results = 0, engagements = 0;
      if (Array.isArray(x.actions)) {
        const msg = x.actions.find(a => /messaging_conversation_started|onsite_conversion\.messaging/i.test(a.action_type || ''));
        results = msg ? (Number(msg.value) || 0) : 0;
        const eng = x.actions.find(a => String(a.action_type || '') === 'post_engagement');
        engagements = eng ? (Number(eng.value) || 0) : 0;
      }
      await runQuery(
        "INSERT INTO meta_ads_daily (date, spend, clicks, impressions, reach, results, engagements, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET spend=excluded.spend, clicks=excluded.clicks, impressions=excluded.impressions, reach=excluded.reach, results=excluded.results, engagements=excluded.engagements, updated_at=excluded.updated_at",
        [date, Number(x.spend) || 0, Math.round(Number(x.clicks) || 0), Math.round(Number(x.impressions) || 0), Math.round(Number(x.reach) || 0), results, engagements, new Date().toISOString()]
      );
      n++;
    }
    next = (d && d.paging && d.paging.next) ? d.paging.next : null;
  }
  return n;
}
// Config (admin). GET nunca devolve o token (só informa se está definido). POST grava conta e, se vier, o token.
app.get('/api/settings/meta-ads', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  try { const cfg = await getMetaAdsCfg(); res.json({ account_id: cfg.account_id, has_token: !!cfg.token }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/meta-ads', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  try {
    const { account_id, token } = req.body || {};
    if (account_id !== undefined) await setAppSetting('meta_ad_account_id', String(account_id || '').trim());
    // Token: SANITIZA (remove espaços/quebras de linha internos, prefixo "Bearer" e aspas — tokens
    // colados de e-mail/WhatsApp vêm quebrados) e VALIDA na Graph API ANTES de salvar. Isso evita o
    // "Cannot parse access token" por token deformado ou por autofill do navegador no campo password.
    const rawTok = token !== undefined ? String(token) : '';
    const cleanTok = rawTok.replace(/^\s*Bearer\s+/i, '').replace(/["'‘’“”]/g, '').replace(/\s+/g, '');
    if (cleanTok !== '') {
      if (!/^[A-Za-z0-9_\-|.]{40,}$/.test(cleanTok)) {
        return res.status(400).json({ error: 'Token inválido: não parece um token do Meta (verifique se copiou o token inteiro, sem senha do navegador no lugar).' });
      }
      const vr = await fetch('https://graph.facebook.com/v21.0/me?access_token=' + encodeURIComponent(cleanTok));
      const vd = await vr.json();
      if (vd && vd.error) {
        return res.status(400).json({ error: 'Meta recusou o token: ' + (vd.error.message || 'inválido') + ' — gere um novo token de System User com ads_read e cole de novo.' });
      }
      await setAppSetting('meta_ads_token', cleanTok);
      _metaCampCache = { at: 0, data: null }; // limpa o cache de campanhas p/ usar o token novo
    }
    const cfg = await getMetaAdsCfg();
    res.json({ ok: true, account_id: cfg.account_id, has_token: !!cfg.token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/integrations/meta-ads/sync', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
  try {
    const { from, to } = req.body || {};
    const n = await syncMetaAds(from, to);
    res.json({ ok: true, synced: n });
  } catch (e) { res.status(400).json({ error: (e && e.message) || 'Falha ao sincronizar com o Meta.' }); }
});

// CAMPANHAS ATIVAS do Meta (nome, status, orçamento e ids p/ links do Gerenciador) — busca ao vivo
// na Graph API com cache de 10 min. Orçamento: da campanha (CBO) ou soma dos conjuntos ativos.
let _metaCampCache = { at: 0, data: null };
app.get('/api/dashboard/meta-campaigns', authenticateToken, async (req, res) => {
  try {
    if (_metaCampCache.data && (Date.now() - _metaCampCache.at) < 10 * 60 * 1000) return res.json(_metaCampCache.data);
    const cfg = await getMetaAdsCfg();
    if (!cfg.account_id || !cfg.token) return res.json({ account: '', campaigns: [] });
    const acct = /^act_/.test(cfg.account_id) ? cfg.account_id : ('act_' + String(cfg.account_id).replace(/\D/g, ''));
    const url = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(acct) + '/campaigns'
      + '?fields=' + encodeURIComponent('id,name,effective_status,daily_budget,lifetime_budget,adsets.limit(50){daily_budget,lifetime_budget,effective_status}')
      + '&limit=100&access_token=' + encodeURIComponent(cfg.token);
    const r = await fetch(url);
    const d = await r.json();
    if (d && d.error) throw new Error('Meta: ' + (d.error.message || JSON.stringify(d.error)));
    const list = (Array.isArray(d.data) ? d.data : []).map(c => {
      let daily = Number(c.daily_budget) || 0, life = Number(c.lifetime_budget) || 0, budgetLevel = 'campanha';
      if (!daily && !life && c.adsets && Array.isArray(c.adsets.data)) {
        budgetLevel = 'conjuntos';
        c.adsets.data.forEach(s => {
          if (String(s.effective_status || '') === 'ACTIVE') { daily += Number(s.daily_budget) || 0; life += Number(s.lifetime_budget) || 0; }
        });
      }
      // Orçamentos da Graph API vêm em CENTAVOS.
      return { id: c.id, name: c.name, status: c.effective_status, dailyBudget: daily / 100, lifetimeBudget: life / 100, budgetLevel };
    });
    const out = { account: acct.replace(/^act_/, ''), campaigns: list.filter(c => String(c.status) === 'ACTIVE') };
    _metaCampCache = { at: Date.now(), data: out };
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Sincronização automática (no boot, se configurado, e a cada 6h).
async function syncMetaAdsSafe() {
  try { const cfg = await getMetaAdsCfg(); if (cfg.account_id && cfg.token) { const n = await syncMetaAds(); console.log('[meta-ads sync] ' + n + ' dia(s) atualizados.'); } }
  catch (e) { console.error('[meta-ads sync]', e && e.message); }
}
setTimeout(syncMetaAdsSafe, 25000);
setInterval(syncMetaAdsSafe, 6 * 60 * 60 * 1000);

// Configurações de integração (admin)
app.get('/api/settings/integrations', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try {
    const cfg = await getIntegrationSettings();
    if (!cfg.api_key) { cfg.api_key = newApiKey(); await saveIntegrationSettings(cfg); }
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/integrations', authenticateToken, async (req, res) => {
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ detail: 'Sem permissão' });
  try {
    const cfg = await getIntegrationSettings();
    const { webhook_url, webhook_secret, webhook_enabled, regenerate_key } = req.body || {};
    if (webhook_url !== undefined) cfg.webhook_url = String(webhook_url).trim();
    if (webhook_secret !== undefined) cfg.webhook_secret = String(webhook_secret).trim();
    if (webhook_enabled !== undefined) cfg.webhook_enabled = !!webhook_enabled;
    if (regenerate_key) cfg.api_key = newApiKey();
    if (!cfg.api_key) cfg.api_key = newApiKey();
    await saveIntegrationSettings(cfg);
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deriva o CANAL de origem a partir do rastreamento: "Google Ads", "Meta Ads", "Orgânico" ou a
// própria fonte (capitalizada) quando for outra origem paga conhecida pela utm_source.
function deriveChannel(tk) {
  // Lê UTMs/gclid do topo E de dentro do referrer/landing_page (formulários que mandam só na URL).
  const p = extractAdParams(tk);
  const src = String(p.utm_source || '').toLowerCase();
  const med = String(p.utm_medium || '').toLowerCase();
  // Sinais FORTES de clique de anúncio têm prioridade ATÉ sobre o channel gravado — que pode estar
  // defasado/errado (ex.: lead com gclid + utm_source=Google Ads foi rotulado "Meta Ads"/"Orgânico"
  // por engano). gclid = clique do Google; fbclid = clique do Meta.
  if (p.gclid || /google|adwords|gads/.test(src)) return 'Google Ads';
  if (p.fbclid || /facebook|meta|instagram|\bfb\b|\big\b/.test(src) || /facebook|meta|instagram/.test(med)) return 'Meta Ads';
  // Sem sinal de clique de anúncio: usa o channel explícito (classificação manual/por mensagem) se houver.
  if (tk && typeof tk.channel === 'string' && tk.channel.trim()) return tk.channel.trim();
  if (src && src !== 'direct' && src !== '(direct)') return src.charAt(0).toUpperCase() + src.slice(1);
  return 'Orgânico';
}

// Categoria do gráfico (ga|meta|org|semclass) de um lead — FONTE ÚNICA usada tanto no gráfico
// "Leads por canal" quanto no endpoint que lista os leads de um dia+canal (popup). Canal pelo
// rastreamento (deriveChannel); sem prova no tracking, confia no campo source; senão org/semclass.
function leadChannelCat(l) {
  let ch = '';
  if (l && l.tracking) {
    try { const tk = JSON.parse(l.tracking); if (tk && typeof tk === 'object' && Object.keys(tk).length) ch = deriveChannel(tk); } catch (e) {}
  }
  // ga/meta: delega ao synthChannel (fonte única) — assim source_locked (origem manual travada) e
  // os aliases de Meta (facebook/instagram/meta/comentário Meta, inclusive via TAG) contam aqui também.
  const synth = synthChannel(l);
  if (synth === 'Google Ads') return 'ga';
  if (synth === 'Meta Ads') return 'meta';
  if (ch) return 'org';
  return 'semclass';
}

// ===== CANAL de chegada para o HISTÓRICO (Google / Meta / Orgânico / Outros) =====
// Normaliza o canal derivado nos quatro baldes que o Henry pediu.
function channelBucketLabel(ch) {
  const c = String(ch || '').trim();
  if (c === 'Google Ads') return 'Google Ads';
  if (c === 'Meta Ads') return 'Meta Ads';
  if (/^org/i.test(c)) return 'Orgânico';
  return c ? ('Outros (' + c + ')') : 'Outros';
}
// Canal SINTETIZADO do lead (quando não há evento 'canal' gravado): tracking → source → Orgânico.
function synthChannel(lead) {
  // Origem MANUAL travada (combo Origem do modal): tem prioridade sobre tracking/backfills.
  if (lead && Number(lead.source_locked) === 1) {
    const s = String(lead.source || '').trim().toLowerCase();
    if (s === 'google ads') return 'Google Ads';
    if (['meta ads', 'facebook ads', 'facebook', 'instagram', 'meta', 'comentário meta', 'comentario meta'].indexOf(s) !== -1) return 'Meta Ads';
    if (/^org/.test(s)) return 'Orgânico';
    if (s.indexOf('sem ') === 0) return 'Sem identificação';
    return channelBucketLabel(lead.source);
  }
  let ch = '';
  try { if (lead && lead.tracking) { const tk = JSON.parse(lead.tracking); if (tk && typeof tk === 'object' && Object.keys(tk).length) ch = deriveChannel(tk); } } catch (e) {}
  if (!ch) {
    const s = String((lead && lead.source) || '').trim().toLowerCase();
    if (s === 'google ads') ch = 'Google Ads';
    else if (['meta ads', 'facebook ads', 'facebook', 'instagram', 'meta', 'comentário meta', 'comentario meta'].indexOf(s) !== -1) ch = 'Meta Ads';
    else if (s && s !== 'manual' && s !== 'marketing') ch = (lead && lead.source) || '';
    else ch = 'Orgânico';
    // Tags do lead (ex.: "comentário Meta") também contam como Meta Ads.
    try {
      const tg = JSON.parse((lead && lead.tags) || '[]');
      if (Array.isArray(tg) && (tg.indexOf('comentário Meta') !== -1 || tg.indexOf('Meta') !== -1)) ch = 'Meta Ads';
    } catch (e) {}
  }
  return channelBucketLabel(ch);
}
// Registra um evento 'canal' no histórico. De-dup: NÃO repete o MESMO canal se já houver um nos últimos
// 30 min (evita duplicar dupla-submissão); canal DIFERENTE sempre registra (retorno por outro canal).
async function logCanal({ leadId, phone, name, channel, isReturn }) {
  try {
    const bucket = channelBucketLabel(channel);
    const digits = String(phone || '').replace(/\D/g, '');
    const tail = digits.slice(-8);
    const last = await getRow(
      "SELECT detail, created_at FROM lead_history WHERE type = 'canal' AND (lead_id = ? OR (phone IS NOT NULL AND ? <> '' AND phone LIKE ?)) ORDER BY created_at DESC LIMIT 1",
      [leadId, tail, '%' + tail + '%']
    );
    if (last) {
      const same = String(last.detail || '').endsWith(bucket);
      const ageMin = (Date.now() - new Date(last.created_at).getTime()) / 60000;
      if (same && ageMin < 30) return; // mesma chegada recente — não duplica
    }
    const detail = (isReturn ? 'Voltou pelo canal: ' : 'Chegou pelo canal: ') + bucket;
    await logLeadHistory({ leadId, phone, name, type: 'canal', detail, meta: { channel: bucket } });
  } catch (e) { console.error('[history] logCanal falhou:', e && e.message); }
}

// API de ENTRADA: recebe leads/rastreamento do marketing digital.
// Body: { name, phone, email, value, service, source, utm_source, utm_medium,
//         utm_campaign, utm_term, utm_content, gclid, fbclid, landing_page }
// Se telefone/e-mail já existir no funil: só CARIMBA o rastreamento no card existente.
app.post('/api/integrations/lead', checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    // Aceita os nomes do CRM E os dos formulários do Marco (contact_*). ADITIVO — nada que já
    // existe deixa de funcionar; só amplia o que o endpoint entende.
    const name = b.name || b.contact_name || '';
    const phone = b.phone || b.contact_phone || '';
    const email = b.email || b.contact_email || '';
    const company = b.company || b.contact_company || '';
    const notes = b.notes || b.comments || '';
    const service = b.service || '';
    if (!name && !phone && !email) {
      return res.status(400).json({ error: 'Informe ao menos name/contact_name, phone/contact_phone ou email/contact_email' });
    }
    const tracking = {};
    // Captura TODOS os parâmetros utm_* (inclusive utm_id, utm_adset, utm_ad, utm_placement, utm_keyword,
    // etc.) + os campos de rastreamento conhecidos. Assim nada de UTM é descartado (ROI granular).
    const KNOWN_TRACK = ['gclid', 'fbclid', 'landing_page', 'referrer', 'msclkid', 'device_type', 'title', 'destination', 'dpi_local', 'dpi_session'];
    Object.keys(b).forEach(k => {
      if ((/^utm_/i.test(k) || KNOWN_TRACK.includes(k)) && b[k]) tracking[k] = String(b[k]).slice(0, 500);
    });
    tracking.channel = deriveChannel(tracking); // "Google Ads" / "Meta Ads" / "Orgânico" / <fonte>
    tracking.received_at = new Date().toISOString();
    // RESPOSTAS DO FORMULÁRIO (estruturadas p/ o bloco dedicado no Editar Lead): a mensagem do "seu
    // caso" e o destino de interesse. (O destino também já é capturado via KNOWN_TRACK 'destination'.)
    if (notes) tracking.form_mensagem = String(notes).slice(0, 2000);
    if (b.destination) tracking.form_destino = String(b.destination).slice(0, 120);
    const digits = String(phone || '').replace(/\D/g, '');
    let existing = null;
    if (digits.length >= 8) {
      existing = await getRow(
        "SELECT * FROM leads WHERE archived = 0 AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?",
        ['%' + digits.slice(-8) + '%']
      );
    }
    if (!existing && email) {
      existing = await getRow("SELECT * FROM leads WHERE archived = 0 AND LOWER(email) = ?", [String(email).toLowerCase()]);
    }
    if (existing) {
      // Lead JÁ existe: carimba o rastreamento. NÃO sobrescreve nome/telefone/comentários do lead.
      // Regra de origem: se o utm_source é Google Ads, classifica a origem como "Google Ads" também aqui.
      if (isGoogleAdsUtm(tracking)) {
        await runQuery("UPDATE leads SET tracking = ?, source = 'Google Ads' WHERE id = ?", [JSON.stringify(tracking), existing.id]);
      } else {
        await runQuery("UPDATE leads SET tracking = ? WHERE id = ?", [JSON.stringify(tracking), existing.id]);
      }
      const upd = await getRow("SELECT * FROM leads WHERE id = ?", [existing.id]);
      // RETORNO: o cliente voltou a conectar (remarketing ou outro canal) → registra o canal no histórico.
      await logCanal({ leadId: existing.id, phone: existing.phone || phone, name: existing.name, channel: tracking.channel, isReturn: true });
      sendWebhook('lead.updated', { ...upd, tags: upd.tags ? JSON.parse(upd.tags) : [], tracking });
      return res.json({ ok: true, action: 'tracking_stamped', leadId: existing.id });
    }
    const id = 'l_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString().slice(0, 10);
    const tags = service ? [String(service)] : [];
    // "notes" (mensagem do cliente) e "destination" vão para os comentários internos — só na CRIAÇÃO.
    let comments = String(notes || '').slice(0, 2000);
    if (b.destination) comments = (comments ? comments + '\n' : '') + 'Destino: ' + String(b.destination).slice(0, 120);
    // Regra de origem: utm_source = Google Ads → origem "Google Ads"; senão usa source/utm_source/title.
    const leadSource = isGoogleAdsUtm(tracking) ? 'Google Ads' : String(b.source || b.utm_source || b.title || 'Marketing').slice(0, 80);
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, priority, tracking, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, String(name || email || phone).slice(0, 200), String(company || '').slice(0, 200), String(phone || ''), String(email || ''), Number(b.value) || 0,
       'novo', leadSource, '', 'Marketing', JSON.stringify(tags), createdAt, 0, '', JSON.stringify(tracking), comments]
    );
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    // CHEGADA: primeiro contato deste lead — registra o canal de origem no histórico.
    await logCanal({ leadId: id, phone, name, channel: tracking.channel, isReturn: false });
    sendWebhook('lead.created', { ...lead, tags, tracking });
    res.json({ ok: true, action: 'created', leadId: id });
  } catch (e) {
    console.error('[integrations/lead]', e && e.message);
    res.status(500).json({ error: e.message });
  }
});

// Export completo (BI/planilhas): GET com a mesma API key
app.get('/api/integrations/leads', checkApiKey, async (req, res) => {
  try {
    const leads = await allRows("SELECT * FROM leads ORDER BY createdAt DESC");
    res.json(leads.map(l => ({
      ...l,
      tags: l.tags ? JSON.parse(l.tags) : [],
      tracking: l.tracking ? (function () { try { return JSON.parse(l.tracking); } catch (e) { return null; } })() : null
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reconciliação: leads parados em "Novo Leads" cuja conversa JÁ tem resposta nossa
// (fora a auto-resposta) migram para "Tratamento inicial". Cobre trocas feitas antes
// da regra existir e qualquer mensagem que tenha escapado do gatilho em tempo real.
// Dedup de leads "fantasma": arquiva (NÃO apaga — reversível) leads SEM telefone, SEM tag de serviço
// e SEM data de follow-up, quando existe OUTRO lead não-arquivado do MESMO nome QUE TEM telefone.
// É o caso do mesmo cliente registrado 2x (duas identidades @lid / duas linhas). Não toca em "Novo
// Leads" (a IA ainda está tratando), nem em estágios terminais. Se a pessoa voltar a escrever, o
// próprio handler de mensagem desarquiva o lead — então é seguro e autocorrigível.
async function archiveGhostDuplicates() {
  try {
    const ghosts = await allRows(
      "SELECT id, name FROM leads WHERE archived = 0 " +
      "AND (phone IS NULL OR TRIM(phone) = '') " +
      "AND (tags IS NULL OR tags = '' OR tags = '[]') " +
      "AND (followup_date IS NULL OR followup_date = '') " +
      "AND (contract_signed IS NULL OR contract_signed = 0) " +
      "AND stage NOT IN ('novo','convertida','declinado','clientes_antigos') " +
      "AND bridge IS NOT 1"
    );
    let archived = 0;
    for (const g of ghosts) {
      const nm = String(g.name || '').trim();
      if (!nm) continue;
      const real = await getRow(
        "SELECT id FROM leads WHERE archived = 0 AND id != ? AND LOWER(TRIM(name)) = LOWER(?) " +
        "AND phone IS NOT NULL AND LENGTH(REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','')) >= 8 LIMIT 1",
        [g.id, nm]
      );
      if (real) {
        await runQuery("UPDATE leads SET archived = 1 WHERE id = ?", [g.id]);
        archived++;
        console.log(`[dedup fantasma] arquivado "${g.name}" (${g.id}) — duplicata sem telefone de um lead real do mesmo nome.`);
      }
    }
    if (archived) console.log(`[dedup fantasma] total: ${archived} lead(s) fantasma arquivado(s).`);
  } catch (e) { console.error('[dedup fantasma]', e && e.message); }
}

// PONTUAL (uma única vez, guardado por flag): reconcilia duplicatas de MESMO TELEFONE (últimos 8 dígitos)
// entre leads ATIVOS. Mantém o card na etapa MAIS AVANÇADA (em empate, o de contato mais recente / com
// mais dados), migra para ele e-mail/rastreamento/recv_number que faltem, e ARQUIVA os demais (recuperável).
// PONTUAL: divide a antiga coluna pós "Vistos americanos" (visto_americano) em Primeiro Visto
// (visto_amer_primeiro) e Renovação (visto_amer_renov). Classifica os leads atuais pela tag (renov → Renovação).
async function splitVistoAmericanoOnce() {
  try {
    const FLAG = 'split_visto_amer_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const leads = await allRows("SELECT id, tags FROM leads WHERE pos_stage = 'visto_americano'");
    let prim = 0, ren = 0;
    for (const l of leads) {
      let isRenov = false;
      try { const tg = l.tags ? JSON.parse(l.tags) : []; const s = (Array.isArray(tg) ? tg.join(' ') : String(tg || '')).toLowerCase(); isRenov = /renov/.test(s); } catch (e) {}
      const target = isRenov ? 'visto_amer_renov' : 'visto_amer_primeiro';
      await runQuery("UPDATE leads SET pos_stage = ? WHERE id = ?", [target, l.id]);
      if (isRenov) ren++; else prim++;
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[split visto amer] ${prim} → Primeiro Visto, ${ren} → Renovação.`);
  } catch (e) { console.error('[split visto amer]', e && e.message); }
}

// PONTUAL: o pós passou a ter o "Grupo Visto Americano" com 3 raias (agendamento → validação → envio
// passaporte), substituindo as colunas antigas (Primeiro Visto / Renovação com-/sem- representação).
// Move todos os cards dessas colunas antigas p/ a 1ª raia 'visto_amer_agendamento'. Idempotente (flag).
async function migrateVistoAmerToGroupOnce() {
  try {
    const FLAG = 'visto_amer_group_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const r = await runQuery(
      "UPDATE leads SET pos_stage = 'visto_amer_semconta' " + // reforma 2026-07-02: 1ª coluna agora é "Sem conta"
      "WHERE pos_stage IN ('visto_americano', 'visto_amer_primeiro', 'visto_amer_renov', 'visto_amer_renov_sem')"
    );
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[visto amer grupo] ${(r && r.changes) || 0} card(s) movidos p/ Agendamento.`);
  } catch (e) { console.error('[visto amer grupo]', e && e.message); }
}

// PONTUAL (flag): re-carimba o tk.channel recomputado — agora lendo UTMs/gclid também de DENTRO do
// referrer/landing_page — e corrige source='Google Ads' nos leads detectados por utm_source/gclid.
// Conserta leads do Formulário de Contato que vinham como "Orgânico" por terem os UTMs só na URL.
async function restampChannelsFromReferrerOnce() {
  try {
    const FLAG = 'channel_referrer_restamp_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const leads = await allRows("SELECT id, source, tracking FROM leads WHERE tracking IS NOT NULL AND TRIM(tracking) <> ''");
    let chFix = 0, srcFix = 0;
    for (const l of leads) {
      let tk; try { tk = JSON.parse(l.tracking); } catch (e) { continue; }
      if (!tk || typeof tk !== 'object') continue;
      const ch = deriveChannel(tk);
      if (ch && tk.channel !== ch) {
        tk.channel = ch;
        await runQuery("UPDATE leads SET tracking = ? WHERE id = ?", [JSON.stringify(tk), l.id]);
        chFix++;
      }
      if (l.source !== 'Google Ads' && isGoogleAdsUtm(tk)) {
        await runQuery("UPDATE leads SET source = 'Google Ads' WHERE id = ?", [l.id]);
        srcFix++;
      }
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[restamp canal] channel recarimbado em ${chFix} lead(s); source→Google Ads em ${srcFix} lead(s).`);
  } catch (e) { console.error('[restamp canal]', e && e.message); }
}

async function reconcileDuplicatesByPhoneOnce() {
  try {
    const FLAG = 'dup_phone_reconcile_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const leads = await allRows("SELECT * FROM leads WHERE archived = 0 AND phone IS NOT NULL AND TRIM(phone) <> ''");
    const norm = (p) => String(p || '').replace(/\D/g, '');
    const groups = {};
    leads.forEach(l => { const d = norm(l.phone); if (d.length >= 8) { const k = d.slice(-8); (groups[k] = groups[k] || []).push(l); } });
    const RANK = { convertida: 6, clientes_antigos: 5, followup: 4, proposta: 3, tratamento: 2, novo: 1, declinado: 0 };
    let archived = 0, gruposCorrigidos = 0;
    for (const k of Object.keys(groups)) {
      const arr = groups[k];
      if (arr.length < 2) continue;
      arr.sort((a, b) => {
        const ra = (RANK[a.stage] != null ? RANK[a.stage] : 1), rb = (RANK[b.stage] != null ? RANK[b.stage] : 1);
        if (ra !== rb) return rb - ra;                                   // etapa mais avançada primeiro
        const ta = Number(a.last_client_ts) || 0, tb = Number(b.last_client_ts) || 0;
        if (ta !== tb) return tb - ta;                                   // contato do cliente mais recente
        const da = (a.email ? 1 : 0) + (a.tracking ? 1 : 0), db = (b.email ? 1 : 0) + (b.tracking ? 1 : 0);
        return db - da;                                                  // mais completo
      });
      const keep = arr[0];
      for (let i = 1; i < arr.length; i++) {
        const dupL = arr[i];
        // migra para o card mantido os dados úteis que faltarem nele.
        const sets = [], vals = [];
        if ((!keep.email || keep.email === '') && dupL.email) { sets.push('email = ?'); vals.push(dupL.email); keep.email = dupL.email; }
        if ((!keep.tracking || keep.tracking === '') && dupL.tracking) { sets.push('tracking = ?'); vals.push(dupL.tracking); keep.tracking = dupL.tracking; }
        if ((!keep.recv_number || keep.recv_number === '') && dupL.recv_number) { sets.push('recv_number = ?'); vals.push(dupL.recv_number); keep.recv_number = dupL.recv_number; }
        if (sets.length) { vals.push(keep.id); await runQuery("UPDATE leads SET " + sets.join(', ') + " WHERE id = ?", vals); }
        await runQuery("UPDATE leads SET archived = 1 WHERE id = ?", [dupL.id]);
        archived++;
        console.log(`[dedup telefone] arquivado "${dupL.name}" (${dupL.stage}) — duplicata de "${keep.name}" (${keep.stage}); telefone …${k}.`);
      }
      gruposCorrigidos++;
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[dedup telefone] concluído: ${archived} duplicata(s) arquivada(s) em ${gruposCorrigidos} grupo(s) de mesmo telefone.`);
  } catch (e) { console.error('[dedup telefone]', e && e.message); }
}

// RECORRENTE (boot + a cada 30 min): unifica num ÚNICO card todos os leads ATIVOS que tenham o MESMO
// número de WhatsApp. Chave robusta: últimos 8 dígitos do telefone; sem telefone, usa os dígitos do
// JID @s.whatsapp.net; senão, o JID @lid exato. Mantém o card na etapa MAIS avançada (empate: contato
// do cliente mais recente, depois o mais completo), CONSOLIDA nele os dados dos demais (pós-venda,
// comentários, valor, tags, contrato, comprovante, e-mail, rastreamento, etc.) e ARQUIVA as duplicatas
// (archived=1, reversível). Idempotente: depois de rodar, cada grupo fica com 1 card ativo → no-op.
// LIMITAÇÃO conhecida: um card só-@lid (sem telefone) não casa com a versão "número real" da mesma
// pessoa — esse caso é tratado pelo dedup-fantasma (mesmo nome, sem telefone).
async function unifyDuplicateWhatsappCards() {
  try {
    const leads = await allRows("SELECT * FROM leads WHERE archived = 0");
    const digits = (s) => String(s || '').replace(/\D/g, '');
    // Pré-passo: recupera o telefone REAL dos leads SEM telefone (ex.: cards @lid) a partir da CONVERSA
    // vinculada (mesmo whatsapp_jid). O @lid é um id de privacidade do WhatsApp e NÃO revela o número;
    // sem telefone esses cards não casam por número e nunca unificam. Com o número recuperado, a
    // unificação por número passa a funcionar — e mensagens futuras também casam pelo telefone.
    for (const l of leads) {
      if (digits(l.phone).length >= 8 || !l.whatsapp_jid) continue;
      try {
        const c = await getRow("SELECT phone FROM conversations WHERE whatsapp_jid = ? AND phone IS NOT NULL AND TRIM(phone) <> '' LIMIT 1", [l.whatsapp_jid]);
        if (c && digits(c.phone).length >= 8) { await runQuery("UPDATE leads SET phone = ? WHERE id = ?", [c.phone, l.id]); l.phone = c.phone; }
      } catch (e) {}
    }
    const waKey = (l) => {
      const pd = digits(l.phone);
      if (pd.length >= 8) return 'n:' + pd.slice(-8);
      const jid = String(l.whatsapp_jid || '');
      if (jid.endsWith('@s.whatsapp.net')) {
        const jd = digits(jid.split('@')[0]);
        if (jd.length >= 8) return 'n:' + jd.slice(-8);
      }
      return jid ? 'j:' + jid : null;
    };
    const groups = {};
    leads.forEach(l => { const k = waKey(l); if (k) (groups[k] = groups[k] || []).push(l); });
    const RANK = { convertida: 6, clientes_antigos: 5, followup: 4, proposta: 3, tratamento: 2, novo: 1, declinado: 0 };
    const rk = (s) => (RANK[s] != null ? RANK[s] : 1);
    const completeness = (l) => (l.email ? 1 : 0) + (l.tracking ? 1 : 0) + (l.pos_stage ? 1 : 0) + (Number(l.value) > 0 ? 1 : 0) + (Number(l.contract_signed) === 1 ? 1 : 0);
    const isPlaceholderName = (n) => { const s = String(n || '').trim(); return !s || /^(usu[aá]rio whatsapp|instagram( lead)?|lead)$/i.test(s); };
    const parseTags = (t) => { try { const x = JSON.parse(t || '[]'); return Array.isArray(x) ? x : []; } catch (e) { return []; } };
    const unionTags = (a, b) => {
      const out = [], seen = new Set();
      [...parseTags(a), ...parseTags(b)].forEach(t => { const key = String(t).toLowerCase().trim(); if (t && !seen.has(key)) { seen.add(key); out.push(t); } });
      return out;
    };
    // Colunas que podem ser consolidadas no card mantido (stage/priority/account NÃO mudam: são do vencedor).
    const COLS = ['name', 'company', 'email', 'phone', 'value', 'source', 'tags', 'comments', 'pos_stage',
      'bridge', 'contract_signed', 'signed_override', 'payment_proof', 'followup_date', 'decline_reason',
      'tracking', 'recv_number', 'whatsapp_jid', 'createdAt', 'last_client_ts', 'lastClientReply'];
    let archived = 0, gruposCorrigidos = 0;
    for (const k of Object.keys(groups)) {
      const arr = groups[k];
      if (arr.length < 2) continue;
      arr.sort((a, b) => {
        const ra = rk(a.stage), rb = rk(b.stage);
        if (ra !== rb) return rb - ra;                               // etapa mais avançada primeiro
        const ta = Number(a.last_client_ts) || 0, tb = Number(b.last_client_ts) || 0;
        if (ta !== tb) return tb - ta;                               // contato do cliente mais recente
        return completeness(b) - completeness(a);                    // mais completo
      });
      const keep = arr[0];
      const acc = Object.assign({}, keep);                           // cópia de trabalho p/ consolidar
      for (let i = 1; i < arr.length; i++) {
        const d = arr[i];
        const empty = (v) => v == null || v === '';
        if (isPlaceholderName(acc.name) && !isPlaceholderName(d.name)) acc.name = d.name;
        if (empty(acc.company) && !empty(d.company)) acc.company = d.company;
        if (empty(acc.email) && !empty(d.email)) acc.email = d.email;
        if (digits(acc.phone).length < 8 && digits(d.phone).length >= 8) acc.phone = d.phone;
        if ((empty(acc.value) || Number(acc.value) === 0) && Number(d.value) > 0) acc.value = d.value;
        if ((empty(acc.source) || acc.source === 'Venda') && !empty(d.source) && d.source !== 'Venda') acc.source = d.source;
        if (empty(acc.pos_stage) && !empty(d.pos_stage)) acc.pos_stage = d.pos_stage;
        if (empty(acc.payment_proof) && !empty(d.payment_proof)) acc.payment_proof = d.payment_proof;
        if (empty(acc.followup_date) && !empty(d.followup_date)) acc.followup_date = d.followup_date;
        if (empty(acc.decline_reason) && !empty(d.decline_reason)) acc.decline_reason = d.decline_reason;
        if (empty(acc.tracking) && !empty(d.tracking)) acc.tracking = d.tracking;
        if (empty(acc.recv_number) && !empty(d.recv_number)) acc.recv_number = d.recv_number;
        if (empty(acc.whatsapp_jid) && !empty(d.whatsapp_jid)) acc.whatsapp_jid = d.whatsapp_jid;
        if (Number(acc.contract_signed) !== 1 && Number(d.contract_signed) === 1) acc.contract_signed = 1;
        if (Number(acc.signed_override) !== 1 && Number(d.signed_override) === 1) acc.signed_override = 1;
        if (Number(acc.bridge) !== 1 && Number(d.bridge) === 1) acc.bridge = 1;
        if (!empty(d.createdAt) && (empty(acc.createdAt) || String(d.createdAt) < String(acc.createdAt))) acc.createdAt = d.createdAt;
        if ((Number(d.last_client_ts) || 0) > (Number(acc.last_client_ts) || 0)) acc.last_client_ts = d.last_client_ts;
        if (!empty(d.lastClientReply) && (empty(acc.lastClientReply) || String(d.lastClientReply) > String(acc.lastClientReply))) acc.lastClientReply = d.lastClientReply;
        acc.tags = JSON.stringify(unionTags(acc.tags, d.tags));
        const dc = String(d.comments || '').trim();
        if (dc && !String(acc.comments || '').includes(dc)) acc.comments = String(acc.comments || '').trim() ? (String(acc.comments).trim() + '\n' + dc) : dc;
        await runQuery("UPDATE leads SET archived = 1 WHERE id = ?", [d.id]);
        archived++;
        console.log(`[unifica whatsapp] arquivado "${d.name}" (${d.stage}) — duplicata de "${keep.name}" (${keep.stage}); chave ${k}.`);
      }
      const sets = [], vals = [];
      for (const c of COLS) { if (acc[c] !== keep[c]) { sets.push(c + ' = ?'); vals.push(acc[c]); } }
      if (sets.length) { vals.push(keep.id); await runQuery("UPDATE leads SET " + sets.join(', ') + " WHERE id = ?", vals); }
      gruposCorrigidos++;
    }
    // Só derruba o micro-cache se algo REALMENTE mudou (evita limpar o cache a cada 30min à toa
    // quando não há duplicata nova — a função roda em sweep periódico, não só sob demanda).
    if (archived || gruposCorrigidos) bustLeadsCache();
    if (archived) console.log(`[unifica whatsapp] concluído: ${archived} card(s) unificado(s) em ${gruposCorrigidos} grupo(s) de mesmo número.`);
  } catch (e) { console.error('[unifica whatsapp]', e && e.message); }
}

// PONTUAL (uma única vez, guardado por flag): arquiva leads SEM IDENTIFICAÇÃO — sem telefone (≥8 díg.),
// sem e-mail e com NOME só de símbolo/emoji/em branco (ex.: "✨", "☾", ".", "ㅤ"). São contatos @lid em
// modo privado / spam que não dá pra trabalhar. Recuperável (archived=1) e auto-restaurado se a pessoa
// voltar a mandar mensagem. Não toca em Venda convertida / Clientes antigos nem em contratos assinados.
async function archiveJunkUnidentifiedOnce() {
  try {
    const FLAG = 'junk_unidentified_archive_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const leads = await allRows("SELECT id, name, phone, email, stage, value, contract_signed FROM leads WHERE archived = 0 AND bridge IS NOT 1 AND stage NOT IN ('convertida','clientes_antigos')");
    const temLetraOuNumero = (s) => /[\p{L}\p{N}]/u.test(String(s || ''));
    let archived = 0;
    for (const l of leads) {
      const ph = String(l.phone || '').replace(/\D/g, '');
      if (ph.length >= 8) continue;             // tem telefone usável
      if (String(l.email || '').trim()) continue; // tem e-mail
      if (Number(l.value) > 0) continue;          // tem valor → não é lixo
      if (l.contract_signed === 1) continue;      // contrato assinado → não é lixo
      if (temLetraOuNumero(l.name)) continue;     // nome tem letra/número → NÃO arquiva
      await runQuery("UPDATE leads SET archived = 1 WHERE id = ?", [l.id]);
      archived++;
      console.log(`[limpeza lixo] arquivado lead sem identificação: nome="${l.name}" (${l.id}, ${l.stage}).`);
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[limpeza lixo] concluído: ${archived} lead(s) sem identificação arquivado(s).`);
  } catch (e) { console.error('[limpeza lixo]', e && e.message); }
}

// PONTUAL (uma única vez, guardado por flag): corrige o BACKLOG de leads que entraram pelo site/anúncios
// SEM "nosso número" (recv_number vazio) — atribui a linha (12) 99227-1554 (wa2), como se o site já
// tivesse direcionado o cliente para esse WhatsApp. Define recv_number e a linha de atendimento (account).
async function backfillRecvNumberWa2Once() {
  try {
    const FLAG = 'recv_backfill_wa2_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const TARGET_NUM = '+5512992271554';   // (12) 99227-1554
    const TARGET_ACC = 'wa2';
    const leads = await allRows("SELECT id FROM leads WHERE archived = 0 AND (recv_number IS NULL OR TRIM(recv_number) = '')");
    let n = 0;
    for (const l of leads) {
      await runQuery("UPDATE leads SET recv_number = ?, account = ? WHERE id = ? AND (recv_number IS NULL OR TRIM(recv_number) = '')", [TARGET_NUM, TARGET_ACC, l.id]);
      n++;
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[backfill recv wa2] ${n} lead(s) sem nosso número atribuídos à linha (12) 99227-1554 (wa2).`);
  } catch (e) { console.error('[backfill recv wa2]', e && e.message); }
}

// PONTUAL: o número PÓS-VENDA (11) 96502-2030 (wa5) NÃO pode aparecer nos cards. Migra todo lead que
// mostra esse número (recv_number) ou está na linha wa5 para a linha PRÉ-venda wa2 (12) 99227-1554,
// e leva as conversas da wa5 para a wa2. Roda uma vez (flag). Reexecuta com nova flag se preciso.
// DESATIVADO: esta rotina MASCARAVA o número 2030 trocando-o pelo da wa2 — isso estava ERRADO.
// NUNCA relabelar uma linha por outra. O 2030 é apenas OCULTADO por filtro nas telas (o número
// real é sempre preservado). Mantida como no-op para não voltar a mascarar.
async function migrateWa5ToWa2Once() { /* no-op: jamais mascarar uma linha com outra. */ }

// RESTAURA os leads que eram REALMENTE do 2030 (wa5) e foram mascarados como wa2 pela migração antiga.
// Identificados pelo BACKUP do banco de ANTES do erro (cópia 22/06 13:00) — por ID estável + jid,
// então pega até os que estão sem telefone no campo. Reaplica a cada boot (idempotente).
const POS_2030_LEAD_IDS = ['l_0oolx4j5i', 'l_j2phc2gq9', 'l_4wov4e9wk', 'l_hccyr1sjp', 'l_abizx6h5b', 'l_443c3susk', 'l_o3sgrg1jc', 'l_xf67s33ki', 'l_f25zgyslb'];
const POS_2030_JIDS = ['214967575937091@lid', '199763341390002@lid', '84082692194496@lid', '237855506977000@lid', '223342611190012@lid', '75879388561658@lid', '119589102997711@lid', '167491007471765@lid', '119443191517381@lid'];
async function restore2030Leads() {
  try {
    const NUM = '+5511965022030', ACC = 'wa5';
    if (POS_2030_LEAD_IDS.length) {
      const ph = POS_2030_LEAD_IDS.map(() => '?').join(',');
      await runQuery("UPDATE leads SET recv_number = ?, account = ? WHERE id IN (" + ph + ")", [NUM, ACC, ...POS_2030_LEAD_IDS]);
    }
    if (POS_2030_JIDS.length) {
      const ph = POS_2030_JIDS.map(() => '?').join(',');
      await runQuery("UPDATE conversations SET account = ? WHERE whatsapp_jid IN (" + ph + ")", [ACC, ...POS_2030_JIDS]);
    }
    console.log(`[restaura 2030] ${POS_2030_LEAD_IDS.length} lead(s) restaurados à linha real (11... 96502-2030 / wa5).`);
  } catch (e) { console.error('[restaura 2030]', e && e.message); }
}

// HISTÓRICO: classifica como "Meta Ads" os leads cujo cliente enviou uma das mensagens-padrão de
// anúncio do Meta (click-to-WhatsApp). Roda uma vez (flag); as novas são classificadas no handler.
async function backfillMetaChannelOnce() {
  try {
    const FLAG = 'meta_channel_backfill_v2';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const rows = await allRows(
      "SELECT DISTINCT conversationId AS cid FROM messages WHERE `from`='them' AND (" +
      "text LIKE '%quero informa%es sobre primeiro visto ou renova%' OR " +
      "text LIKE '%oferta de renova%o de visto%' OR " +
      "text LIKE '%como tirar o primeiro visto%' OR " +
      "text LIKE '%informa%es sobre a renova%o de visto%' OR " +
      "text LIKE '%vim do site e gostaria de saber mais sobre os servi%os de visto americano%')"
    );
    let n = 0;
    for (const r of rows) {
      const conv = await getRow("SELECT whatsapp_jid, phone FROM conversations WHERE id = ?", [r.cid]);
      if (!conv) continue;
      const tail = String(conv.phone || '').replace(/\D/g, '').slice(-8);
      let lead = null;
      if (conv.whatsapp_jid) lead = await getRow("SELECT id, tracking FROM leads WHERE whatsapp_jid = ? LIMIT 1", [conv.whatsapp_jid]);
      if (!lead && tail.length >= 8) lead = await getRow("SELECT id, tracking FROM leads WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + tail]);
      if (!lead) continue;
      let tk = {}; try { tk = lead.tracking ? JSON.parse(lead.tracking) : {}; } catch (e) { tk = {}; }
      if (tk.channel === 'Meta Ads') continue;
      tk.channel = 'Meta Ads';
      await runQuery("UPDATE leads SET tracking = ? WHERE id = ?", [JSON.stringify(tk), lead.id]);
      n++;
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[meta backfill] ${n} lead(s) classificados como Meta Ads pelo histórico de mensagens.`);
  } catch (e) { console.error('[meta backfill]', e && e.message); }
}

// PONTUAL (uma única vez, guardado por flag): SIMULA a chegada pelo site para o BACKLOG.
// Para cada lead ABERTO, com telefone e SEM conversa, move para "Novo Leads", cria a conversa na
// linha (12) 99227-1554 (wa2) e injeta a SAUDAÇÃO do site como mensagem do CLIENTE (inbound). Isso
// deixa o lead "aguardando" em Novos Leads — a IA (que já responde Novos Leads) então o atende.
// O ENVIO real é feito pela rotina backlogKickoffSweep, em LOTES pequenos e espaçados (anti-ban).
async function setupBacklogKickoffOnce() {
  try {
    const FLAG = 'backlog_kickoff_setup_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return;
    const GREET = 'Olá, vim do site e gostaria de informações sobre vistos/imigração.';
    const digits = (s) => String(s || '').replace(/\D/g, '');
    const leads = await allRows(
      "SELECT * FROM leads WHERE archived = 0 AND bridge IS NOT 1 AND stage NOT IN ('convertida','declinado','clientes_antigos') " +
      "AND phone IS NOT NULL AND TRIM(phone) <> '' ORDER BY createdAt ASC"
    );
    let n = 0;
    for (const l of leads) {
      const dig = digits(l.phone);
      if (dig.length < 8) continue;                 // sem telefone usável
      const last8 = dig.slice(-8);
      // já tem conversa? então NÃO é backlog "sem whatsapp" → pula
      let convo = null;
      if (l.whatsapp_jid) convo = await getRow("SELECT id FROM conversations WHERE whatsapp_jid = ? LIMIT 1", [l.whatsapp_jid]);
      if (!convo) convo = await getRow("SELECT id FROM conversations WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + last8]);
      if (convo) continue;
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
      const nm = l.name || dig;
      const av = String(nm).slice(0, 2).toUpperCase();
      const convoId = 'c_' + Math.random().toString(36).substr(2, 9);
      await runQuery(
        "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, whatsapp_jid, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [convoId, 'wa2', nm, String(l.phone || ''), av, timeStr, 1, 0, l.whatsapp_jid || null, 0]
      );
      const mid = 'm_' + Math.random().toString(36).substr(2, 9);
      await runQuery(
        "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, 'them', ?, ?, ?, 'text', NULL)",
        [mid, convoId, GREET, timeStr, Date.now()]
      );
      await runQuery(
        "UPDATE leads SET stage = 'novo', account = 'wa2', recv_number = '+5512992271554', lastClientReply = ?, last_client_ts = ? WHERE id = ?",
        [new Date().toISOString(), Date.now(), l.id]
      );
      n++;
    }
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    // Liga a "campanha" de disparo pausado. Para PARAR: setar este valor para '0'.
    await runQuery("INSERT INTO app_settings (key, value) VALUES ('backlog_kickoff_active', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    console.log(`[backlog kickoff] ${n} lead(s) preparados em Novos Leads (saudação do site injetada). A IA vai responder em lotes pequenos.`);
  } catch (e) { console.error('[backlog kickoff setup]', e && e.message); }
}

// Disparo PAUSADO: enquanto a flag 'backlog_kickoff_active' = '1', a cada rodada a IA responde
// um LOTE pequeno de Novos Leads aguardando (anti-ban). Reaproveita processNovoBacklog (testado).
let _kickoffRunning = false;
async function backlogKickoffSweep() {
  if (_kickoffRunning) return;
  _kickoffRunning = true;
  try {
    const camp = await getRow("SELECT value FROM app_settings WHERE key = 'backlog_kickoff_active'");
    if (!camp || String(camp.value) !== '1') return;
    const r = await processNovoBacklog(4); // lote pequeno
    if (r && r.ok === false) console.log('[backlog kickoff]', r.reason);
    else if (r) console.log(`[backlog kickoff] lote enviado: ${r.respondidos || 0} | restantes a verificar na próxima rodada.`);
  } catch (e) { console.error('[backlog kickoff sweep]', e && e.message); }
  finally { _kickoffRunning = false; }
}
setTimeout(() => { backlogKickoffSweep().catch(() => {}); }, 4 * 60 * 1000);   // 1ª passada ~4min após subir
setInterval(() => { backlogKickoffSweep().catch(() => {}); }, 18 * 60 * 1000); // depois, a cada 18min

// PONTUAL (uma única vez, guardado por flag em app_settings): aplica a tag de serviço padrão
// "A01 - 1 visto amer B1B2" a TODOS os leads ativos que estão SEM tag de serviço. Pedido pontual
// do Henry em 2026-06-19. NÃO se repete — mesmo em deploys/restarts futuros (flag svc_tag_backfill_v1).
async function backfillServiceTagOnce() {
  try {
    const FLAG = 'svc_tag_backfill_v1';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return; // já executou — não repete
    const TAG = 'A01 - 1 visto amer B1B2';
    const rows = await allRows("SELECT id, tags FROM leads WHERE archived = 0");
    let n = 0;
    for (const r of rows) {
      let t = [];
      try { t = r.tags ? JSON.parse(r.tags) : []; } catch (e) { t = []; }
      const hasSvc = Array.isArray(t) && t.length && String(t[0] || '').trim() !== '';
      if (hasSvc) continue;
      await runQuery("UPDATE leads SET tags = ? WHERE id = ?", [JSON.stringify([TAG]), r.id]);
      n++;
    }
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [FLAG, new Date().toISOString()]
    );
    console.log(`[backfill tag serviço] aplicada "${TAG}" a ${n} lead(s) sem tag. Flag ${FLAG} marcada — não repete.`);
  } catch (e) { console.error('[backfill tag serviço]', e && e.message); }
}

// PONTUAL (uma única vez, guardado por flag em app_settings): adiciona a tag "comentário Meta" aos
// leads do Instagram (whatsapp_jid LIKE 'ig:%') cuja conversa de origem tenha ao menos 1 mensagem de
// comentário (id LIKE 'cmt_%') — mesmo critério usado na criação de leads novos (from-conversation).
// Idempotente: só adiciona quem ainda não tem a tag. Agendada ~20s após o boot p/ não competir com a
// inicialização (flag meta_comment_tag_backfill_done impede repetir em deploys/restarts futuros).
async function backfillMetaCommentTagOnce() {
  try {
    const FLAG = 'meta_comment_tag_backfill_done';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return; // já executou — não repete
    const TAG = 'comentário Meta';
    const rows = await allRows("SELECT id, tags, whatsapp_jid FROM leads WHERE whatsapp_jid LIKE 'ig:%'");
    let n = 0;
    for (const r of rows) {
      const convo = await getRow("SELECT id FROM conversations WHERE whatsapp_jid = ?", [r.whatsapp_jid]);
      if (!convo) continue;
      const cmtMsg = await getRow("SELECT id FROM messages WHERE conversationId = ? AND id LIKE 'cmt_%' LIMIT 1", [convo.id]);
      if (!cmtMsg) continue;
      let t = [];
      try { t = r.tags ? JSON.parse(r.tags) : []; } catch (e) { t = []; }
      if (!Array.isArray(t)) t = [];
      if (t.includes(TAG)) continue;
      t.push(TAG);
      await runQuery("UPDATE leads SET tags = ? WHERE id = ?", [JSON.stringify(t), r.id]);
      n++;
    }
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [FLAG, new Date().toISOString()]
    );
    console.log(`[backfill tag comentário Meta] aplicada "${TAG}" a ${n} lead(s) de comentário. Flag ${FLAG} marcada — não repete.`);
  } catch (e) { console.error('[backfill tag comentário Meta]', e && e.message); }
}

// PONTUAL (uma única vez, guardado por flag em app_settings): garante que TODO lead do Instagram
// (whatsapp_jid LIKE 'ig:%') fique com uma das duas tags "Meta" — "comentário Meta" (nasceu de
// comentário) ou "Meta" (Direct puro, sem comentário vinculado). Idempotente: pula quem já tem
// qualquer uma das duas tags (inclusive os que o backfill v1 (comentário) já marcou). Agendada
// ~25s após o boot, logo após backfillMetaCommentTagOnce (flag meta_direct_tag_backfill_done
// impede repetir em deploys/restarts futuros).
async function backfillMetaDirectTagOnce() {
  try {
    const FLAG = 'meta_direct_tag_backfill_done';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return; // já executou — não repete
    const TAG_COMMENT = 'comentário Meta';
    const TAG_DIRECT = 'Meta';
    const rows = await allRows("SELECT id, tags, whatsapp_jid FROM leads WHERE whatsapp_jid LIKE 'ig:%'");
    let n = 0;
    for (const r of rows) {
      let t = [];
      try { t = r.tags ? JSON.parse(r.tags) : []; } catch (e) { t = []; }
      if (!Array.isArray(t)) t = [];
      if (t.includes(TAG_DIRECT) || t.includes(TAG_COMMENT)) continue;
      const convo = await getRow("SELECT id FROM conversations WHERE whatsapp_jid = ?", [r.whatsapp_jid]);
      const cmtMsg = convo ? await getRow("SELECT id FROM messages WHERE conversationId = ? AND id LIKE 'cmt_%' LIMIT 1", [convo.id]) : null;
      if (cmtMsg) t.push(TAG_COMMENT); else t.push(TAG_DIRECT);
      await runQuery("UPDATE leads SET tags = ? WHERE id = ?", [JSON.stringify(t), r.id]);
      n++;
    }
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [FLAG, new Date().toISOString()]
    );
    console.log(`[backfill tag Meta Direct] aplicada tag a ${n} lead(s) do Instagram sem tag Meta. Flag ${FLAG} marcada — não repete.`);
  } catch (e) { console.error('[backfill tag Meta Direct]', e && e.message); }
}

// Define wa5 e wa6 como PÓS-VENDA por padrão (são celulares de pós-venda). Faz MERGE: só preenche o
// tipo quando ainda não houver um definido para a linha — não sobrescreve o que o Henry já configurou.
// PONTUAL (uma única vez, guardado por flag em app_settings): fecha o atendimento dos leads que JÁ
// estavam em "Lead declinou/cancelado" ANTES da regra do passo 1 (fechamento automático ao ENTRAR
// nessa coluna, PATCH /:id/stage ~L899) existir. Mesmo efeito do botão "Encerrar atendimento"
// (~L2327): service_closed=1, limpa lastClientReply e ARQUIVA a conversa do WhatsApp (findConvoForLead
// — mesmo matching usado nos dois pontos acima). Idempotente: só afeta leads com stage='declinado' e
// service_closed <> 1 (flag declinado_close_backfill_done impede repetir em deploys/restarts futuros).
// Agendada ~30s após o boot, logo após os backfills de tag Meta.
async function backfillDeclinadoCloseOnce() {
  try {
    const FLAG = 'declinado_close_backfill_done';
    const done = await getRow("SELECT value FROM app_settings WHERE key = ?", [FLAG]);
    if (done && done.value) return; // já executou — não repete
    const rows = await allRows("SELECT * FROM leads WHERE stage = 'declinado' AND (service_closed IS NULL OR service_closed <> 1)");
    let n = 0;
    for (const r of rows) {
      try {
        await runQuery("UPDATE leads SET service_closed = 1, lastClientReply = NULL WHERE id = ?", [r.id]);
        const convo = await findConvoForLead(r);
        if (convo) await runQuery("UPDATE conversations SET archived = 1, unread = 0 WHERE id = ?", [convo.id]);
        n++;
      } catch (e) {}
    }
    await runQuery(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [FLAG, new Date().toISOString()]
    );
    console.log(`[backfill fechamento declinado] fechado(s) e arquivada(s) a conversa de ${n} lead(s) já em "Lead declinou/cancelado". Flag ${FLAG} marcada — não repete.`);
  } catch (e) { console.error('[backfill fechamento declinado]', e && e.message); }
}

async function ensurePosVendaDefaults() {
  try {
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'wa_sale_types'");
    let m = {}; try { m = row && row.value ? JSON.parse(row.value) : {}; } catch (e) { m = {}; }
    let changed = false;
    if (!m.wa5) { m.wa5 = 'pos'; changed = true; }
    if (!m.wa6) { m.wa6 = 'pos'; changed = true; }
    if (changed) {
      await runQuery("INSERT INTO app_settings (key, value) VALUES ('wa_sale_types', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(m)]);
      console.log('[wa pós-venda] wa5/wa6 definidos como pós-venda por padrão.');
    }
  } catch (e) { console.error('[wa pós-venda default]', e && e.message); }
}

async function reconcileNovoLeads() {
  try {
    let autoMsg = null;
    try {
      const bhRow = await getRow("SELECT value FROM app_settings WHERE key = 'business_hours'");
      const bh = bhRow && bhRow.value ? JSON.parse(bhRow.value) : null;
      if (bh && bh.message) autoMsg = String(bh.message).trim();
    } catch (e) {}
    const novos = await allRows("SELECT id, name, phone, whatsapp_jid FROM leads WHERE stage = 'novo' AND archived = 0");
    if (!novos.length) return;
    const convs = await allRows("SELECT id, phone, whatsapp_jid FROM conversations");
    const norm = (p) => String(p || '').replace(/\D/g, '');
    let moved = 0;
    for (const l of novos) {
      const lt = norm(l.phone).slice(-8);
      const conv = convs.find(c =>
        (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
        (lt.length === 8 && norm(c.phone).slice(-8) === lt)
      );
      if (!conv) continue;
      const mine = await allRows("SELECT id, text, ai FROM messages WHERE conversationId = ? AND `from` = 'me'", [conv.id]);
      const respondeu = mine.some(m => {
        const txt = String((m && m.text) || '').trim();
        const mid = String((m && m.id) || '');
        if (m && (m.ai === 1 || m.ai === '1')) return false; // mensagem da IA NÃO conta (ela ainda está perguntando o serviço)
        if (autoMsg && txt === autoMsg) return false; // auto-resposta fora de horário
        if (mid.startsWith('m_')) return false;       // ID interno = auto-reply ou IA
        if (txt.startsWith('{')) return false;         // JSON bruto enviado por erro da IA
        return true;                                   // resposta humana real
      });
      if (respondeu) {
        await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'followup' WHERE id = ? AND stage = 'novo'", [l.id]);
        moved++;
        console.log(`[reconcileNovoLeads] "${l.name}" movido para Tratamento inicial (tag Follow-up aplicada).`);
      }
    }
    if (moved) console.log(`[reconcileNovoLeads] total: ${moved} lead(s) movidos.`);
  } catch (e) { console.error('[reconcileNovoLeads]', e && e.message); }
}

app.listen(PORT, async () => {
  console.log(`CRM WhatsApp Backend Server running on http://localhost:${PORT}`);
  // Autostart active sessions
  try {
    await initSessions();
  } catch (err) {
    console.error("Error initializing sessions:", err);
  }
  // Limpa pontos de tempo antigos onde nós já fomos os últimos a responder
  try {
    await reconcileReplyDots();
  } catch (err) {
    console.error("Error reconciling reply dots:", err);
  }
  // Novo Leads já respondidos → Tratamento inicial (no boot e a cada 15 min)
  try {
    await reconcileNovoLeads();
  } catch (err) {
    console.error("Error reconciling novo leads:", err);
  }
  setInterval(() => { reconcileNovoLeads().catch(() => {}); }, 15 * 60 * 1000);
  // Achado 1.5: contratos/e-mails assinados (dashboard) — varredura IMAP agora é job de fundo,
  // escalonado p/ não bater os dois no IMAP ao mesmo tempo (contratos +30s, e-mails +90s do boot),
  // recorrente a cada 10 min. As rotas GET só leem o cache (ver refreshSignedContracts/refreshSignedEmails).
  setTimeout(() => { refreshSignedContracts().catch(() => {}); }, 30 * 1000);
  setInterval(() => { refreshSignedContracts().catch(() => {}); }, 10 * 60 * 1000);
  setTimeout(() => { refreshSignedEmails().catch(() => {}); }, 90 * 1000);
  setInterval(() => { refreshSignedEmails().catch(() => {}); }, 10 * 60 * 1000);
  // Dedup de leads fantasma (duplicatas sem telefone do mesmo nome) — no boot e a cada 30 min.
  try { await archiveGhostDuplicates(); } catch (e) { console.error('[dedup fantasma boot]', e && e.message); }
  setInterval(() => { archiveGhostDuplicates().catch(() => {}); }, 30 * 60 * 1000);
  // PONTUAL: aplica a tag de serviço padrão aos leads sem tag (uma única vez; flag impede repetir).
  try { await backfillServiceTagOnce(); } catch (e) { console.error('[backfill tag serviço boot]', e && e.message); }
  // PONTUAL: tag "comentário Meta" nos leads de Instagram nascidos de comentário (uma única vez;
  // ~20s após o boot p/ não competir com a inicialização; flag impede repetir).
  setTimeout(() => { backfillMetaCommentTagOnce().catch(() => {}); }, 20 * 1000);
  // PONTUAL: garante tag "Meta" (Direct) ou "comentário Meta" a TODO lead do Instagram sem
  // nenhuma das duas (uma única vez; ~25s após o boot, logo após o backfill de comentário; flag
  // impede repetir).
  setTimeout(() => { backfillMetaDirectTagOnce().catch(() => {}); }, 25 * 1000);
  // PONTUAL: fecha o atendimento (service_closed=1) e arquiva a conversa dos leads que JÁ estavam em
  // "Lead declinou/cancelado" antes do fechamento automático do passo 1 existir (uma única vez; ~30s
  // após o boot, logo após os backfills de tag Meta; flag impede repetir).
  setTimeout(() => { backfillDeclinadoCloseOnce().catch(() => {}); }, 30 * 1000);
  // wa5/wa6 = pós-venda por padrão (não sobrescreve configuração existente).
  try { await ensurePosVendaDefaults(); } catch (e) { console.error('[wa pós-venda boot]', e && e.message); }
  // PONTUAL: reconcilia duplicatas JÁ existentes de mesmo telefone (arquiva, mantendo a etapa mais avançada).
  try { await reconcileDuplicatesByPhoneOnce(); } catch (e) { console.error('[dedup telefone boot]', e && e.message); }
  // RECORRENTE: unifica num único card todos os leads do MESMO número de WhatsApp (arquiva duplicatas,
  // consolida os dados no card da etapa mais avançada) — no boot e a cada 30 min. Supera o dedup pontual
  // acima: pega também leads sem telefone (via JID) e duplicatas que surgirem no futuro.
  try { await unifyDuplicateWhatsappCards(); } catch (e) { console.error('[unifica whatsapp boot]', e && e.message); }
  setInterval(() => { unifyDuplicateWhatsappCards().catch(() => {}); }, 30 * 60 * 1000);
  // PONTUAL: re-carimba canal (lendo UTMs do referrer) e corrige source dos leads detectados como Google Ads.
  try { await restampChannelsFromReferrerOnce(); } catch (e) { console.error('[restamp canal boot]', e && e.message); }
  // PONTUAL: arquiva leads sem identificação (sem telefone/e-mail, nome só de símbolo/emoji/branco).
  try { await archiveJunkUnidentifiedOnce(); } catch (e) { console.error('[limpeza lixo boot]', e && e.message); }
  // PONTUAL: backlog de leads sem "nosso número" → atribui a linha (12) 99227-1554 (wa2).
  try { await backfillRecvNumberWa2Once(); } catch (e) { console.error('[backfill recv wa2 boot]', e && e.message); }
  // (migrateWa5ToWa2Once virou no-op: nunca mais mascarar.)
  // Restaura a linha REAL (2030/wa5) dos leads que foram mascarados — lista informada pelo Henry.
  try { await restore2030Leads(); } catch (e) { console.error('[restaura 2030 boot]', e && e.message); }
  // PONTUAL: classifica como Meta Ads os leads do histórico que mandaram a mensagem-padrão do Meta.
  try { await backfillMetaChannelOnce(); } catch (e) { console.error('[meta backfill boot]', e && e.message); }
  // PONTUAL: divide a coluna pós "Vistos americanos" em Primeiro Visto / Renovação (separa os atuais por tag).
  try { await splitVistoAmericanoOnce(); } catch (e) { console.error('[split visto amer boot]', e && e.message); }
  // Migra as colunas americanas antigas p/ o novo "Grupo Visto Americano" (raia Agendamento).
  try { await migrateVistoAmerToGroupOnce(); } catch (e) { console.error('[visto amer grupo boot]', e && e.message); }
  // PONTUAL: simula a chegada pelo site (saudação injetada) p/ o backlog → a IA inicia o atendimento.
  try { await setupBacklogKickoffOnce(); } catch (e) { console.error('[backlog kickoff boot]', e && e.message); }
  // Correção: limpa "contrato assinado" gravado por engano pela regra antiga de nome único.
  // Critério SEGURO: só desmarca quem tem nome de UM token e NÃO tem e-mail — esses só podem
  // ter sido marcados pela regra frouxa (não dá pra ter casado por e-mail nem por 2 tokens).
  try {
    const STOP_S = { msn:1, sr:1, sra:1, dr:1, dra:1, snr:1, cliente:1, contrato:1, assinado:1, de:1, da:1, do:1, dos:1, das:1, e:1 };
    const toksS = (s) => String(s == null ? '' : s)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
      .split(' ').filter(t => t.length >= 3 && !STOP_S[t]);
    const signedLeads = await allRows("SELECT id, name, email FROM leads WHERE contract_signed = 1 AND (email IS NULL OR email = '')");
    let cleared = 0;
    for (const l of (signedLeads || [])) {
      if (toksS(l.name).length <= 1) {
        await runQuery("UPDATE leads SET contract_signed = 0 WHERE id = ?", [l.id]);
        cleared++;
        console.log(`[corrige assinado] desmarcado falso positivo: "${l.name}" (id ${l.id})`);
      }
    }
    if (cleared) console.log(`[corrige assinado] ${cleared} flag(s) de "assinado" corrigido(s).`);
  } catch (e) { console.error('[corrige assinado]', e && e.message); }
  // Correção da bolinha (WhatsApp Web): zera o "não lidas" das conversas em que NÓS respondemos
  // por último — alinha o histórico com a regra nova (daqui pra frente o reset é automático).
  try {
    await runQuery(
      "UPDATE conversations SET unread = 0 WHERE unread > 0 AND id IN (" +
      "SELECT m.conversationId FROM messages m " +
      "JOIN (SELECT conversationId, MAX(timestamp) AS mx FROM messages GROUP BY conversationId) t " +
      "ON t.conversationId = m.conversationId AND t.mx = m.timestamp " +
      "WHERE m.\`from\` = 'me')"
    );
    console.log('[corrige bolinha] zeradas as conversas respondidas por último.');
  } catch (e) { console.error('[corrige bolinha]', e && e.message); }
  // IA: follow-up das colunas 2-3 do Tratamento inicial (a cada 30 min; 1ª passada após 2 min)
  setTimeout(() => { aiFollowUpSweep().catch(() => {}); }, 2 * 60 * 1000);
  setInterval(() => { aiFollowUpSweep().catch(() => {}); }, 30 * 60 * 1000);
  // Regra 1.3b: auto-declínio dos que não responderam após os follow-ups (boot + a cada 30 min).
  setTimeout(() => { autoDeclineExhaustedFollowups().catch(() => {}); }, 3 * 60 * 1000);
  setInterval(() => { autoDeclineExhaustedFollowups().catch(() => {}); }, 30 * 60 * 1000);
  // Calendly: reunião de validação agendada pelo cliente → data no card (boot + a cada 5 min).
  setTimeout(() => { calendlySweep(logLeadHistory).catch((e) => console.error('[Calendly]', e.message)); }, 90 * 1000);
  setInterval(() => { calendlySweep(logLeadHistory).catch((e) => console.error('[Calendly]', e.message)); }, 5 * 60 * 1000);
});
