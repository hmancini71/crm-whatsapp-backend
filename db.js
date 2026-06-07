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
        ["declinado",      "Lead declinou/cancelado",  "#ef4444"]
      ];
      const stmt = db.prepare("INSERT INTO stages VALUES (?, ?, ?)");
      initialStages.forEach(s => stmt.run(s));
      stmt.finalize();
    }
  });

  db.get("SELECT COUNT(*) as count FROM whatsapp_accounts", (err, row) => {
    if (row && row.count === 0) {
      const initialAccounts = [
        ["wa1", "Comercial", "", "#0d9488", "disconnected", 0, null],
        ["wa2", "Suporte", "", "#2563eb", "disconnected", 0, null],
        ["wa3", "Vendas", "", "#7c3aed", "disconnected", 0, null],
        ["wa4", "Financeiro", "", "#ea580c", "disconnected", 0, null]
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
    const stmt = db.prepare("INSERT INTO stages VALUES (?, ?, ?)");
    newStages.forEach(s => stmt.run(s));
    stmt.finalize();

    // Migrate existing leads to fit the new stage IDs:
    db.run("UPDATE leads SET stage = 'tratamento' WHERE stage = 'qualificado'");
    db.run("UPDATE leads SET stage = 'followup' WHERE stage = 'fechado'");
    db.run("UPDATE leads SET stage = 'novo' WHERE stage NOT IN ('novo', 'tratamento', 'proposta', 'followup', 'declinado')");
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
    if (!err && cols && !cols.find(c => c.name === 'whatsapp_jid')) {
      db.run("ALTER TABLE leads ADD COLUMN whatsapp_jid TEXT DEFAULT NULL", (alterErr) => {
        if (!alterErr) {
          console.log("Migration: added 'whatsapp_jid' column to leads table.");
          db.run("UPDATE leads SET whatsapp_jid = phone WHERE phone LIKE '%@%'");
          db.run("UPDATE leads SET phone = '' WHERE phone LIKE '%@lid%'");
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
        }
      });
    }
  });

  // Safe migration: add 'whatsapp_jid' column to conversations if it doesn't exist yet
  db.all("PRAGMA table_info(conversations)", (err, cols) => {
    if (!err && cols && !cols.find(c => c.name === 'whatsapp_jid')) {
      db.run("ALTER TABLE conversations ADD COLUMN whatsapp_jid TEXT DEFAULT NULL", (alterErr) => {
        if (!alterErr) {
          console.log("Migration: added 'whatsapp_jid' column to conversations table.");
          db.run("UPDATE conversations SET whatsapp_jid = phone WHERE phone LIKE '%@%'");
        }
      });
    }
  });

  // Unconditional database cleanup on start to move any remaining JIDs to whatsapp_jid and clean up the phone column
  db.run("UPDATE leads SET whatsapp_jid = phone WHERE phone LIKE '%@%' AND (whatsapp_jid IS NULL OR whatsapp_jid = '')");
  db.run("UPDATE leads SET phone = '' WHERE phone LIKE '%@%'");
  db.run("UPDATE conversations SET whatsapp_jid = phone WHERE phone LIKE '%@%' AND (whatsapp_jid IS NULL OR whatsapp_jid = '')");
  db.run("UPDATE conversations SET phone = '' WHERE phone LIKE '%@%'");

  // Fix specific leads where phone was not resolved previously (using remoteJidAlt values from logs)
  db.run("UPDATE leads SET phone = '+55 12 98284-0157' WHERE id = 'l_92i9bqbvg' AND (phone = '' OR phone IS NULL)");
  db.run("UPDATE conversations SET phone = '+55 12 98284-0157' WHERE whatsapp_jid = '117617763291159@lid' AND (phone = '' OR phone IS NULL)");
  db.run("UPDATE leads SET phone = '+55 12 98317-6000' WHERE id = 'l_zfe33v8mt' AND (phone = '' OR phone IS NULL)");
  db.run("UPDATE conversations SET phone = '+55 12 98317-6000' WHERE whatsapp_jid = '278516415348907@lid' AND (phone = '' OR phone IS NULL)");


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
