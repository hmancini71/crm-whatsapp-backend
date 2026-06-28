const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(DB_PATH);

// ── Regra de origem "Google Ads" ────────────────────────────────────────────
// A mensagem inicial pré-preenchida pelo clique vindo do site (campanhas do
// Google Ads) chega SEMPRE com esta frase exata. Quando a 1ª mensagem do cliente
// começa com ela, a origem (source) do lead é "Google Ads". É a fonte única da
// verdade da regra: usada tanto na criação do lead (whatsapp.js) quanto no
// backfill dos cards antigos (migração abaixo).
const GOOGLE_ADS_FIRST_MSG = 'olá, vim do site e gostaria de informações sobre vistos/imigração.';
function normMsg(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }
function isGoogleAdsFirstMsg(text) { return normMsg(text).startsWith(GOOGLE_ADS_FIRST_MSG); }

// ── Regra de origem "Google Ads" por UTM ─────────────────────────────────────
// Quando o rastreamento (campo `tracking`) tem utm_source = "Google Ads" em QUALQUER forma
// ("Google Ads", "Google%20Ads", com &amp; no lugar de &, etc.), a origem do lead é "Google Ads".
// Aceita o tracking como objeto, como JSON do campo, ou como query string crua. Fonte única da
// verdade: usada no endpoint /api/integrations/lead e no backfill dos leads antigos.
// Extrai os parâmetros de anúncio (utm_source/utm_medium/gclid/fbclid) do tracking. Usa os campos de
// TOPO e, quando faltam, procura DENTRO das URLs de `referrer` e `landing_page` — porque alguns
// formulários (ex.: Formulário de Contato do site) mandam os UTMs só embutidos na URL, não como campos.
function extractAdParams(tk) {
  tk = tk || {};
  const res = {
    utm_source: tk.utm_source || '',
    utm_medium: tk.utm_medium || '',
    gclid: tk.gclid || '',
    fbclid: tk.fbclid || ''
  };
  const scan = (url) => {
    if (!url || typeof url !== 'string') return;
    const q = url.indexOf('?'); if (q < 0) return;
    const qs = url.slice(q + 1).replace(/#.*$/, '').replace(/&amp;/gi, '&');
    qs.split('&').forEach(pair => {
      const i = pair.indexOf('='); if (i < 0) return;
      const k = pair.slice(0, i).toLowerCase(); let v = pair.slice(i + 1);
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
      if (k === 'utm_source' && !res.utm_source) res.utm_source = v;
      else if (k === 'utm_medium' && !res.utm_medium) res.utm_medium = v;
      else if ((k === 'gclid' || k === 'gbraid' || k === 'wbraid') && !res.gclid) res.gclid = v;
      else if (k === 'fbclid' && !res.fbclid) res.fbclid = v;
    });
  };
  if (!(res.utm_source && res.gclid)) { scan(tk.referrer); scan(tk.landing_page); }
  return res;
}

function isGoogleAdsUtm(tracking) {
  if (!tracking) return false;
  let tk = tracking;
  if (typeof tracking === 'string') {
    const raw = tracking.replace(/&amp;/gi, '&');
    try {
      tk = JSON.parse(tracking);
    } catch (e) {
      tk = {};
      raw.replace(/^[?#]/, '').split('&').forEach(pair => {
        const i = pair.indexOf('=');
        if (i > 0) tk[pair.slice(0, i).trim()] = pair.slice(i + 1);
      });
    }
  }
  if (!tk || typeof tk !== 'object') return false;
  const p = extractAdParams(tk);
  let src = String(p.utm_source == null ? '' : p.utm_source).replace(/&amp;/gi, '&');
  try { src = decodeURIComponent(src.replace(/\+/g, ' ')); } catch (e) { src = src.replace(/%20/gi, ' '); }
  src = src.toLowerCase().trim();
  if (/google\s*ads/.test(src) || /adwords|gads/.test(src)) return true;
  if (p.gclid) return true;  // gclid (ou gbraid/wbraid) = clique do Google Ads
  return false;
}

// Run initialization sequentially
db.serialize(() => {
  // 1. Users Table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    password_hash TEXT,
    name TEXT,
    role TEXT,
    avatar TEXT
  )`);

  // 2. Leads Table
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    company TEXT,
    phone TEXT,
    email TEXT,
    value REAL,
    stage TEXT,
    source TEXT,
    account TEXT,
    owner TEXT,
    tags TEXT, -- JSON string of array
    createdAt TEXT
  )`);

  // 3. Stages Table
  db.run(`CREATE TABLE IF NOT EXISTS stages (
    id TEXT PRIMARY KEY,
    title TEXT,
    color TEXT
  )`);

  // 4. Conversations Table
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    account TEXT,
    name TEXT,
    phone TEXT,
    avatar TEXT,
    lastTime TEXT,
    unread INTEGER,
    online INTEGER
  )`);

  // 5. Messages Table
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversationId TEXT,
    \`from\` TEXT,
    text TEXT,
    time TEXT,
    timestamp INTEGER
  )`);

  // 6. WhatsApp Accounts Table
  db.run(`CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id TEXT PRIMARY KEY,
    label TEXT,
    number TEXT,
    color TEXT,
    status TEXT,
    unread INTEGER,
    connect_at TEXT
  )`);

  // 7. Email Accounts Table (SMTP)
  db.run(`CREATE TABLE IF NOT EXISTS email_accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    host TEXT,
    port INTEGER,
    secure INTEGER,
    password TEXT,
    status TEXT,
    connected_at TEXT
  )`);

  // 8. Instagram Connections (conta conectada via OAuth Meta)
  db.run(`CREATE TABLE IF NOT EXISTS ig_connections (
    id TEXT PRIMARY KEY,
    ig_user_id TEXT,
    username TEXT,
    access_token TEXT,
    connected_at TEXT
  )`);

  // 9. App Settings (configurações gerais em pares chave/valor JSON)
  db.run(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  // Métricas diárias do Google Ads (conta Vale Visto) — alimentadas pela sincronização
  // (Supermetrics → CRM). O dashboard lê desta tabela, filtrado por data.
  db.run(`CREATE TABLE IF NOT EXISTS google_ads_daily (
    date TEXT PRIMARY KEY,
    clicks INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    conversions REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    updated_at TEXT
  )`);

  // Check if tables are empty, and insert initial data
  db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
    if (row && row.count === 0) {
      const adminHash = bcrypt.hashSync('ValeVisto@12', 10);
      db.run("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)", [
        "u2",
        "henry.mancini@eccere.com.br",
        adminHash,
        "Henry Mancini",
        "Administrador",
        "HM"
      ]);
    }
  });

  db.get("SELECT COUNT(*) as count FROM stages", (err, row) => {
    if (row && row.count === 0) {
      const initialStages = [
        ["novo",           "Novo Leads",               "#71717a"],
        ["tratamento",     "Tratamento inicial",       "#0ea5e9"],
        ["proposta",       "Proposta enviada",         "#f59e0b"],
        ["followup",       "Follow-up pagamento",      "#ec4899"],
        ["convertida",     "Venda convertida",         "#16a34a"],
        ["declinado",      "Lead declinou/cancelado",  "#ef4444"],
        ["clientes_antigos", "Comunicação com ambiente Pós-Venda", "#6366f1"]
      ];
      const stmt = db.prepare("INSERT INTO stages VALUES (?, ?, ?)");
      initialStages.forEach(s => stmt.run(s));
      stmt.finalize();
    }
  });

  db.get("SELECT COUNT(*) as count FROM whatsapp_accounts", (err, row) => {
    if (row && row.count === 0) {
      const initialAccounts = [
        ["wa1", "Vendas", "", "#0d9488", "disconnected", 0, null],
        ["wa2", "Vendas", "", "#2563eb", "disconnected", 0, null],
        ["wa3", "Vendas", "", "#7c3aed", "disconnected", 0, null],
        ["wa4", "Vendas", "", "#ea580c", "disconnected", 0, null],
        ["wa5", "Vendas", "", "#db2777", "disconnected", 0, null],
        ["wa6", "Vendas", "", "#16a34a", "disconnected", 0, null],
        ["wa7", "Vendas", "", "#0891b2", "disconnected", 0, null],
        ["wa8", "Vendas", "", "#ca8a04", "disconnected", 0, null]
      ];
      const stmt = db.prepare("INSERT INTO whatsapp_accounts VALUES (?, ?, ?, ?, ?, ?, ?)");
      initialAccounts.forEach(a => stmt.run(a));
      stmt.finalize();
    }
  });

  // Migração: garante que as linhas wa5–wa8 existam em bancos JÁ criados (que tinham menos linhas).
  // INSERT OR IGNORE não toca nas contas existentes — apenas acrescenta as que faltam (total: 8 linhas).
  {
    const extraAccounts = [
      ["wa5", "Vendas", "", "#db2777", "disconnected", 0, null],
      ["wa6", "Vendas", "", "#16a34a", "disconnected", 0, null],
      ["wa7", "Vendas", "", "#0891b2", "disconnected", 0, null],
      ["wa8", "Vendas", "", "#ca8a04", "disconnected", 0, null]
    ];
    const stmtE = db.prepare("INSERT OR IGNORE INTO whatsapp_accounts (id, label, number, color, status, unread, connect_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    extraAccounts.forEach(a => stmtE.run(a));
    stmtE.finalize();
  }

  db.get("SELECT COUNT(*) as count FROM leads", (err, row) => {
    if (row && row.count === 0) {
      const initialLeads = [];
      const stmt = db.prepare("INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      initialLeads.forEach(l => stmt.run(l));
      stmt.finalize();
    }
  });

  db.get("SELECT COUNT(*) as count FROM conversations", (err, row) => {
    if (row && row.count === 0) {
      const initialConvs = [];
      const stmt = db.prepare("INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      initialConvs.forEach(c => stmt.run(c));
      stmt.finalize();
    }
  });

  // Safe migration: add 'archived' column to leads if it doesn't exist yet
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'archived')) {
      db.run("ALTER TABLE leads ADD COLUMN archived INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add archived column to leads:", alterErr);
        } else {
          console.log("Migration: added 'archived' column to leads table.");
        }
      });
    }
  });

  // Safe migration: add 'comments' column to leads if it doesn't exist yet
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'comments')) {
      db.run("ALTER TABLE leads ADD COLUMN comments TEXT DEFAULT ''", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add comments column to leads:", alterErr);
        } else {
          console.log("Migration: added 'comments' column to leads table.");
        }
      });
    }
  });

  // Safe migration: add 'priority' column to leads if it doesn't exist yet
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'priority')) {
      db.run("ALTER TABLE leads ADD COLUMN priority TEXT DEFAULT ''", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add priority column to leads:", alterErr);
        } else {
          console.log("Migration: added 'priority' column to leads table.");
        }
      });
    }
  });

  // Safe migration: add 'lastClientReply' column to leads if it doesn't exist yet
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'lastClientReply')) {
      db.run("ALTER TABLE leads ADD COLUMN lastClientReply TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add lastClientReply column to leads:", alterErr);
        } else {
          console.log("Migration: added 'lastClientReply' column to leads table.");
        }
      });
    }
  });

  // Safe migration: coluna last_autoreply em conversations (cooldown da resposta automática)
  db.all("PRAGMA table_info(conversations)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'last_autoreply')) {
      db.run("ALTER TABLE conversations ADD COLUMN last_autoreply INTEGER DEFAULT NULL", (alterErr) => {
        if (!alterErr) console.log("Migration: added 'last_autoreply' column to conversations.");
      });
    }
  });

  // Normaliza os rótulos das contas de WhatsApp: todas são de "Vendas"
  // (substitui nomes antigos como Comercial/Suporte/Financeiro).
  db.run("UPDATE whatsapp_accounts SET label = 'Vendas' WHERE label IS NULL OR label <> 'Vendas'", (e) => {
    if (!e) console.log("Migration: rótulos de whatsapp_accounts normalizados para 'Vendas'.");
  });

  // Safe migration: contadores de follow-up da IA
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols) {
      if (!cols.find(c => c.name === 'ai_fu_count')) db.run("ALTER TABLE leads ADD COLUMN ai_fu_count INTEGER DEFAULT 0");
      if (!cols.find(c => c.name === 'ai_fu_last')) db.run("ALTER TABLE leads ADD COLUMN ai_fu_last INTEGER DEFAULT 0");
      // "Não é demanda" PERSISTENTE: guarda o timestamp (ms) da última mensagem do cliente
      // que foi marcada como "não é demanda". O controle de tempo só reaparece se o cliente
      // mandar uma mensagem MAIS NOVA que esse marcador. Sobrevive a reconciliações/reinícios.
      if (!cols.find(c => c.name === 'not_demand_ts')) db.run("ALTER TABLE leads ADD COLUMN not_demand_ts INTEGER DEFAULT 0");
      // Remoção MANUAL e persistente do selo "Assinado" (1 = removido à mão).
      // Quando 1, o lead nunca é re-marcado como assinado pela varredura de e-mails.
      if (!cols.find(c => c.name === 'signed_override')) db.run("ALTER TABLE leads ADD COLUMN signed_override INTEGER DEFAULT 0");
      // Motivo do declínio (mostrado no card). Preenchido pelo auto-declínio (regra 1.3b) e
      // também utilizável quando o motivo é definido manualmente.
      if (!cols.find(c => c.name === 'decline_reason')) db.run("ALTER TABLE leads ADD COLUMN decline_reason TEXT DEFAULT NULL");
      // Timestamp (ms) da ÚLTIMA mensagem recebida DO CLIENTE — PERSISTENTE (não é zerado quando nós
      // respondemos). Usado para ordenar TODAS as colunas por antiguidade da mensagem do cliente.
      if (!cols.find(c => c.name === 'last_client_ts')) db.run("ALTER TABLE leads ADD COLUMN last_client_ts INTEGER DEFAULT 0");
    }
  });

  // Safe migration: marca mensagens enviadas pela IA (ai=1) para distinguir de respostas humanas.
  // Usado para limpar a tag "Novo lead" só quando um HUMANO realmente atendeu.
  db.all("PRAGMA table_info(messages)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'ai')) {
      db.run("ALTER TABLE messages ADD COLUMN ai INTEGER DEFAULT 0");
    }
  });

  // Safe migration: add 'contract_signed' (1 = cliente assinou o contrato; detectado por e-mail).
  // Estado PERSISTENTE no lead → o selo "✔ Assinado" aparece em todo refresh, sem depender de cache volátil.
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'contract_signed')) {
      db.run("ALTER TABLE leads ADD COLUMN contract_signed INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) console.error("Failed to add contract_signed column to leads:", alterErr);
      });
    }
  });

  // Safe migration: add 'payment_proof' (caminho do comprovante de pagamento anexado ao lead).
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'payment_proof')) {
      db.run("ALTER TABLE leads ADD COLUMN payment_proof TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) console.error("Failed to add payment_proof column to leads:", alterErr);
      });
    }
  });

  // Safe migration: add 'followup_date' (data de verificação do follow-up; só usada na col 2 do Tratamento).
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'followup_date')) {
      db.run("ALTER TABLE leads ADD COLUMN followup_date TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) console.error("Failed to add followup_date column to leads:", alterErr);
      });
    }
  });

  // Safe migration: tipo de WhatsApp por usuário (Pré/Pós/Ambos) — filtra o inbox do Vendedor.
  db.all("PRAGMA table_info(users)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'wa_type')) {
      db.run("ALTER TABLE users ADD COLUMN wa_type TEXT DEFAULT 'ambos'", (alterErr) => {
        if (alterErr) console.error("Failed to add wa_type column to users:", alterErr);
      });
    }
  });

  // Safe migration: 'pos_stage' = coluna do pipeline PÓS-VENDA (ambiente do 2030). Independente do
  // 'stage' (pré-venda). Valores: vendas_concretizadas | para_classificar | visto_americano |
  // visto_canadense | visto_portugues | aire_italiano | outros.
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'pos_stage')) {
      db.run("ALTER TABLE leads ADD COLUMN pos_stage TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) console.error("Failed to add pos_stage column to leads:", alterErr);
        else console.log("Migration: added 'pos_stage' column to leads table.");
      });
    }
  });

  // Safe migration: 'bridge' = card na COLUNA-PONTE ("Comunicação com ambiente Pré/Pós-Venda"). É uma
  // flag dedicada (1/0) em vez de sobrescrever stage/pos_stage — assim o card preserva a coluna de
  // origem e, ao SAIR da ponte por qualquer lado, some da ponte nos DOIS ambientes (bridge=0).
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'bridge')) {
      db.run("ALTER TABLE leads ADD COLUMN bridge INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) { console.error("Failed to add bridge column to leads:", alterErr); return; }
        console.log("Migration: added 'bridge' column to leads table.");
        // Migra os leads que já estavam na ponte (modelo antigo, pipeline217): marca bridge=1 e tira
        // o valor-ponte de stage/pos_stage p/ manter o invariante (bridge=0 nunca tem valor-ponte).
        db.run("UPDATE leads SET bridge = 1 WHERE stage = 'clientes_antigos' OR pos_stage = 'clientes_antigos_pos'", () => {
          db.run("UPDATE leads SET stage = 'convertida' WHERE bridge = 1 AND stage = 'clientes_antigos'");
          db.run("UPDATE leads SET pos_stage = NULL WHERE bridge = 1 AND pos_stage = 'clientes_antigos_pos'");
        });
      });
    }
  });

  // Migração das COLUNAS PÓS-VENDA (pedido do Henry 2026-06-27): os grupos de visto passaram a ter
  // várias colunas. Mapeia os pos_stage ANTIGOS (1 coluna por visto) para a 1ª coluna nova de cada
  // grupo. Americano: todas as 3 antigas → a 1ª coluna nova (agendamento). Idempotente.
  db.run("UPDATE leads SET pos_stage = 'visto_amer_agendamento' WHERE pos_stage IN ('visto_amer_validacao', 'visto_amer_envio')");
  db.run("UPDATE leads SET pos_stage = 'visto_cana_formulario' WHERE pos_stage = 'visto_canadense'");
  db.run("UPDATE leads SET pos_stage = 'visto_port_formulario' WHERE pos_stage = 'visto_portugues'");
  db.run("UPDATE leads SET pos_stage = 'visto_aust_formulario' WHERE pos_stage = 'visto_australiano'");
  db.run("UPDATE leads SET pos_stage = 'visto_mex_formulario'  WHERE pos_stage = 'visto_mexicano'");
  db.run("UPDATE leads SET pos_stage = 'ital_formulario'       WHERE pos_stage = 'aire_italiano'");

  // Safe migration: 'client_dir' = link do diretório/pasta do cliente (mostrado no modal do PÓS-VENDA
  // como hiperlink). Adicionado 2026-06-27.
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'client_dir')) {
      db.run("ALTER TABLE leads ADD COLUMN client_dir TEXT DEFAULT NULL", (e2) => {
        if (e2) console.error("Failed to add client_dir column to leads:", e2);
        else console.log("Migration: added 'client_dir' column to leads table.");
      });
    }
  });

  // Seed do usuário do AMBIENTE PÓS-VENDA (Alexandre). Idempotente (INSERT OR IGNORE por id/email).
  // wa_type='pos' → vê apenas o 2030 e o pipeline pós-venda. Pedido explícito do Henry.
  try {
    const alexHash = bcrypt.hashSync('ValeVisto@12', 10);
    db.run(
      "INSERT OR IGNORE INTO users (id, email, password_hash, name, role, avatar, wa_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ['u_alexandre', 'alexandre@valevisto.com.br', alexHash, 'Alexandre', 'Vendedor', 'AL', 'pos'],
      (e) => {
        if (e) console.error("Seed Alexandre falhou:", e);
        // Garante wa_type='pos' mesmo se o usuário já existia com outro tipo.
        db.run("UPDATE users SET wa_type='pos' WHERE email='alexandre@valevisto.com.br'");
      }
    );
  } catch (e) { console.error("Seed Alexandre erro:", e && e.message); }

  // Log de cada disparo de follow-up automático (col 3-4 do Tratamento) — para o gráfico diário.
  db.run(`CREATE TABLE IF NOT EXISTS followup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    lead_id TEXT,
    lead_name TEXT
  )`, (e1) => {
    if (e1) { console.error("Failed to create followup_log:", e1); return; }
    db.run("CREATE INDEX IF NOT EXISTS idx_followup_log_ts ON followup_log(ts)");
    // Backfill ÚNICO (só se a tabela estiver vazia): aproxima o histórico usando o ÚLTIMO
    // disparo de cada lead (ai_fu_last). Contagens passadas são aproximadas; daqui pra frente
    // cada disparo é registrado individualmente (exato).
    db.get("SELECT COUNT(*) AS n FROM followup_log", (e2, row) => {
      if (e2 || (row && row.n > 0)) return;
      db.run("INSERT INTO followup_log (ts, lead_id, lead_name) SELECT ai_fu_last, id, name FROM leads WHERE ai_fu_last IS NOT NULL AND ai_fu_last > 0", (e3) => {
        if (e3) console.error("followup_log backfill falhou:", e3);
        else console.log("followup_log: backfill inicial (último disparo por lead) concluído.");
      });
    });
  });

  // Log dos bloqueios do filtro anti-invenção da IA (preço/@/link) — para o resumo diário.
  db.run(`CREATE TABLE IF NOT EXISTS ai_guardrail_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT,
    sample TEXT
  )`, (e) => {
    if (e) { console.error("Failed to create ai_guardrail_log:", e); return; }
    db.run("CREATE INDEX IF NOT EXISTS idx_ai_guardrail_log_ts ON ai_guardrail_log(ts)");
  });

  // Safe migration: add 'tracking' (rastreamento de marketing: UTMs, gclid, fbclid)
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'tracking')) {
      db.run("ALTER TABLE leads ADD COLUMN tracking TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) console.error("Failed to add tracking column to leads:", alterErr);
        else console.log("Migration: added 'tracking' column to leads table.");
      });
    }
  });

  // Safe migration: add 'recv_number' (nosso número que RECEBEU o lead, carimbado
  // na hora da mensagem) — assim o card mostra sempre o número certo, mesmo que o
  // número troque de slot depois.
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'recv_number')) {
      db.run("ALTER TABLE leads ADD COLUMN recv_number TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add recv_number column to leads:", alterErr);
        } else {
          console.log("Migration: added 'recv_number' column to leads table.");
        }
      });
    }
  });

  // Unconditional migration: update stages to new pipeline phases (Novo Leads, Tratamento inicial, Proposta enviada, Follow-up pagamento, Lead declinou/cancelado)
  db.serialize(() => {
    console.log("Migration: sync stages to new 5-column pipeline...");
    db.run("DELETE FROM stages");
    const newStages = [
      ["novo",           "Novo Leads",               "#71717a"],
      ["tratamento",     "Tratamento inicial",       "#0ea5e9"],
      ["proposta",       "Proposta enviada",         "#f59e0b"],
      ["followup",       "Follow-up pagamento",      "#ec4899"],
      ["declinado",      "Lead declinou/cancelado",  "#ef4444"]
    ];
    const stmt = db.prepare("INSERT OR REPLACE INTO stages VALUES (?, ?, ?)");
    newStages.forEach(s => stmt.run(s));
    stmt.finalize();

    // Migrate existing leads to fit the new stage IDs:
    db.run("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
    db.run("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
    // ATENÇÃO: 'convertida' e 'clientes_antigos' PRECISAM estar nesta lista. Sem elas, todo restart
    // do backend resetava esses leads para 'novo' (sumiam da coluna). BUG corrigido.
    db.run("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'convertida', 'declinado', 'clientes_antigos')");
  });

  // Safe migration: add 'type' column to messages (text | audio | image | other)
  db.all("PRAGMA table_info(messages)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'type')) {
      db.run("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'", (alterErr) => {
        if (alterErr) console.error("Failed to add type column to messages:", alterErr);
        else console.log("Migration: added 'type' column to messages table.");
      });
    }
  });

  // Safe migration: add 'status' column to messages (status de entrega do WhatsApp p/ os ticks).
  // 2 = enviado (1 tick), 3 = entregue (2 ticks), 4+ = lido (2 ticks azuis).
  db.all("PRAGMA table_info(messages)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'status')) {
      db.run("ALTER TABLE messages ADD COLUMN status INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) console.error("Failed to add status column to messages:", alterErr);
      });
    }
  });

  // Safe migration: add 'mediaPath' column to messages (filesystem path for audio/media)
  db.all("PRAGMA table_info(messages)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'mediaPath')) {
      db.run("ALTER TABLE messages ADD COLUMN mediaPath TEXT DEFAULT NULL", (alterErr) => {
        if (alterErr) console.error("Failed to add mediaPath column to messages:", alterErr);
        else console.log("Migration: added 'mediaPath' column to messages table.");
      });
    }
  });

  // Safe migration: colunas 'edited' e 'deleted' em messages (editar/apagar mensagens enviadas)
  db.all("PRAGMA table_info(messages)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'edited')) {
      db.run("ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0", (e) => {
        if (e) console.error("Failed to add edited column to messages:", e);
        else console.log("Migration: added 'edited' column to messages table.");
      });
    }
  });
  db.all("PRAGMA table_info(messages)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'deleted')) {
      db.run("ALTER TABLE messages ADD COLUMN deleted INTEGER DEFAULT 0", (e) => {
        if (e) console.error("Failed to add deleted column to messages:", e);
        else console.log("Migration: added 'deleted' column to messages table.");
      });
    }
  });

  // Safe migration: add 'archived' column to conversations if it doesn't exist yet
  db.all("PRAGMA table_info(conversations)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'archived')) {
      db.run("ALTER TABLE conversations ADD COLUMN archived INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add archived column to conversations:", alterErr);
        } else {
          console.log("Migration: added 'archived' column to conversations table.");
        }
      });
    }
  });

  // Safe migration: add 'whatsapp_jid' column to leads if it doesn't exist yet
  db.all("PRAGMA table_info(leads)", (err, cols) => {
    if (!err && cols) {
      const hasJid = cols.find(c => c.name === 'whatsapp_jid');
      if (!hasJid) {
        db.run("ALTER TABLE leads ADD COLUMN whatsapp_jid TEXT DEFAULT NULL", (alterErr) => {
          if (!alterErr) {
            console.log("Migration: added 'whatsapp_jid' column to leads table.");
            runLeadsCleanups();
          }
        });
      } else {
        runLeadsCleanups();
      }
    }
  });

  function runLeadsCleanups() {
    db.run("UPDATE leads SET whatsapp_jid = phone WHERE phone LIKE '%@%' AND (whatsapp_jid IS NULL OR whatsapp_jid = '')");
    db.run("UPDATE leads SET phone = '' WHERE phone LIKE '%@%'");
    db.all("SELECT id, phone FROM leads WHERE phone LIKE '%@s.whatsapp%'", (selErr, rows) => {
      if (!selErr && rows) {
        rows.forEach(r => {
          const digits = r.phone.split('@')[0].replace(/\D/g, '');
          let formatted = '+' + digits;
          if (digits.startsWith('55') && digits.length >= 12) {
            formatted = `+55 ${digits.slice(2, 4)} ${digits.slice(4, -4)}-${digits.slice(-4)}`;
          }
          db.run("UPDATE leads SET phone = ? WHERE id = ?", [formatted, r.id]);
        });
      }
    });
    // Fix specific leads
    db.run("UPDATE leads SET phone = '+55 12 98284-0157' WHERE id = 'l_92i9bqbvg' AND (phone = '' OR phone IS NULL)");
    db.run("UPDATE leads SET phone = '+55 12 98317-6000' WHERE id = 'l_zfe33v8mt' AND (phone = '' OR phone IS NULL)");
  }

  // Safe migration: add 'whatsapp_jid' column to conversations if it doesn't exist yet
  db.all("PRAGMA table_info(conversations)", (err, cols) => {
    if (!err && cols) {
      const hasJid = cols.find(c => c.name === 'whatsapp_jid');
      if (!hasJid) {
        db.run("ALTER TABLE conversations ADD COLUMN whatsapp_jid TEXT DEFAULT NULL", (alterErr) => {
          if (!alterErr) {
            console.log("Migration: added 'whatsapp_jid' column to conversations table.");
            runConversationsCleanups();
          }
        });
      } else {
        runConversationsCleanups();
      }
    }
  });

  function runConversationsCleanups() {
    db.run("UPDATE conversations SET whatsapp_jid = phone WHERE phone LIKE '%@%' AND (whatsapp_jid IS NULL OR whatsapp_jid = '')");
    db.run("UPDATE conversations SET phone = '' WHERE phone LIKE '%@%'");
    db.run("UPDATE conversations SET phone = '+55 12 98284-0157' WHERE whatsapp_jid = '117617763291159@lid' AND (phone = '' OR phone IS NULL)");
    db.run("UPDATE conversations SET phone = '+55 12 98317-6000' WHERE whatsapp_jid = '278516415348907@lid' AND (phone = '' OR phone IS NULL)");
  }


  db.get("SELECT COUNT(*) as count FROM messages", (err, row) => {
    if (row && row.count === 0) {
      const initialMessages = [];
      const stmt = db.prepare("INSERT INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)");
      initialMessages.forEach(m => stmt.run(m));
      stmt.finalize();
    }
  });

  // ── Backfill ÚNICO: aplica a regra de origem "Google Ads" aos cards JÁ existentes.
  // Para cada lead, olha a PRIMEIRA mensagem recebida do cliente; se ela começa com a
  // frase do site (isGoogleAdsFirstMsg), reclassifica source = 'Google Ads'. Mesma regra
  // que passa a valer na criação (whatsapp.js). Guard por flag em app_settings → roda
  // só uma vez por base, para não sobrescrever ajustes manuais em deploys futuros.
  db.get("SELECT value FROM app_settings WHERE key = 'src_google_ads_backfill_v1'", (gErr, gRow) => {
    if (gErr) { console.error("Backfill Google Ads: erro ao ler flag:", gErr.message); return; }
    if (gRow) return; // já rodou nesta base
    db.all("SELECT id, source, whatsapp_jid, phone FROM leads", (lErr, leads) => {
      if (lErr) { console.error("Backfill Google Ads: erro ao ler leads:", lErr.message); return; }
      db.all("SELECT id, whatsapp_jid, phone FROM conversations", (cErr, convs) => {
        if (cErr) { console.error("Backfill Google Ads: erro ao ler conversations:", cErr.message); return; }
        const last8 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : ''; };
        // Índices p/ casar lead → conversa (mesma lógica de dedup usada no WhatsApp: jid e últimos 8 dígitos)
        const byJid = new Map(), byL8 = new Map();
        convs.forEach(c => {
          if (c.whatsapp_jid) byJid.set(c.whatsapp_jid, c.id);
          const l8 = last8(c.phone) || last8(c.whatsapp_jid);
          if (l8 && !byL8.has(l8)) byL8.set(l8, c.id);
        });
        const firstThemMsg = (convId) => new Promise((resolve) => {
          db.get("SELECT text FROM messages WHERE conversationId = ? AND `from` = 'them' ORDER BY timestamp ASC LIMIT 1",
            [convId], (e, r) => resolve(e ? null : (r && r.text)));
        });
        (async () => {
          try {
            const toFix = [];
            for (const ld of leads) {
              if (ld.source === 'Google Ads') continue; // já classificado
              let convId = ld.whatsapp_jid ? byJid.get(ld.whatsapp_jid) : null;
              if (!convId) { const l8 = last8(ld.phone) || last8(ld.whatsapp_jid); if (l8) convId = byL8.get(l8); }
              if (!convId) continue;
              const t = await firstThemMsg(convId);
              if (isGoogleAdsFirstMsg(t)) toFix.push(ld.id);
            }
            if (toFix.length) {
              const ph = toFix.map(() => '?').join(',');
              db.run(`UPDATE leads SET source = 'Google Ads' WHERE id IN (${ph})`, toFix, (uErr) => {
                if (uErr) console.error("Backfill Google Ads: erro no UPDATE:", uErr.message);
                else console.log(`Backfill Google Ads: ${toFix.length} card(s) reclassificados como origem 'Google Ads'.`);
              });
            } else {
              console.log("Backfill Google Ads: nenhum card antigo correspondente à frase do site.");
            }
            db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('src_google_ads_backfill_v1', ?)", [new Date().toISOString()]);
          } catch (e) {
            console.error("Backfill Google Ads: falha inesperada:", e && e.message);
          }
        })();
      });
    });
  });

  // ── Backfill ÚNICO: classifica origem "Google Ads" nos leads cujo rastreamento (tracking) tem
  // utm_source = Google Ads. Mesma regra do endpoint /api/integrations/lead. Guard por flag → 1x por base.
  db.get("SELECT value FROM app_settings WHERE key = 'src_google_ads_utm_backfill_v1'", (gErr, gRow) => {
    if (gErr) { console.error("Backfill UTM Google Ads: erro ao ler flag:", gErr.message); return; }
    if (gRow) return; // já rodou nesta base
    db.all("SELECT id, source, tracking FROM leads WHERE tracking IS NOT NULL AND TRIM(tracking) <> ''", (lErr, rows) => {
      if (lErr) { console.error("Backfill UTM Google Ads: erro ao ler leads:", lErr.message); return; }
      const toFix = (rows || []).filter(r => r.source !== 'Google Ads' && isGoogleAdsUtm(r.tracking)).map(r => r.id);
      if (toFix.length) {
        const ph = toFix.map(() => '?').join(',');
        db.run(`UPDATE leads SET source = 'Google Ads' WHERE id IN (${ph})`, toFix, (uErr) => {
          if (uErr) console.error("Backfill UTM Google Ads: erro no UPDATE:", uErr.message);
          else console.log(`Backfill UTM Google Ads: ${toFix.length} lead(s) reclassificados por utm_source.`);
        });
      } else {
        console.log("Backfill UTM Google Ads: nenhum lead com utm_source Google Ads.");
      }
      db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('src_google_ads_utm_backfill_v1', ?)", [new Date().toISOString()]);
    });
  });
});

// Helper functions for promise based database calls
const runQuery = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const getRow = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const allRows = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

module.exports = {
  db,
  runQuery,
  getRow,
  allRows,
  isGoogleAdsFirstMsg,
  GOOGLE_ADS_FIRST_MSG,
  isGoogleAdsUtm,
  extractAdParams
};
