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
  initSessions,
  sessionQrs,
  sessions,
  MEDIA_DIR, sendWhatsAppMedia,
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
      { id: "declinado",  title: "Lead declinou/cancelado", color: "#ef4444" }
    ];
    await runQuery("DELETE FROM stages");
    for (const s of correctStages) {
      await runQuery("INSERT INTO stages (id, title, color) VALUES (?, ?, ?)", [s.id, s.title, s.color]);
    }
    await runQuery("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
    await runQuery("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
    await runQuery("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'convertida', 'declinado')");
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
    const user = await getRow("SELECT * FROM users WHERE email = ?", [email]);
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
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({
    id: req.user.sub,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    avatar: req.user.avatar
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
    const users = await allRows("SELECT id, name, email, role, avatar FROM users ORDER BY name");
    res.json(users);
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.post('/api/users', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ detail: "Nome, e-mail e senha são obrigatórios" });
  const r = (role === 'Vendedor') ? 'Vendedor' : 'Administrador';
  const mail = String(email).trim().toLowerCase();
  try {
    const existing = await getRow("SELECT id FROM users WHERE email = ?", [mail]);
    if (existing) return res.status(409).json({ detail: "Já existe um usuário com este e-mail" });
    const id = 'u_' + Math.random().toString(36).substr(2, 9);
    const hash = bcrypt.hashSync(String(password), 10);
    const avatar = String(name).trim().slice(0, 2).toUpperCase();
    await runQuery("INSERT INTO users (id, email, password_hash, name, role, avatar) VALUES (?, ?, ?, ?, ?, ?)",
      [id, mail, hash, String(name).trim(), r, avatar]);
    res.json({ id, name: String(name).trim(), email: mail, role: r, avatar });
  } catch (e) { res.status(500).json({ detail: String(e) }); }
});

app.patch('/api/users/:id', authenticateToken, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  const { name, role, password } = req.body;
  try {
    const u = await getRow("SELECT * FROM users WHERE id = ?", [id]);
    if (!u) return res.status(404).json({ detail: "Usuário não encontrado" });
    const updates = [], params = [];
    if (name !== undefined && String(name).trim()) {
      updates.push("name = ?"); params.push(String(name).trim());
      updates.push("avatar = ?"); params.push(String(name).trim().slice(0, 2).toUpperCase());
    }
    if (role !== undefined) { updates.push("role = ?"); params.push(role === 'Vendedor' ? 'Vendedor' : 'Administrador'); }
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

// Grava uma mensagem/comentário do Instagram como conversa (account = 'ig')
async function storeIgMessage(senderId, text, from, name, msgId) {
  const jid = 'ig:' + senderId;
  const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  let convo = await getRow("SELECT * FROM conversations WHERE whatsapp_jid = ?", [jid]);
  let convoId;
  if (convo) {
    convoId = convo.id;
    await runQuery("UPDATE conversations SET lastTime = ?, unread = unread + ? WHERE id = ?", [timeStr, from === 'them' ? 1 : 0, convoId]);
  } else {
    convoId = 'c_' + Math.random().toString(36).substr(2, 9);
    const nm = name || 'Instagram';
    await runQuery(
      "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, whatsapp_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [convoId, 'ig', nm, '', nm.slice(0, 2).toUpperCase(), timeStr, from === 'them' ? 1 : 0, 0, jid]
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
    return res.redirect(APP_BASE_URL + '/app/conexoes?ig=ok');
  } catch (e) {
    console.error('[IG OAuth] erro', e);
    return res.redirect(APP_BASE_URL + '/app/conexoes?ig=erro');
  }
});

// Status da conexao do Instagram (para o front exibir conectado)
app.get('/api/instagram/status', authenticateToken, async (req, res) => {
  try {
    const row = await getRow("SELECT ig_user_id, username, connected_at FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
    res.json(row ? { connected: true, username: row.username, connected_at: row.connected_at } : { connected: false });
  } catch (e) { res.json({ connected: false }); }
});

// Desconecta o Instagram (remove o token guardado)
app.post('/api/instagram/disconnect', authenticateToken, async (req, res) => {
  try {
    await runQuery("DELETE FROM ig_connections");
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envia uma mensagem de Direct pelo Instagram usando o token guardado
async function sendIgMessage(recipientId, text) {
  const conn = await getRow("SELECT * FROM ig_connections ORDER BY connected_at DESC LIMIT 1");
  if (!conn || !conn.access_token) throw new Error('Instagram nao conectado');
  const resp = await fetch('https://graph.instagram.com/v21.0/me/messages?access_token=' + encodeURIComponent(conn.access_token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, message: { text: text } })
  });
  const d = await resp.json();
  if (d.error) throw new Error((d.error && d.error.message) || 'Falha ao enviar Direct');
  return d;
}

// 3. Leads Routes: Get All (active only)
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    // Ordena por prioridade (followup no topo, depois urgente/vermelho, depois média/amarelo, depois sem), e por data.
    const leads = await allRows("SELECT * FROM leads WHERE archived = 0 ORDER BY CASE priority WHEN 'followup' THEN 1 WHEN 'urgente' THEN 2 WHEN 'media' THEN 3 ELSE 4 END, createdAt DESC");
    const parsedLeads = leads.map(l => ({
      ...l,
      tags: l.tags ? JSON.parse(l.tags) : []
    }));
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
  const { stage } = req.body;
  
  if (!stage) {
    return res.status(400).json({ error: "Estágio é obrigatório" });
  }

  try {
    const cur = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
    if (!cur) return res.status(404).json({ error: "Lead não encontrado" });
    // Estágios TERMINAIS: uma vez em "Venda convertida" ou "Lead declinou/cancelado",
    // o lead NÃO muda mais de etapa (protege o controle do que vendeu / declinou).
    if ((cur.stage === 'convertida' || cur.stage === 'declinado') && stage !== cur.stage) {
      console.log(`[stage] BLOQUEADO: "${cur.name}" está em '${cur.stage}' (terminal) — mudança p/ '${stage}' ignorada.`);
      return res.json({ ...cur, tags: cur.tags ? JSON.parse(cur.tags) : [], _locked: true });
    }
    await runQuery("UPDATE leads SET stage = ? WHERE id = ?", [stage, id]);
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
  const { name, phone, value, tags, comments, priority, lastClientReply } = req.body;
  
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

    if (updates.length > 0) {
      params.push(id);
      await runQuery(`UPDATE leads SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    const updatedLead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
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
  { id: "declinado",  title: "Lead declinou/cancelado", color: "#ef4444" }
];

app.get('/api/pipeline/stages', authenticateToken, async (req, res) => {
  try {
    let stages = await allRows("SELECT * FROM stages");
    // Self-healing: if stages don't match expected set, fix them
    const ids = stages.map(s => s.id).sort().join(',');
    const expectedIds = CORRECT_STAGES.map(s => s.id).sort().join(',');
    if (ids !== expectedIds) {
      console.log("Self-healing stages: current=" + ids + " expected=" + expectedIds);
      await runQuery("DELETE FROM stages");
      for (const s of CORRECT_STAGES) {
        await runQuery("INSERT INTO stages (id, title, color) VALUES (?, ?, ?)", [s.id, s.title, s.color]);
      }
      // Migrate leads with old stage IDs
      await runQuery("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
      await runQuery("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
      await runQuery("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'convertida', 'declinado')");
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

    // Novos leads REAIS por dia (últimos 7 dias, fuso de São Paulo).
    const weeklyLeads = [];
    for (const dia of last7DaysSP()) {
      const r = await getRow("SELECT COUNT(*) as count FROM leads WHERE substr(createdAt,1,10) = ?", [dia.iso]);
      weeklyLeads.push({ day: dia.label, value: (r && r.count) || 0 });
    }

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
      recentActivity: [],
      whatsappAccounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6b. Dashboard: contratos assinados por dia (e-mails "Contrato Assinado pelo Cliente:")
let _signedCache = { ts: 0, data: null };
app.get('/api/dashboard/signed-contracts', authenticateToken, async (req, res) => {
  // monta os 7 dias (mesma ordem/rótulo do weeklyLeads, fuso de São Paulo)
  const days = last7DaysSP();
  // cache de 5 min (IMAP é lento; o front consulta com frequência)
  if (_signedCache.data && (Date.now() - _signedCache.ts < 5 * 60 * 1000)) {
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
        const since = new Date(); since.setDate(since.getDate() - 7); since.setHours(0, 0, 0, 0);
        // Conta "Contrato Assinado pelo Cliente:".
        const matchSubj = (s) => s.includes('contrato assinado pelo cliente');
        // Estratégia robusta: tenta SEARCH SINCE (todas as msgs dos últimos 7 dias);
        // se falhar/vier vazio, faz fallback nas últimas 300 mensagens da caixa.
        // Em ambos os casos, o que conta é o filtro de ASSUNTO + janela de 7 dias.
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
  _signedCache = { ts: Date.now(), data: payload };
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
      "SELECT id, \`from\`, text, time, type, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp ASC",
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
    } catch (e) { /* ignore */ }

    // Instagram: envia pelo Direct e grava a mensagem
    if (convo.account === 'ig') {
      const recipientId = (convo.whatsapp_jid || '').replace(/^ig:/, '');
      const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const msgId = 'm_' + Math.random().toString(36).substr(2, 9);
      try {
        await sendIgMessage(recipientId, text);
      } catch (e) {
        return res.status(502).json({ error: 'Falha ao enviar no Instagram: ' + e.message });
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
app.post('/api/conversations/:id/archive', authenticateToken, async (req, res) => {
  try {
    await runQuery("UPDATE conversations SET archived = 1 WHERE id = ?", [req.params.id]);
    res.json({ success: true });
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
app.get('/api/whatsapp/accounts', authenticateToken, async (req, res) => {
  try {
    const accounts = await allRows("SELECT * FROM whatsapp_accounts");
    res.json(accounts);
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
  // Anexos: [{ filename, content(base64), contentType }]
  let mailAttachments;
  if (Array.isArray(attachments) && attachments.length) {
    let total = 0;
    mailAttachments = [];
    for (const a of attachments) {
      if (!a || !a.content || !a.filename) continue;
      const buf = Buffer.from(String(a.content), 'base64');
      total += buf.length;
      if (total > 20 * 1024 * 1024) return res.status(400).json({ error: "Anexos acima de 20 MB no total" });
      mailAttachments.push({ filename: String(a.filename), content: buf, contentType: a.contentType || undefined });
    }
  }
  try {
    const acc = await getRow("SELECT * FROM email_accounts ORDER BY connected_at DESC LIMIT 1");
    if (!acc) return res.status(400).json({ error: "Nenhum e-mail conectado" });
    const transporter = nodemailer.createTransport({
      host: acc.host, port: acc.port, secure: !!acc.secure,
      auth: { user: acc.email, pass: acc.password },
      tls: { rejectUnauthorized: false }
    });
    await transporter.sendMail({
      from: acc.email, to, cc: cc || undefined, subject,
      text: text || undefined, html: html || undefined,
      attachments: mailAttachments && mailAttachments.length ? mailAttachments : undefined
    });
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

// 20. Leads Routes: Create lead manually (botão "Novo Lead")
app.post('/api/leads', authenticateToken, async (req, res) => {
  const { name, phone, email, value, stage, source, company, priority, account, tags } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Nome é obrigatório" });
  try {
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
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, priority, recv_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name.trim(), company || "", phone || "", email || "", Number(value) || 0, stage || "novo", source || "Manual", account || "", (req.user && req.user.name) || "Henry Mancini", JSON.stringify(safeTags), createdAt, 0, priority || "", recvNumber]
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
// Reconciliação única do "controle de tempo": para cada lead com o ponto aceso
// (lastClientReply != NULL), olha a ÚLTIMA mensagem da conversa; se foi nossa
// ('me'), zera o lastClientReply (limpa vermelhos antigos onde já respondemos).
async function reconcileReplyDots() {
  try {
    // Reconcilia a bolinha de tempo de TODOS os leads ativos com base na última
    // mensagem real de cada conversa: cliente foi o último → carimba com a data
    // dela; nós fomos os últimos → zera. Cobre novos, restaurados e antigos.
    const leads = await allRows("SELECT id, whatsapp_jid, phone FROM leads WHERE archived = 0");
    for (const l of leads) {
      let convo = null;
      if (l.whatsapp_jid) {
        convo = await getRow("SELECT id FROM conversations WHERE whatsapp_jid = ?", [l.whatsapp_jid]);
      }
      if (!convo && l.phone) {
        const p = l.phone.replace(/\D/g, '');
        if (p.length >= 8) {
          convo = await getRow("SELECT id FROM conversations WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?", [`%${p.slice(-8)}%`]);
        }
      }
      if (!convo) continue;
      const last = await getRow("SELECT `from`, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [convo.id]);
      if (!last) continue;
      if (last.from === 'me') {
        await runQuery("UPDATE leads SET lastClientReply = NULL WHERE id = ?", [l.id]);
      } else {
        const iso = last.timestamp ? new Date(Number(last.timestamp)).toISOString() : new Date().toISOString();
        await runQuery("UPDATE leads SET lastClientReply = ? WHERE id = ?", [iso, l.id]);
      }
    }
    console.log("reconcileReplyDots: pontos de tempo reconciliados (todos os leads).");
  } catch (e) {
    console.error("reconcileReplyDots error:", e && e.message);
  }
}

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
    ['gemini_key', 'model', 'novo_instructions', 'fu_instructions'].forEach(k => { if (b[k] !== undefined) cur[k] = String(b[k]); });
    ['enabled', 'novo_enabled', 'fu_enabled'].forEach(k => { if (b[k] !== undefined) cur[k] = !!b[k]; });
    if (b.fu_hours !== undefined) cur.fu_hours = Math.max(1, Math.min(168, Number(b.fu_hours) || 24));
    if (b.fu_max !== undefined) cur.fu_max = Math.max(0, Math.min(10, Number(b.fu_max) || 2));
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
    const convs = await allRows("SELECT id, account, phone, whatsapp_jid FROM conversations WHERE (archived IS NULL OR archived = 0)");
    const norm = (p) => String(p || '').replace(/\D/g, '');
    for (const l of leads) {
      try {
        const lt = norm(l.phone).slice(-8);
        const conv = convs.find(c =>
          (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
          (lt.length === 8 && norm(c.phone).slice(-8) === lt)
        );
        if (!conv || !conv.account) continue;
        const last = await getRow("SELECT `from`, timestamp FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [conv.id]);
        if (!last || last.from !== 'me') continue;              // só quando NÓS falamos por último
        if (Date.now() - (last.timestamp || 0) < horasMs) continue; // ainda dentro da janela
        if ((l.ai_fu_last || 0) > (last.timestamp || 0)) continue;  // já fizemos follow-up desta pausa
        const tentativa = (l.ai_fu_count || 0) + 1;
        const texto = await getFollowUpReply(conv.id, l.name, tentativa);
        if (!texto) continue;
        await sendWhatsAppMessage(conv.account, conv.id, texto);
        await runQuery("UPDATE leads SET ai_fu_count = ?, ai_fu_last = ? WHERE id = ?", [tentativa, Date.now(), l.id]);
        console.log(`[IA follow-up] "${l.name}": tentativa ${tentativa} enviada.`);
      } catch (e) { console.error('[IA follow-up]', l && l.name, e && e.message); }
    }
  } catch (e) { console.error('[IA follow-up sweep]', e && e.message); }
  finally { _fuRunning = false; }
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

// API de ENTRADA: recebe leads/rastreamento do marketing digital.
// Body: { name, phone, email, value, service, source, utm_source, utm_medium,
//         utm_campaign, utm_term, utm_content, gclid, fbclid, landing_page }
// Se telefone/e-mail já existir no funil: só CARIMBA o rastreamento no card existente.
app.post('/api/integrations/lead', checkApiKey, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name && !b.phone && !b.email) return res.status(400).json({ error: 'Informe ao menos name, phone ou email' });
    const tracking = {};
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'landing_page'].forEach(k => {
      if (b[k]) tracking[k] = String(b[k]).slice(0, 300);
    });
    tracking.received_at = new Date().toISOString();
    const digits = String(b.phone || '').replace(/\D/g, '');
    let existing = null;
    if (digits.length >= 8) {
      existing = await getRow(
        "SELECT * FROM leads WHERE archived = 0 AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?",
        ['%' + digits.slice(-8) + '%']
      );
    }
    if (!existing && b.email) {
      existing = await getRow("SELECT * FROM leads WHERE archived = 0 AND LOWER(email) = ?", [String(b.email).toLowerCase()]);
    }
    if (existing) {
      await runQuery("UPDATE leads SET tracking = ? WHERE id = ?", [JSON.stringify(tracking), existing.id]);
      const upd = await getRow("SELECT * FROM leads WHERE id = ?", [existing.id]);
      sendWebhook('lead.updated', { ...upd, tags: upd.tags ? JSON.parse(upd.tags) : [], tracking });
      return res.json({ ok: true, action: 'tracking_stamped', leadId: existing.id });
    }
    const id = 'l_' + Math.random().toString(36).substr(2, 9);
    const createdAt = new Date().toISOString().slice(0, 10);
    const tags = b.service ? [String(b.service)] : [];
    await runQuery(
      "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, priority, tracking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, String(b.name || b.email || b.phone).slice(0, 200), '', String(b.phone || ''), String(b.email || ''), Number(b.value) || 0,
       'novo', String(b.source || b.utm_source || 'Marketing').slice(0, 80), '', 'Marketing', JSON.stringify(tags), createdAt, 0, '', JSON.stringify(tracking)]
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
      const mine = await allRows("SELECT id, text FROM messages WHERE conversationId = ? AND `from` = 'me'", [conv.id]);
      const respondeu = mine.some(m => {
        const txt = String((m && m.text) || '').trim();
        const mid = String((m && m.id) || '');
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
  // IA: follow-up das colunas 2-3 do Tratamento inicial (a cada 30 min; 1ª passada após 2 min)
  setTimeout(() => { aiFollowUpSweep().catch(() => {}); }, 2 * 60 * 1000);
  setInterval(() => { aiFollowUpSweep().catch(() => {}); }, 30 * 60 * 1000);
});
