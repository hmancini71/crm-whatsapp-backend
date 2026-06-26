// Fuso horário OBRIGATÓRIO do Brasil (GMT-3) para TODO o backend — antes de qualquer uso de Date.
// Assim, toda hora/data gerada no servidor (horas das mensagens, logs, agregações) fica em Brasília,
// independentemente do fuso do servidor (Hetzner costuma ser UTC).
process.env.TZ = 'America/Sao_Paulo';

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { runQuery, getRow, allRows } = require('./db');
const { getIntegrationSettings, saveIntegrationSettings, newApiKey, sendWebhook } = require('./webhook');
const { getAiSettings, saveAiSettings, callGemini, getFollowUpReply } = require('./ai');
const {
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  processNovoBacklog,
  initSessions,
  sessionQrs,
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
app.use(bodyParser.json({ limit: '30mb' }));

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

// Log requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
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
  const { email, password } = req.body;
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

    const tokenPayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatar: user.avatar
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
  let wa_type = 'ambos';
  try { const u = await getRow("SELECT wa_type FROM users WHERE id = ?", [req.user.sub]); if (u && u.wa_type) wa_type = u.wa_type; } catch (e) {}
  res.json({
    id: req.user.sub,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    avatar: req.user.avatar,
    wa_type
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

app.get('/api/users', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const users = await allRows("SELECT id, name, email, role, avatar, wa_type FROM users ORDER BY name");
    res.json(users);
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
  const { name, role, password, wa_type } = req.body;
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
    // Ordena por prioridade (followup no topo, depois urgente/vermelho, depois média/amarelo, depois sem), e por data.
    const leads = await allRows("SELECT * FROM leads WHERE archived = 0 ORDER BY CASE priority WHEN 'followup' THEN 1 WHEN 'urgente' THEN 2 WHEN 'media' THEN 3 ELSE 4 END, createdAt DESC");
    let parsedLeads = leads.map(l => ({
      ...l,
      tags: l.tags ? JSON.parse(l.tags) : []
    }));
    // Filtra por LOGIN (sem mascarar, sempre o número real):
    //  - PÓS (Alexandre): só leads do 2030 OU vendas convertidas; 'stage' é remapeado p/ pos_stage
    //    (assim o pipeline nativo coloca os cards nas colunas do pós-venda).
    //  - PRÉ/admin: exclui os leads do 2030.
    try {
      const { posSet, posDigits } = await posLineInfo();
      const isPos = await userIsPos(req);
      // COLUNA-PONTE: 'Comunicação com ambiente Pré/Pós-Venda'. Um lead está na ponte se foi colocado
      // nela por QUALQUER lado — stage='clientes_antigos' (pré) OU pos_stage='clientes_antigos_pos'
      // (pós). Quem está na ponte aparece nos DOIS ambientes, na coluna-ponte de cada board.
      const inBridge = (l) => l.bridge === 1;
      if (isPos) {
        // PÓS: vê os leads do 2030, as vendas convertidas e os da ponte. Os da ponte vão p/ a coluna-
        // ponte do board pós ('clientes_antigos_pos'); os demais, pela regra normal (posStageFor).
        parsedLeads = parsedLeads
          .filter(l => leadIsPos(l, posSet, posDigits) || l.stage === 'convertida' || inBridge(l))
          .map(l => Object.assign({}, l, { stage: inBridge(l) ? 'clientes_antigos_pos' : posStageFor(l) }));
      } else if (posSet.size) {
        // PRÉ/admin: exclui os leads do 2030, EXCETO os que estão na coluna-ponte (cross-visíveis).
        // Os da ponte são remapeados p/ a coluna-ponte do board pré ('clientes_antigos').
        parsedLeads = parsedLeads
          .filter(l => !leadIsPos(l, posSet, posDigits) || inBridge(l))
          .map(l => inBridge(l) ? Object.assign({}, l, { stage: 'clientes_antigos' }) : l);
      }
    } catch (e) { /* em caso de falha, não filtra */ }
    res.json(parsedLeads);
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
    const cur = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!cur) return res.status(404).json({ error: "Lead não encontrado" });
    // COLUNA-PONTE: entrar nela (por qualquer board) marca a flag 'bridge' e PRESERVA o stage/pos_stage
    // de origem — não grava o valor-ponte. Assim, ao SAIR da ponte (mover p/ qualquer outra coluna), o
    // bridge volta a 0 e o card some da ponte nos DOIS ambientes, retornando à sua coluna de origem.
    if (stage === 'clientes_antigos' || stage === 'clientes_antigos_pos') {
      await runQuery("UPDATE leads SET bridge = 1 WHERE id = ?", [id]);
      const l2 = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
      return res.json({ ...l2, stage, tags: l2.tags ? JSON.parse(l2.tags) : [] });
    }
    // PÓS-VENDA: coluna pós (não-ponte) → grava pos_stage e SAI da ponte (bridge=0). NUNCA mexe no
    // 'stage' do pré-venda. (As colunas pós têm nomes próprios.)
    if (POS_STAGES.includes(stage)) {
      await runQuery("UPDATE leads SET pos_stage = ?, bridge = 0 WHERE id = ?", [stage, id]);
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
    // PRÉ-VENDA: coluna pré (não-ponte) → grava stage e SAI da ponte (bridge=0).
    await runQuery("UPDATE leads SET stage = ?, bridge = 0 WHERE id = ?", [stage, id]);
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

// 4b. Leads Routes: Patch Lead Details
app.patch('/api/leads/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, value, tags, comments, priority, lastClientReply, followup_date } = req.body;
  
  try {
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
    if (lastClientReply !== undefined) {
      updates.push("lastClientReply = ?");
      params.push(lastClientReply);
    }
    if (followup_date !== undefined) {
      updates.push("followup_date = ?");
      params.push(followup_date || null);
    }

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

app.get('/api/pipeline/stages', authenticateToken, async (req, res) => {
  try {
    // Fonte de verdade das colunas: o SERVIDOR decide pré/pós pelo wa_type do usuário logado.
    let wa_type = 'ambos';
    try { const u = await getRow("SELECT wa_type FROM users WHERE id = ?", [req.user.sub]); if (u && u.wa_type) wa_type = u.wa_type; } catch (e) {}
    if (wa_type === 'pos') return res.json(POS_STAGES_FULL);
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
    const _range = daysRangeSP(req.query.from, req.query.to, 15);
    const weeklyLeads = [];
    for (const dia of _range) {
      const r = await getRow("SELECT COUNT(*) as count FROM leads WHERE substr(createdAt,1,10) = ?", [dia.iso]);
      weeklyLeads.push({ day: dia.label, value: (r && r.count) || 0 });
    }

    // Leads por CANAL de origem por dia (MESMA base do weeklyLeads → o total por dia BATE com
    // "Leads na Semana"). Canal derivado de lead.tracking; sem rastreamento = "Sem classificação".
    const _byDay = {};
    _range.forEach(d => { _byDay[d.iso] = { day: d.label, ga: 0, meta: 0, org: 0, semclass: 0, total: 0 }; });
    const _allInRange = await allRows(
      "SELECT createdAt, tracking FROM leads WHERE substr(createdAt,1,10) >= ? AND substr(createdAt,1,10) <= ?",
      [_range[0].iso, _range[_range.length - 1].iso]
    );
    _allInRange.forEach(l => {
      const k = String(l.createdAt || '').slice(0, 10);
      const slot = _byDay[k]; if (!slot) return;
      let cat = 'semclass';
      if (l.tracking) {
        try {
          const tk = JSON.parse(l.tracking);
          if (tk && typeof tk === 'object' && Object.keys(tk).length) {
            const ch = deriveChannel(tk);
            cat = (ch === 'Google Ads') ? 'ga' : (ch === 'Meta Ads') ? 'meta' : 'org';
          }
        } catch (e) {}
      }
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

// 6b. Dashboard: contratos assinados por dia (e-mails "Contrato Assinado pelo Cliente:")
let _signedCache = { key: '', ts: 0, data: null };
app.get('/api/dashboard/signed-contracts', authenticateToken, async (req, res) => {
  // monta os dias do período (from/to; padrão 15 dias, fuso de São Paulo)
  const days = daysRangeSP(req.query.from, req.query.to, 15);
  const cacheKey = (req.query.from || '') + '|' + (req.query.to || '');
  // cache de 5 min POR período (IMAP é lento; o front consulta com frequência)
  if (_signedCache.data && _signedCache.key === cacheKey && (Date.now() - _signedCache.ts < 5 * 60 * 1000)) {
    return res.json(_signedCache.data);
  }
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
  res.json(payload);
});

// 6c. Clientes que ASSINARAM o contrato (assunto "Contrato Assinado pelo Cliente: NOME").
// Varre a caixa (últimos 90 dias). De cada mensagem casada extrai (a) os e-mails do corpo/assunto e
// (b) o NOME que vem após "Cliente:" no assunto. O front marca o card como "assinado" quando o e-mail
// OU o nome do lead bate. Use ?debug=1 para ver os assuntos casados e o que foi extraído.
let _signedEmailsCache = { ts: 0, data: null };
app.get('/api/dashboard/signed-emails', authenticateToken, async (req, res) => {
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');
  if (!debug && _signedEmailsCache.data && (Date.now() - _signedEmailsCache.ts < 5 * 60 * 1000)) {
    return res.json(_signedEmailsCache.data);
  }
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
  if (debug) { payload.matched = dbg; payload.matchedCount = dbg.length; payload.scanOk = scanOk; return res.json(payload); }
  if (scanOk) {
    // Varredura OK: atualiza o cache (une com o último bom p/ nunca encolher por uma leitura parcial do IMAP).
    if (_signedEmailsCache.data) {
      const e = new Set([...(_signedEmailsCache.data.emails || []), ...payload.emails]);
      const n = new Set([...(_signedEmailsCache.data.names || []), ...payload.names]);
      payload.emails = Array.from(e); payload.names = Array.from(n);
    }
    _signedEmailsCache = { ts: Date.now(), data: payload };
    return res.json(payload);
  }
  // Varredura falhou (IMAP indisponível): devolve o último resultado bom, sem gravar lista vazia.
  if (_signedEmailsCache.data) return res.json(_signedEmailsCache.data);
  res.json(payload);
});

// 7. Conversations Routes: Get List (exclude archived leads' conversations)
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
    try {
      const { posSet } = await getSaleLineFilter();
      if (posSet.size) {
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

    // Attach last message for each conversation
    const detailedConvs = [];
    for (const c of convs) {
      const lastMsg = await getRow(
        "SELECT id, \`from\`, text, time, type, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1",
        [c.id]
      );
      detailedConvs.push({
        ...c,
        online: Boolean(c.online),
        lastMessage: lastMsg || null
      });
    }

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
      "SELECT id, \`from\`, text, time, type, timestamp, status, edited, deleted FROM messages WHERE conversationId = ? ORDER BY timestamp ASC",
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
    // Trava de ambiente: pós-venda SÓ envia pelo 2030; pré/admin NÃO enviam pelo 2030.
    try {
      const { posSet } = await getSaleLineFilter();
      if (posSet.size) {
        const isPos = await userIsPos(req);
        const convPos = posSet.has(convo.account);
        if (isPos && !convPos) return res.status(403).json({ error: 'No pós-venda só é permitido enviar pelo número 2030.' });
        if (!isPos && convPos) return res.status(403).json({ error: 'Este número (2030) é do ambiente pós-venda.' });
      }
    } catch (e) { /* não bloqueia em falha de checagem */ }

    // NÓS respondemos → conversa "lida": zera a bolinha (como no WhatsApp Web).
    await runQuery("UPDATE conversations SET unread = 0 WHERE id = ?", [id]);

    // NÓS respondemos pelo CRM → zera o lastClientReply do lead correspondente
    // (o "controle de tempo" só aparece enquanto o cliente foi o último a falar).
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
    } catch (e) { /* ignore */ }

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
      return res.json({ id: msgId, conversationId: id, from: 'me', text: text, time: timeStr, timestamp: Date.now() });
    }

    const accountId = convo.account;
    const isConnected = sessions[accountId] && sessions[accountId].ws.isOpen;

    let messageObj;

    if (isConnected) {
      // Send real WhatsApp message
      messageObj = await sendWhatsAppMessage(accountId, id, text);
    } else {
      // Offline fallback: Save message locally and mock it
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
    } catch (e) { /* ignore */ }

    res.json({ conversation: { ...convo, account: accountId }, message: messageObj });
  } catch (err) {
    console.error('start-conversation error:', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Falha ao iniciar conversa.' });
  }
});

// 9b. Conversations Routes: Send Voice Note (audio, base64 in body)
app.post('/api/conversations/:id/audio', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { audio, mimetype } = req.body;
  if (!audio) return res.status(400).json({ error: "Áudio é obrigatório" });

  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });

    const buffer = Buffer.from(audio, 'base64');
    const accountId = convo.account;
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

// 9b1b. Conversations Routes: enviar foto/vídeo/documento
app.post('/api/conversations/:id/media', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { data, mimetype, fileName } = req.body || {};
  if (!data) return res.status(400).json({ error: "Arquivo é obrigatório" });
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) return res.status(404).json({ error: "Conversa não encontrada" });
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > 16 * 1024 * 1024) return res.status(400).json({ error: "Arquivo acima de 16 MB" });
    const accountId = convo.account;
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
    res.setHeader('Content-Type', ctype);
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
const POS_STAGES = ['clientes_antigos_pos', 'vendas_concretizadas', 'para_classificar', 'visto_amer_agendamento', 'visto_amer_validacao', 'visto_amer_envio', 'visto_canadense', 'visto_portugues', 'aire_italiano', 'outros'];
// Colunas do pipeline PÓS-VENDA (com título e cor) — o servidor entrega isto quando o usuário é 'pos'.
// As 3 colunas com group='Grupo Visto Americano' são raias internas agrupadas no frontend sob um título único.
const POS_STAGES_FULL = [
  { id: 'clientes_antigos_pos',   title: 'Comunicação com ambiente Pré-Venda', color: '#6366f1' },
  { id: 'vendas_concretizadas',   title: 'Clientes concluídos',                color: '#16a34a' },
  { id: 'para_classificar',       title: 'Mensagens novas para organizar',     color: '#71717a' },
  { id: 'visto_amer_agendamento', title: 'Agendamento',                        color: '#2563eb', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_validacao',   title: 'Validação',                          color: '#1d4ed8', group: 'Grupo Visto Americano' },
  { id: 'visto_amer_envio',       title: 'Envio passaporte',                   color: '#7c3aed', group: 'Grupo Visto Americano' },
  { id: 'visto_canadense',        title: 'Vistos canadenses',                  color: '#ef4444' },
  { id: 'visto_portugues',        title: 'Vistos portugueses',                 color: '#15803d' },
  { id: 'aire_italiano',          title: 'Passaporte italiano / AIRE',         color: '#0ea5e9' },
  { id: 'outros',                 title: 'Outros',                             color: '#6b7280' }
];
function posStageFor(lead) {
  if (lead.pos_stage && POS_STAGES.includes(lead.pos_stage)) return lead.pos_stage;
  if (lead.stage === 'convertida') return 'vendas_concretizadas';
  if (lead.stage === 'clientes_antigos') return 'clientes_antigos_pos';
  return 'para_classificar';
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
  try {
    const statusInfo = await connectWhatsApp(id);
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
      qr: sessionQrs[id] || null
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
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = (client.mailbox && client.mailbox.exists) || 0;
      if (total > 0) {
        const start = Math.max(1, total - 29);
        for await (const msg of client.fetch(start + ':*', { envelope: true, internalDate: true })) {
          const f = msg.envelope && msg.envelope.from && msg.envelope.from[0];
          out.push({
            uid: msg.uid,
            subject: (msg.envelope && msg.envelope.subject) || '(sem assunto)',
            from: f ? (f.name || f.address) : '',
            fromAddress: f ? f.address : '',
            date: msg.internalDate || (msg.envelope && msg.envelope.date) || null
          });
        }
      }
    } finally {
      lock.release();
    }
    try { await client.logout(); } catch (e) {}
    out.reverse();
    res.json(out);
  } catch (err) {
    console.error("IMAP error:", err && err.message);
    res.status(500).json({ error: (err && err.message) || "Falha ao ler e-mails" });
  }
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
    const lock = await client.getMailboxLock('INBOX');
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
          text: p.text || ''
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
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, whatsapp_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, convo.name || (src + ' lead'), "", convo.phone || "", "", 0, "novo", src, convo.account || 'ig', "Henry Mancini", JSON.stringify([]), createdAt, 0, convo.whatsapp_jid || null]
    );
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    res.json({ ...lead, tags: [], created: true });
  } catch (err) {
    console.error("from-conversation error:", err && err.message);
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
    const attachmentUrl = c.client_attachment_path ? (DS160_BASE.replace(/\/api$/, '') + '/' + String(c.client_attachment_path).replace(/^\/+/, '')) : null;
    res.json({ ...c, pdfUrl, attachmentUrl });
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
  if (req.user && req.user.role === 'Vendedor') return res.status(403).json({ error: 'Sem permissão' });
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
// última mensagem real de cada conversa — é a fonte única da verdade. Roda no boot e a cada 60s,
// então o estado se autocorrige independentemente de a mensagem ter vindo pelo CRM, pelo celular
// ou pela IA (não depende de o "casamento" por telefone ter acertado na hora do envio).
//
// Regras:
//  • Cliente aguardando (bolinha acesa) SOMENTE se a última msg é do cliente ('them') E é MAIS NOVA
//    que o marcador "não é demanda" (not_demand_ts). Caso contrário, zera lastClientReply.
//  • Tag "Novo lead" (priority='novolead') é removida quando existe QUALQUER mensagem nossa de um
//    HUMANO (from='me' E ai=0) na conversa — ou seja, alguém de fato atendeu. Mensagens da IA
//    (ai=1) NÃO contam, então o card recém-transferido pela IA continua na 1ª coluna até o humano falar.
async function reconcileReplyDots() {
  try {
    const leads = await allRows("SELECT id, whatsapp_jid, phone, priority, not_demand_ts FROM leads WHERE archived = 0");
    for (const l of leads) {
      const convo = await findConvoForLead(l);
      if (!convo) continue;
      const last = await getRow("SELECT `from`, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [convo.id]);
      if (!last) continue;

      // last_client_ts: timestamp da última mensagem DO CLIENTE (persistente; usado para ordenar
      // todas as colunas por antiguidade da msg do cliente). Backfill/auto-correção contínua.
      try {
        const lastThem = await getRow("SELECT MAX(timestamp) AS ts FROM messages WHERE conversationId = ? AND `from` = 'them'", [convo.id]);
        const lct = Number(lastThem && lastThem.ts) || 0;
        if (lct) await runQuery("UPDATE leads SET last_client_ts = ? WHERE id = ? AND COALESCE(last_client_ts,0) <> ?", [lct, l.id, lct]);
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
        const human = await getRow("SELECT id FROM messages WHERE conversationId = ? AND `from` = 'me' AND COALESCE(ai,0) = 0 LIMIT 1", [convo.id]);
        if (human) await runQuery("UPDATE leads SET priority = '' WHERE id = ? AND priority = 'novolead'", [l.id]);
      }
    }
  } catch (e) {
    console.error("reconcileReplyDots error:", e && e.message);
  }
}
// Autocorreção contínua: a cada 60s (além da chamada no boot).
setInterval(() => { reconcileReplyDots().catch(() => {}); }, 60 * 1000);

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
    const horasMs = (cfg.fu_hours || 24) * 3600 * 1000;
    const leads = await allRows(
      "SELECT * FROM leads WHERE archived = 0 AND stage = 'tratamento' AND (priority IS NULL OR priority = '') AND lastClientReply IS NULL AND COALESCE(ai_fu_count, 0) < ?",
      [cfg.fu_max || 2]
    );
    if (!leads.length) return;
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
        await sendWhatsAppMessage(conv.account, conv.id, texto);
        const fuTs = Date.now();
        await runQuery("UPDATE leads SET ai_fu_count = ?, ai_fu_last = ? WHERE id = ?", [tentativa, fuTs, l.id]);
        try { await runQuery("INSERT INTO followup_log (ts, lead_id, lead_name) VALUES (?, ?, ?)", [fuTs, l.id, l.name]); } catch (e) {}
        processed++;
        console.log(`[IA follow-up] "${l.name}": tentativa ${tentativa} enviada (${processed}/${PER_RUN_CAP}).`);
        // intervalo humano entre os envios (5–13 s) para não parecer disparo em massa
        await new Promise(r => setTimeout(r, 5000 + Math.floor(Math.random() * 8000)));
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
app.post('/api/integrations/google-ads-daily', checkApiKey, async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'rows vazio' });
    const now = new Date().toISOString();
    let n = 0;
    for (const r of rows) {
      const date = String(r.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      await runQuery(
        "INSERT INTO google_ads_daily (date, clicks, cost, conversions, impressions, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(date) DO UPDATE SET clicks=excluded.clicks, cost=excluded.cost, conversions=excluded.conversions, impressions=excluded.impressions, updated_at=excluded.updated_at",
        [date, Math.round(Number(r.clicks) || 0), Number(r.cost) || 0, Number(r.conversions) || 0, Math.round(Number(r.impressions) || 0), now]
      );
      n++;
    }
    res.json({ success: true, upserted: n });
  } catch (e) { console.error('[google-ads-daily ingest]', e && e.message); res.status(500).json({ error: e.message }); }
});

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
  // Canal explícito já definido (ex.: classificação manual/por mensagem do Meta) tem prioridade.
  if (tk && typeof tk.channel === 'string' && tk.channel.trim()) return tk.channel.trim();
  const src = String(tk.utm_source || '').toLowerCase();
  const med = String(tk.utm_medium || '').toLowerCase();
  if (tk.gclid || /google|adwords|gads/.test(src)) return 'Google Ads';
  if (tk.fbclid || /facebook|meta|instagram|\bfb\b|\big\b/.test(src) || /facebook|meta|instagram/.test(med)) return 'Meta Ads';
  if (src && src !== 'direct' && src !== '(direct)') return src.charAt(0).toUpperCase() + src.slice(1);
  return 'Orgânico';
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
      // Lead JÁ existe: só carimba o rastreamento. NÃO sobrescreve nome/telefone/comentários do lead.
      await runQuery("UPDATE leads SET tracking = ? WHERE id = ?", [JSON.stringify(tracking), existing.id]);
      const upd = await getRow("SELECT * FROM leads WHERE id = ?", [existing.id]);
      sendWebhook('lead.updated', { ...upd, tags: upd.tags ? JSON.parse(upd.tags) : [], tracking });
      return res.json({ ok: true, action: 'tracking_stamped', leadId: existing.id });
    }
    const id = 'l_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString().slice(0, 10);
    const tags = service ? [String(service)] : [];
    // "notes" (mensagem do cliente) e "destination" vão para os comentários internos — só na CRIAÇÃO.
    let comments = String(notes || '').slice(0, 2000);
    if (b.destination) comments = (comments ? comments + '\n' : '') + 'Destino: ' + String(b.destination).slice(0, 120);
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, priority, tracking, comments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, String(name || email || phone).slice(0, 200), String(company || '').slice(0, 200), String(phone || ''), String(email || ''), Number(b.value) || 0,
       'novo', String(b.source || b.utm_source || b.title || 'Marketing').slice(0, 80), '', 'Marketing', JSON.stringify(tags), createdAt, 0, '', JSON.stringify(tracking), comments]
    );
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
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
      "UPDATE leads SET pos_stage = 'visto_amer_agendamento' " +
      "WHERE pos_stage IN ('visto_americano', 'visto_amer_primeiro', 'visto_amer_renov', 'visto_amer_renov_sem')"
    );
    await runQuery("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [FLAG, new Date().toISOString()]);
    console.log(`[visto amer grupo] ${(r && r.changes) || 0} card(s) movidos p/ Agendamento.`);
  } catch (e) { console.error('[visto amer grupo]', e && e.message); }
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

// Define wa5 e wa6 como PÓS-VENDA por padrão (são celulares de pós-venda). Faz MERGE: só preenche o
// tipo quando ainda não houver um definido para a linha — não sobrescreve o que o Henry já configurou.
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
  // Dedup de leads fantasma (duplicatas sem telefone do mesmo nome) — no boot e a cada 30 min.
  try { await archiveGhostDuplicates(); } catch (e) { console.error('[dedup fantasma boot]', e && e.message); }
  setInterval(() => { archiveGhostDuplicates().catch(() => {}); }, 30 * 60 * 1000);
  // PONTUAL: aplica a tag de serviço padrão aos leads sem tag (uma única vez; flag impede repetir).
  try { await backfillServiceTagOnce(); } catch (e) { console.error('[backfill tag serviço boot]', e && e.message); }
  // wa5/wa6 = pós-venda por padrão (não sobrescreve configuração existente).
  try { await ensurePosVendaDefaults(); } catch (e) { console.error('[wa pós-venda boot]', e && e.message); }
  // PONTUAL: reconcilia duplicatas JÁ existentes de mesmo telefone (arquiva, mantendo a etapa mais avançada).
  try { await reconcileDuplicatesByPhoneOnce(); } catch (e) { console.error('[dedup telefone boot]', e && e.message); }
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
});
