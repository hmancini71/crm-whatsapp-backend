const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(DB_PATH);

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
        ["clientes_antigos", "Clientes antigos",       "#6366f1"]
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
        ["wa4", "Vendas", "", "#ea580c", "disconnected", 0, null]
      ];
      const stmt = db.prepare("INSERT INTO whatsapp_accounts VALUES (?, ?, ?, ?, ?, ?, ?)");
      initialAccounts.forEach(a => stmt.run(a));
      stmt.finalize();
    }
  });

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
  allRows
};
