const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { runQuery, getRow, allRows } = require('./db');

const sessions = {};
const sessionQrs = {};

const customLogger = {
  level: 'debug',
  child: () => customLogger,
  trace: (obj, msg, ...args) => console.log('[Baileys TRACE]', msg || (typeof obj === 'string' ? obj : JSON.stringify(obj)), ...args),
  debug: (obj, msg, ...args) => console.log('[Baileys DEBUG]', msg || (typeof obj === 'string' ? obj : JSON.stringify(obj)), ...args),
  info: (obj, msg, ...args) => console.log('[Baileys INFO]', msg || (typeof obj === 'string' ? obj : JSON.stringify(obj)), ...args),
  warn: (obj, msg, ...args) => console.warn('[Baileys WARN]', msg || (typeof obj === 'string' ? obj : JSON.stringify(obj)), ...args),
  error: (obj, msg, ...args) => console.error('[Baileys ERROR]', msg || (typeof obj === 'string' ? obj : JSON.stringify(obj)), ...args)
};
const logger = customLogger;

function sanitizePhoneNumber(phone) {
  // Strip all non-digit characters
  let cleaned = phone.replace(/\D/g, '');
  // If Brazilian number without country code, prepend 55
  if (cleaned.length === 11 && (cleaned.startsWith('1') || cleaned.startsWith('2') || cleaned.startsWith('3') || cleaned.startsWith('4') || cleaned.startsWith('5') || cleaned.startsWith('6') || cleaned.startsWith('7') || cleaned.startsWith('8') || cleaned.startsWith('9'))) {
    cleaned = '55' + cleaned;
  }
  return cleaned;
}

const connectionRetries = {};

async function connectWhatsApp(id, isReconnect = false) {
  if (sessions[id]) {
    const sock = sessions[id];
    // Return status
    return {
      id,
      status: sock.ws.isOpen ? 'connected' : 'connecting',
      qr: sessionQrs[id] || null
    };
  }

  if (!isReconnect) {
    connectionRetries[id] = 0;
  }

  const sessionDir = path.join(__dirname, 'sessions', id);
  // Ensure sessions dir exists
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log(`Using latest Baileys version: ${version.join('.')}, isLatest: ${latest.isLatest}`);
  } catch (err) {
    console.warn("Failed to fetch latest Baileys version, using fallback", err);
  }

  const sock = makeWASocket({
    auth: state,
    logger,
    version,
    printQRInTerminal: false
  });

  sessions[id] = sock;
  sessionQrs[id] = null;

  // Set status in DB
  await runQuery("UPDATE whatsapp_accounts SET status = ?, connect_at = ? WHERE id = ?", ['connecting', new Date().toISOString(), id]);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Convert QR to base64
      try {
        const qrBase64 = await QRCode.toDataURL(qr);
        sessionQrs[id] = qrBase64;
      } catch (err) {
        console.error("Error generating QR code:", err);
      }
    }

    if (connection === 'open') {
      console.log(`WhatsApp Account ${id} Connected!`);
      sessionQrs[id] = null;
      connectionRetries[id] = 0;
      
      // Get own number
      const userJid = sock.user.id;
      const userNumber = userJid.split(':')[0];

      await runQuery(
        "UPDATE whatsapp_accounts SET status = ?, number = ?, connect_at = ? WHERE id = ?",
        ['connected', '+' + userNumber, new Date().toISOString(), id]
      );
    }

    if (connection === 'close') {
      const isAuthenticated = !!state.creds?.me;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      
      let shouldReconnect = false;
      if (isAuthenticated) {
        shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      } else {
        const retries = connectionRetries[id] || 0;
        if (retries < 5 && statusCode !== DisconnectReason.loggedOut) {
          shouldReconnect = true;
          connectionRetries[id] = retries + 1;
        }
      }
      
      console.log(`Connection closed for ${id}. Authenticated: ${isAuthenticated}. Status Code: ${statusCode}. Retry count: ${connectionRetries[id]}. Reconnecting: ${shouldReconnect}`);
      
      try {
        sock.end();
      } catch (e) {
        // ignore
      }
      
      delete sessions[id];
      delete sessionQrs[id];

      if (shouldReconnect) {
        // Try reconnecting in 5 seconds
        setTimeout(() => connectWhatsApp(id, true), 5000);
      } else {
        // Logged out or not authenticated: Clear session folder and set disconnected in DB
        await runQuery("UPDATE whatsapp_accounts SET status = ? WHERE id = ?", ['disconnected', id]);
        if (!isAuthenticated || statusCode === DisconnectReason.loggedOut) {
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (e) {
            console.error("Error clearing session folder:", e);
          }
        }
        delete connectionRetries[id];
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async (m) => {
    try {
      console.log(`[WhatsApp ${id}] messages.upsert event received, type: ${m.type}, count: ${m.messages ? m.messages.length : 0}`);
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        console.log(`[WhatsApp ${id}] Processing message:`, JSON.stringify(msg));
        if (msg.key.fromMe) {
          console.log(`[WhatsApp ${id}] Ignored outgoing message from self.`);
          continue; // ignore outgoing messages
        }

        const fromJid = msg.key.remoteJid;
        if (!fromJid.endsWith('@s.whatsapp.net') && !fromJid.endsWith('@lid')) {
          console.log(`[WhatsApp ${id}] Ignored message from JID: ${fromJid} (not a user)`);
          continue; // ignore groups/broadcasts
        }

        const phone = fromJid.endsWith('@lid') ? fromJid : '+' + fromJid.split('@')[0];
        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Mídia/Outro]";
        const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const name = msg.pushName || (fromJid.endsWith('@lid') ? 'Usuário WhatsApp' : phone);

        console.log(`[WhatsApp ${id}] Message details: phone=${phone}, name=${name}, text="${text}"`);

        // Find or create conversation
        let convo = await getRow("SELECT * FROM conversations WHERE phone = ?", [phone]);
        let convoId;

        if (convo) {
          convoId = convo.id;
          console.log(`[WhatsApp ${id}] Existing conversation found: convoId=${convoId}`);
          // Update conversation
          await runQuery(
            "UPDATE conversations SET lastTime = ?, unread = unread + 1 WHERE id = ?",
            [timeStr, convoId]
          );
        } else {
          // Generate new conversation id
          convoId = 'c_' + Math.random().toString(36).substr(2, 9);
          console.log(`[WhatsApp ${id}] No conversation found. Creating new one with convoId=${convoId}`);
          const avatar = name.slice(0, 2).toUpperCase();
          await runQuery(
            "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [convoId, id, name, phone, avatar, timeStr, 1, 0]
          );
        }

        // Add message
        const msgId = msg.key.id || 'm_' + Math.random().toString(36).substr(2, 9);
        console.log(`[WhatsApp ${id}] Saving message to DB: msgId=${msgId}, convoId=${convoId}`);
        await runQuery(
          "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
          [msgId, convoId, 'them', text, timeStr, msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now()]
        );

        // Check if phone matches any lead (active OR archived); if archived, restore it
        const searchNumber = fromJid.split('@')[0];
        let lead = await getRow("SELECT * FROM leads WHERE phone LIKE ?", [`%${searchNumber}%`]);
        if (!lead) {
          const leadId = 'l_' + Math.random().toString(36).substr(2, 9);
          const createdAt = new Date().toISOString().slice(0, 10);
          let formattedPhone = phone;
          if (!fromJid.endsWith('@lid') && phone.startsWith('+55') && phone.length === 14) {
            formattedPhone = `+55 ${phone.slice(3, 5)} ${phone.slice(5, 10)}-${phone.slice(10)}`;
          }
          console.log(`[WhatsApp ${id}] No lead found for ${phone}. Creating new lead: leadId=${leadId}`);
          await runQuery(
            "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [leadId, name, "", formattedPhone, "", 0, "novo", "Venda", id, "Rafael Andrade", JSON.stringify([]), createdAt, 0]
          );
        } else if (lead.archived === 1) {
          // Lead was archived — restore it automatically since they reached out again
          console.log(`[WhatsApp ${id}] Archived lead ${lead.name} sent a new message. Restoring automatically.`);
          await runQuery("UPDATE leads SET archived = 0 WHERE id = ?", [lead.id]);
          // Restore their conversation too
          const cleanPhone = phone.replace(/\D/g, '');
          if (cleanPhone.length >= 8) {
            await runQuery(
              "UPDATE conversations SET archived = 0 WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, '+',''), ' ',''), '-',''), '(','') LIKE ?",
              [`%${cleanPhone.slice(-8)}%`]
            );
          }
        } else {
          console.log(`[WhatsApp ${id}] Received message from existing lead: ${lead.name}`);
        }
      }
    } catch (err) {
      console.error(`[WhatsApp ${id}] Error in messages.upsert handler:`, err);
    }
  });

  return {
    id,
    status: 'connecting',
    qr: null
  };
}

async function disconnectWhatsApp(id) {
  console.log(`Disconnecting WhatsApp Account ${id}`);
  const sock = sessions[id];
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      // ignore
    }
    try {
      sock.end();
    } catch (e) {
      // ignore
    }
  }

  delete sessions[id];
  delete sessionQrs[id];

  await runQuery("UPDATE whatsapp_accounts SET status = ?, connect_at = NULL WHERE id = ?", ['disconnected', id]);

  // Delete credentials directory to reset QR code
  const sessionDir = path.join(__dirname, 'sessions', id);
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch (e) {
    // ignore
  }

  return { id, status: 'disconnected' };
}

async function sendWhatsAppMessage(accountId, convoId, text) {
  const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
  if (!convo) throw new Error("Conversation not found");

  const jid = convo.phone.includes('@') ? convo.phone : `${sanitizePhoneNumber(convo.phone)}@s.whatsapp.net`;
  
  const sock = sessions[accountId];
  if (!sock) {
    throw new Error("WhatsApp account not connected");
  }

  // Send message
  const sent = await sock.sendMessage(jid, { text });
  
  const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const msgId = sent.key.id || 'm_' + Math.random().toString(36).substr(2, 9);
  
  // Insert into DB
  await runQuery(
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
    [msgId, convoId, 'me', text, timeStr, Date.now()]
  );

  // Update conversation lastMessage
  await runQuery(
    "UPDATE conversations SET lastTime = ? WHERE id = ?",
    [timeStr, convoId]
  );

  return {
    id: msgId,
    from: 'me',
    text,
    time: timeStr
  };
}

// Auto reconnect active sessions on startup
async function initSessions() {
  const connectedAccounts = await allRows("SELECT id FROM whatsapp_accounts WHERE status = 'connected'");
  for (const acc of connectedAccounts) {
    console.log(`Auto connecting WhatsApp session for ${acc.id}`);
    connectWhatsApp(acc.id).catch(e => console.error(`Failed auto connect for ${acc.id}:`, e));
  }
}

module.exports = {
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  initSessions,
  sessions,
  sessionQrs
};
