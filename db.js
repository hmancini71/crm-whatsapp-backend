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
        ["novo", "Novo Lead", "#64748b"],
        ["contato", "Em Contato", "#0ea5e9"],
        ["qualificado", "Qualificado", "#8b5cf6"],
        ["proposta", "Proposta Enviada", "#f59e0b"],
        ["negociacao", "Negociação", "#ec4899"],
        ["fechado", "Fechado / Ganho", "#16a34a"]
      ];
      const stmt = db.prepare("INSERT INTO stages VALUES (?, ?, ?)");
      initialStages.forEach(s => stmt.run(s));
      stmt.finalize();
    }
  });

  db.get("SELECT COUNT(*) as count FROM whatsapp_accounts", (err, row) => {
    if (row && row.count === 0) {
      const initialAccounts = [
        ["wa1", "Comercial", "+55 12 98181-8964", "#0d9488", "disconnected", 3, null],
        ["wa2", "Suporte", "+55 12 99711-2030", "#2563eb", "disconnected", 1, null],
        ["wa3", "Vendas", "+55 12 99012-4477", "#7c3aed", "disconnected", 5, null],
        ["wa4", "Financeiro", "+55 12 98890-1122", "#ea580c", "disconnected", 0, null]
      ];
      const stmt = db.prepare("INSERT INTO whatsapp_accounts VALUES (?, ?, ?, ?, ?, ?, ?)");
      initialAccounts.forEach(a => stmt.run(a));
      stmt.finalize();
    }
  });

  db.get("SELECT COUNT(*) as count FROM leads", (err, row) => {
    if (row && row.count === 0) {
      const initialLeads = [
        ["l7", "Beatriz Rocha", "BR Moda", "+55 47 99988-7766", "bia@brmoda.com", 2800, "novo", "Facebook Ads", "wa2", "Rafael Andrade", JSON.stringify(["Frio"]), "2026-06-02"],
        ["l1", "Mariana Costa", "Boutique Bella", "+55 12 98765-4321", "mariana@bella.com", 4500, "contato", "Venda", "wa1", "Rafael Andrade", JSON.stringify(["Quente"]), "2026-06-01"],
        ["l8", "Gustavo Nunes", "GN Tech", "+55 11 98877-2211", "gustavo@gntech.com", 21000, "contato", "LinkedIn", "wa3", "Rafael Andrade", JSON.stringify(["Morno"]), "2026-05-30"],
        ["l2", "João Pereira", "JP Construções", "+55 11 91234-5678", "joao@jpconstrucoes.com", 12000, "novo", "Instagram", "wa3", "Rafael Andrade", JSON.stringify(["Morno"]), "2026-05-28"],
        ["l9", "Larissa Dias", "LD Beauty", "+55 21 91122-3344", "larissa@ldbeauty.com", 5400, "qualificado", "Venda", "wa1", "Rafael Andrade", JSON.stringify(["Quente"]), "2026-05-27"],
        ["l3", "Fernanda Lima", "Studio FL", "+55 21 99876-1122", "fe@studiofl.com", 3200, "qualificado", "Google Ads", "wa1", "Rafael Andrade", JSON.stringify(["Quente"]), "2026-05-25"],
        ["l10", "Eduardo Ramos", "ER Logística", "+55 19 99777-8899", "edu@erlog.com", 9900, "proposta", "Indicação", "wa2", "Rafael Andrade", JSON.stringify(["Morno"]), "2026-05-22"],
        ["l4", "Carlos Mendes", "Mendes Auto", "+55 31 98123-9988", "carlos@mendesauto.com", 8800, "proposta", "Indicação", "wa3", "Rafael Andrade", JSON.stringify(["Quente"]), "2026-05-20"],
        ["l12", "Felipe Barros", "FB Fitness", "+55 85 99654-1230", "felipe@fbfitness.com", 7300, "negociacao", "Google Ads", "wa1", "Rafael Andrade", JSON.stringify(["Quente"]), "2026-05-19"],
        ["l5", "Patrício Souza", "PS Eventos", "+55 12 99012-3344", "patricia@pseventos.com", 15500, "negociacao", "Venda", "wa3", "Rafael Andrade", JSON.stringify(["Quente"]), "2026-05-18"],
        ["l6", "Ricardo Alves", "Alves & Cia", "+55 12 98456-7788", "ricardo@alves.com", 6200, "fechado", "Site", "wa1", "Rafael Andrade", JSON.stringify(["Ganho"]), "2026-05-10"],
        ["l11", "Aline Martins", "AM Doces", "+55 12 98321-4567", "aline@amdoces.com", 1800, "fechado", "Venda", "wa3", "Rafael Andrade", JSON.stringify(["Ganho"]), "2026-05-05"]
      ];
      const stmt = db.prepare("INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      initialLeads.forEach(l => stmt.run(l));
      stmt.finalize();
    }
  });

  db.get("SELECT COUNT(*) as count FROM conversations", (err, row) => {
    if (row && row.count === 0) {
      const initialConvs = [
        ["c1", "wa1", "Mariana Costa", "+55 12 98765-4321", "MC", "14:04", 0, 1],
        ["c2", "wa3", "Patrício Souza", "+55 12 99012-3344", "PS", "09:15", 1, 0],
        ["c3", "wa2", "Beatriz Rocha", "+55 47 99988-7766", "BR", "Ontem", 0, 0],
        ["c4", "wa1", "Fernanda Lima", "+55 21 99876-1122", "FL", "Ontem", 1, 1],
        ["c5", "wa3", "Gustavo Nunes", "+55 11 98877-2211", "GN", "Seg", 0, 0],
        ["c6", "wa3", "Carlos Mendes", "+55 31 98123-9988", "CM", "Seg", 2, 0]
      ];
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

  db.get("SELECT COUNT(*) as count FROM messages", (err, row) => {
    if (row && row.count === 0) {
      const initialMessages = [
        ["m1", "c1", "them", "Olá! Vi o anúncio de vocês e gostaria de saber mais sobre os planos.", "09:30", Date.now() - 3600000 * 5],
        ["m2", "c1", "me", "Oi Mariana! Que bom ter você por aqui. Temos planos a partir de R$ 299. Posso te enviar uma proposta?", "09:34", Date.now() - 3600000 * 4.9],
        ["m3", "c1", "them", "Sim, por favor! Pode me mandar os detalhes?", "09:41", Date.now() - 3600000 * 4.8],
        ["m4", "c1", "them", "E também queria saber sobre prazos.", "09:42", Date.now() - 3600000 * 4.7],
        ["m_f7b3e6a4b0", "c1", "me", "Mensagem de teste QA automático", "04:11", Date.now() - 3600000 * 2],
        ["m_09a1aa424c", "c1", "me", "Mensagem de teste QA automático", "14:04", Date.now() - 60000]
      ];
      const stmt = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)");
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
