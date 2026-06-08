const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { runQuery, getRow, allRows } = require('./db');
const {
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  initSessions,
  sessionQrs,
  sessions,
  MEDIA_DIR
} = require('./whatsapp');

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
      { id: "declinado",  title: "Lead declinou/cancelado", color: "#ef4444" }
    ];
    await runQuery("DELETE FROM stages");
    for (const s of correctStages) {
      await runQuery("INSERT INTO stages (id, title, color) VALUES (?, ?, ?)", [s.id, s.title, s.color]);
    }
    await runQuery("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
    await runQuery("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
    await runQuery("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'declinado')");
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

// 3. Leads Routes: Get All (active only)
app.get('/api/leads', authenticateToken, async (req, res) => {
  try {
    const leads = await allRows("SELECT * FROM leads WHERE archived = 0 ORDER BY createdAt DESC");
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
    const result = await runQuery("UPDATE leads SET stage = ? WHERE id = ?", [stage, id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: "Lead não encontrado" });
    }
    const lead = await getRow("SELECT * FROM leads WHERE id = ?", [id]);
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
      await runQuery("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'declinado')");
      stages = await allRows("SELECT * FROM stages");
    }
    res.json(stages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Dashboard Route (counts only active/non-archived leads)
app.get('/api/dashboard', authenticateToken, async (req, res) => {
  try {
    const totalLeads = await getRow("SELECT COUNT(*) as count FROM leads WHERE archived = 0");
    const totalConvs = await getRow("SELECT COUNT(*) as count FROM conversations WHERE (archived IS NULL OR archived = 0)");
    
    // Revenue sum of 'followup' leads (non-archived)
    const revenueRow = await getRow("SELECT SUM(value) as total FROM leads WHERE stage = 'followup' AND archived = 0");
    const totalRevenue = revenueRow.total || 0;

    // Conversion rate: closed leads / total leads (non-archived)
    const closedLeads = await getRow("SELECT COUNT(*) as count FROM leads WHERE stage = 'followup' AND archived = 0");
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

    res.json({
      metrics: {
        totalLeads: totalLeads.count,
        leadsGrowth: 12.5,
        conversations: totalConvs.count,
        conversationsGrowth: 8.2,
        conversionRate: parseFloat(conversionRate),
        conversionGrowth: 3.1,
        revenue: totalRevenue,
        revenueGrowth: 18.7
      },
      leadsBySource,
      weeklyLeads: [
        {"day": "Seg", "value": 12},
        {"day": "Ter", "value": 19},
        {"day": "Qua", "value": 9},
        {"day": "Qui", "value": 22},
        {"day": "Sex", "value": 28},
        {"day": "Sáb", "value": 14},
        {"day": "Dom", "value": 7}
      ],
      recentActivity: [
        {"id": "a1", "type": "lead", "text": "Novo lead Mariana Costa entrou via WhatsApp Comercial", "time": "há 5 min"},
        {"id": "a2", "type": "deal", "text": "Patrício Souza avançou para Negociação", "time": "há 27 min"},
        {"id": "a3", "type": "won", "text": "Negócio fechado com Ricardo Alves – R$ 6.200", "time": "há 2 h"}
      ],
      whatsappAccounts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Conversations Routes: Get List (exclude archived leads' conversations)
app.get('/api/conversations', authenticateToken, async (req, res) => {
  const { account } = req.query;
  try {
    let convs;
    if (account && account !== 'all') {
      convs = await allRows("SELECT * FROM conversations WHERE account = ? AND (archived IS NULL OR archived = 0)", [account]);
    } else {
      convs = await allRows("SELECT * FROM conversations WHERE (archived IS NULL OR archived = 0)");
    }

    // Attach last message for each conversation
    const detailedConvs = [];
    for (const c of convs) {
      const lastMsg = await getRow(
        "SELECT id, \`from\`, text, time, type FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1",
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

// 8. Conversations Routes: Get Details (Messages list)
app.get('/api/conversations/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [id]);
    if (!convo) {
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    const messages = await allRows(
      "SELECT id, \`from\`, text, time, type FROM messages WHERE conversationId = ? ORDER BY timestamp ASC",
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
    const ctype = ext === '.ogg' ? 'audio/ogg'
      : ext === '.webm' ? 'audio/webm'
      : (ext === '.mp4' || ext === '.m4a') ? 'audio/mp4'
      : 'application/octet-stream';
    res.setHeader('Content-Type', ctype);
    fs.createReadStream(msg.mediaPath).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const { to, cc, subject, text, html } = req.body;
  if (!to || !subject) return res.status(400).json({ error: "Destinatario e assunto sao obrigatorios" });
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
      text: text || undefined, html: html || undefined
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

// Start Express Server
app.listen(PORT, async () => {
  console.log(`CRM WhatsApp Backend Server running on http://localhost:${PORT}`);
  // Autostart active sessions
  try {
    await initSessions();
  } catch (err) {
    console.error("Error initializing sessions:", err);
  }
});
