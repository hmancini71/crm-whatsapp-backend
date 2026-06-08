// Baileys (versao atual, ESM-only) carregado via import() dinamico
let _baileysMod = null;
async function loadBaileys() {
  if (!_baileysMod) { _baileysMod = await import('@whiskeysockets/baileys'); }
  return _baileysMod;
}
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { runQuery, getRow, allRows } = require('./db');

if (ffmpegPath) {
  try { ffmpeg.setFfmpegPath(ffmpegPath); } catch (e) { console.error('ffmpeg path set failed', e); }
}

const sessions = {};
const sessionQrs = {};

// Directory where voice notes / media are stored (ephemeral on Render)
const MEDIA_DIR = path.join(__dirname, 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// Transcode any browser-recorded audio (webm/ogg/mp4) into Opus/OGG for WhatsApp PTT
function transcodeToOpusOgg(inputBuffer) {
  return new Promise((resolve, reject) => {
    const stamp = Date.now() + '_' + Math.random().toString(36).slice(2);
    const tmpIn = path.join(MEDIA_DIR, 'in_' + stamp);
    const tmpOut = path.join(MEDIA_DIR, 'out_' + stamp + '.ogg');
    try { fs.writeFileSync(tmpIn, inputBuffer); } catch (e) { return reject(e); }
    ffmpeg(tmpIn)
      .audioCodec('libopus')
      .audioBitrate('32k')
      .audioChannels(1)
      .audioFrequency(48000)
      .format('ogg')
      .on('end', () => {
        try {
          const buf = fs.readFileSync(tmpOut);
          resolve(buf);
        } catch (e) { reject(e); }
        finally {
          try { fs.unlinkSync(tmpIn); } catch (e) {}
          try { fs.unlinkSync(tmpOut); } catch (e) {}
        }
      })
      .on('error', (err) => {
        try { fs.unlinkSync(tmpIn); } catch (e) {}
        try { fs.unlinkSync(tmpOut); } catch (e) {}
        reject(err);
      })
      .save(tmpOut);
  });
}

// Logger pino real (compativel com o Baileys novo) - nivel 'warn' p/ menos ruido
const logger = pino({ level: 'warn' });

function sanitizePhoneNumber(phone) {
  // Strip all non-digit characters
  let cleaned = phone.replace(/\D/g, '');
  // If Brazilian number without country code, prepend 55
  if (cleaned.length === 11 && (cleaned.startsWith('1') || cleaned.startsWith('2') || cleaned.startsWith('3') || cleaned.startsWith('4') || cleaned.startsWith('5') || cleaned.startsWith('6') || cleaned.startsWith('7') || cleaned.startsWith('8') || cleaned.startsWith('9'))) {
    cleaned = '55' + cleaned;
  }
  return cleaned;
}

// ===== Resposta automática fora do horário de expediente =====
// Verifica se AGORA está dentro do expediente (fuso de São Paulo), conforme config.
function isWithinBusinessHours(cfg) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    const map = {}; parts.forEach(p => { map[p.type] = p.value; });
    const wd = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' }[map.weekday];
    const d = cfg.days && cfg.days[wd];
    if (!d || !d.on) return false; // dia sem expediente => está fora
    let hh = parseInt(map.hour, 10); if (hh === 24) hh = 0;
    const cur = hh * 60 + parseInt(map.minute, 10);
    const toMin = (s) => { const a = (s || '0:0').split(':'); return parseInt(a[0], 10) * 60 + parseInt(a[1], 10); };
    return cur >= toMin(d.open) && cur < toMin(d.close);
  } catch (e) { return true; } // em dúvida, NÃO responde (considera dentro)
}

// Envia a mensagem fora do horário, se habilitada, fora do expediente e respeitando cooldown.
async function maybeAutoReply(sock, fromJid, convoId) {
  try {
    if (!fromJid || (!fromJid.endsWith('@s.whatsapp.net') && !fromJid.endsWith('@lid'))) {
      console.log(`[autoReply] ignora jid não-usuário: ${fromJid}`); return;
    }
    const row = await getRow("SELECT value FROM app_settings WHERE key = 'business_hours'");
    if (!row || !row.value) { console.log('[autoReply] sem config de horário salva'); return; }
    let cfg; try { cfg = JSON.parse(row.value); } catch (e) { console.log('[autoReply] config inválida'); return; }
    if (!cfg.autoReply) { console.log('[autoReply] auto-resposta DESLIGADA'); return; }
    if (!cfg.message) { console.log('[autoReply] mensagem vazia'); return; }
    if (isWithinBusinessHours(cfg)) { console.log('[autoReply] DENTRO do expediente, não responde'); return; }
    // Sem cooldown: toda mensagem recebida fora do horário recebe a resposta.
    await sock.sendMessage(fromJid, { text: cfg.message });
    const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const msgId = 'm_' + Math.random().toString(36).substr(2, 9);
    await runQuery("INSERT INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)", [msgId, convoId, 'me', cfg.message, timeStr, Date.now()]);
    await runQuery("UPDATE conversations SET lastTime = ?, last_autoreply = ? WHERE id = ?", [timeStr, Date.now(), convoId]);
    console.log(`[autoReply] mensagem fora do horário ENVIADA para ${fromJid}`);
  } catch (e) { console.error('[autoReply] erro:', e && e.message); }
}

const connectionRetries = {};

// Versão do Baileys cacheada: evita um fetch de rede a cada conexão.
// Esse fetch repetido podia travar o event loop e fazer um socket JÁ
// conectado estourar o keep-alive (408) quando um número novo conectava.
let _cachedWaVersion = null;

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

  // Carrega o Baileys (ESM) sob demanda e extrai as funcoes usadas
  const _b = await loadBaileys();
  const makeWASocket = _b.default || _b.makeWASocket;
  const useMultiFileAuthState = _b.useMultiFileAuthState;
  const DisconnectReason = _b.DisconnectReason;
  const fetchLatestBaileysVersion = _b.fetchLatestBaileysVersion;
  const downloadMediaMessage = _b.downloadMediaMessage;

  const sessionDir = path.join(__dirname, 'sessions', id);
  // Ensure sessions dir exists
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let version = _cachedWaVersion;
  if (!version) {
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
      _cachedWaVersion = version;
      console.log(`Using latest Baileys version: ${version.join('.')}, isLatest: ${latest.isLatest}`);
    } catch (err) {
      console.warn("Failed to fetch latest Baileys version, using fallback", err);
    }
  }

  const sock = makeWASocket({
    auth: state,
    logger,
    version,
    browser: ['Eccere CRM ' + id, 'Chrome', '120.0.0']
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
        // Mensagem enviada por nós (pelo CRM OU pelo celular). Antes era descartada;
        // agora gravamos como mensagem de saída para o chat mostrar os dois lados.
        const isMine = !!msg.key.fromMe;

        const fromJid = msg.key.remoteJid;
        if (!fromJid.endsWith('@s.whatsapp.net') && !fromJid.endsWith('@lid')) {
          console.log(`[WhatsApp ${id}] Ignored message from JID: ${fromJid} (not a user)`);
          continue; // ignore groups/broadcasts
        }

        let phone = '';
        if (msg.key?.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
          phone = '+' + msg.key.remoteJidAlt.split('@')[0];
        } else if (!fromJid.endsWith('@lid')) {
          phone = '+' + fromJid.split('@')[0];
        }
        const incomingMsgId = msg.key.id || ('m_' + Math.random().toString(36).substr(2, 9));
        let text, incomingType = 'text', incomingMediaPath = null;

        // Desembrulha mensagens "embrulhadas" (efêmeras, ver-uma-vez, doc c/ legenda)
        const content = msg.message || {};
        const inner = content.ephemeralMessage?.message
          || content.viewOnceMessage?.message
          || content.viewOnceMessageV2?.message
          || content.documentWithCaptionMessage?.message
          || content;

        // Extensão de arquivo a partir do mimetype
        const extFromMime = (mime, fallback) => {
          if (!mime) return fallback;
          const m = mime.split(';')[0].trim().toLowerCase();
          const map = {
            'image/jpeg':'.jpg','image/jpg':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp',
            'video/mp4':'.mp4','video/3gpp':'.3gp','video/quicktime':'.mov',
            'audio/ogg':'.ogg','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/amr':'.amr',
            'application/pdf':'.pdf','application/msword':'.doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx',
            'application/vnd.ms-excel':'.xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
            'text/plain':'.txt','application/zip':'.zip'
          };
          return map[m] || fallback;
        };
        // Baixa a mídia e salva com a extensão dada; devolve o caminho (ou null)
        const saveMedia = async (ext) => {
          try {
            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            const p = path.join(MEDIA_DIR, incomingMsgId + ext);
            fs.writeFileSync(p, buf);
            return p;
          } catch (e) {
            console.error(`[WhatsApp ${id}] Falha ao baixar mídia (${incomingType}):`, e);
            return null;
          }
        };

        if (inner.conversation || inner.extendedTextMessage?.text) {
          text = inner.conversation || inner.extendedTextMessage.text;
        } else if (inner.imageMessage) {
          incomingType = 'image';
          text = inner.imageMessage.caption || '[Imagem]';
          incomingMediaPath = await saveMedia(extFromMime(inner.imageMessage.mimetype, '.jpg'));
        } else if (inner.videoMessage) {
          incomingType = 'video';
          text = inner.videoMessage.caption || '[Vídeo]';
          incomingMediaPath = await saveMedia(extFromMime(inner.videoMessage.mimetype, '.mp4'));
        } else if (inner.audioMessage) {
          incomingType = 'audio';
          text = '[Mensagem de voz]';
          incomingMediaPath = await saveMedia('.ogg');
        } else if (inner.stickerMessage) {
          incomingType = 'sticker';
          text = '[Figurinha]';
          incomingMediaPath = await saveMedia('.webp');
        } else if (inner.documentMessage) {
          const doc = inner.documentMessage;
          incomingType = 'document';
          const fileName = doc.fileName || 'documento';
          text = fileName;
          let ext = path.extname(fileName).toLowerCase();
          if (!ext) ext = extFromMime(doc.mimetype, '.bin');
          incomingMediaPath = await saveMedia(ext);
        } else if (inner.locationMessage) {
          incomingType = 'text';
          const lat = inner.locationMessage.degreesLatitude;
          const lng = inner.locationMessage.degreesLongitude;
          text = '📍 Localização: https://maps.google.com/?q=' + lat + ',' + lng;
        } else if (inner.contactMessage || inner.contactsArrayMessage) {
          incomingType = 'text';
          const cm = inner.contactMessage || (inner.contactsArrayMessage?.contacts || [])[0];
          text = '👤 Contato: ' + ((cm && cm.displayName) || 'contato compartilhado');
        } else if (inner.reactionMessage) {
          incomingType = 'text';
          text = 'Reagiu: ' + (inner.reactionMessage.text || '👍');
        } else {
          text = '[Mídia/Outro]';
        }
        const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        const name = (!isMine && msg.pushName) ? msg.pushName : (fromJid.endsWith('@lid') ? 'Usuário WhatsApp' : (phone || 'Usuário WhatsApp'));

        console.log(`[WhatsApp ${id}] Message details: phone=${phone}, name=${name}, text="${text}"`);

        // Find or create conversation
        let convo = await getRow("SELECT * FROM conversations WHERE whatsapp_jid = ? OR phone = ?", [fromJid, phone]);
        let convoId;

        if (convo) {
          convoId = convo.id;
          console.log(`[WhatsApp ${id}] Existing conversation found: convoId=${convoId}`);
          // Update conversation
          await runQuery(
            "UPDATE conversations SET lastTime = ?, unread = unread + ?, archived = 0 WHERE id = ?",
            [timeStr, isMine ? 0 : 1, convoId]
          );
        } else {
          // Generate new conversation id
          convoId = 'c_' + Math.random().toString(36).substr(2, 9);
          console.log(`[WhatsApp ${id}] No conversation found. Creating new one with convoId=${convoId}`);
          const avatar = name.slice(0, 2).toUpperCase();
          await runQuery(
            "INSERT INTO conversations (id, account, name, phone, avatar, lastTime, unread, online, whatsapp_jid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [convoId, id, name, phone, avatar, timeStr, isMine ? 0 : 1, 0, fromJid]
          );
        }

        // Add message
        const msgId = incomingMsgId;
        console.log(`[WhatsApp ${id}] Saving message to DB: msgId=${msgId}, convoId=${convoId}, type=${incomingType}`);
        await runQuery(
          "INSERT OR IGNORE INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [msgId, convoId, isMine ? 'me' : 'them', text, timeStr, msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(), incomingType, incomingMediaPath]
        );

        // Regras de lead só valem para mensagens RECEBIDAS (do cliente), não para as nossas
        if (!isMine) {
        // Nosso número que RECEBEU esta mensagem (carimbado no lead p/ ficar
        // imune a futuras trocas de número entre slots). Vem do socket conectado.
        let ourNumber = '';
        try { if (sock.user && sock.user.id) ourNumber = '+' + sock.user.id.split(':')[0].split('@')[0]; } catch (e) {}
        // Check if phone matches any lead (active OR archived); if archived, restore it
        const searchNumber = fromJid.split('@')[0];
        let lead = await getRow("SELECT * FROM leads WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)", [fromJid, `%${searchNumber}%`]);
        if (!lead) {
          const leadId = 'l_' + Math.random().toString(36).substr(2, 9);
          const createdAt = new Date().toISOString().slice(0, 10);
          let formattedPhone = phone;
          if (!fromJid.endsWith('@lid') && phone.startsWith('+55') && phone.length === 14) {
            formattedPhone = `+55 ${phone.slice(3, 5)} ${phone.slice(5, 10)}-${phone.slice(10)}`;
          }
          console.log(`[WhatsApp ${id}] No lead found for ${phone}. Creating new lead: leadId=${leadId}`);
          await runQuery(
            "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, whatsapp_jid, recv_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [leadId, name, "", fromJid.endsWith('@lid') ? "" : formattedPhone, "", 0, "novo", "Venda", id, "Rafael Andrade", JSON.stringify([]), createdAt, 0, fromJid, ourNumber]
          );
        } else if (lead.archived === 1) {
          // Lead arquivado ("bloqueado") voltou a falar → restaura E manda para "Novo Leads".
          console.log(`[WhatsApp ${id}] Archived lead ${lead.name} sent a new message. Restoring to 'novo'.`);
          await runQuery("UPDATE leads SET archived = 0, stage = 'novo' WHERE id = ?", [lead.id]);
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
        // Carimba lastClientReply para QUALQUER mensagem recebida do cliente
        // (novo, restaurado OU existente) — assim a bolinha de tempo aparece já
        // na 1ª mensagem, não só a partir da segunda.
        await runQuery("UPDATE leads SET lastClientReply = ? WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)", [new Date().toISOString(), fromJid, `%${searchNumber}%`]);
        // Carimba o número recebido se o lead ainda não tiver (vale para criar,
        // restaurar e existentes — backfill automático no próximo contato).
        if (ourNumber) {
          await runQuery("UPDATE leads SET recv_number = ? WHERE (whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)) AND (recv_number IS NULL OR recv_number = '')", [ourNumber, fromJid, `%${searchNumber}%`]);
        }
        // Resposta automática fora do horário de expediente (se habilitada)
        await maybeAutoReply(sock, fromJid, convoId);
        } else {
          // NÓS respondemos (mensagem de saída): zera o lastClientReply para o
          // "controle de tempo" sumir — ele só vale enquanto o CLIENTE foi o último.
          const sn = fromJid.split('@')[0];
          await runQuery("UPDATE leads SET lastClientReply = NULL WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)", [fromJid, `%${sn}%`]);
        } // fim if (!isMine)
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

  const jid = convo.whatsapp_jid ? convo.whatsapp_jid : (convo.phone.includes('@') ? convo.phone : `${sanitizePhoneNumber(convo.phone)}@s.whatsapp.net`);
  
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

// Send a voice note (PTT). inputBuffer = raw audio bytes from the browser recorder.
async function sendWhatsAppAudio(accountId, convoId, inputBuffer) {
  const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
  if (!convo) throw new Error("Conversation not found");

  const jid = convo.whatsapp_jid ? convo.whatsapp_jid : (convo.phone.includes('@') ? convo.phone : `${sanitizePhoneNumber(convo.phone)}@s.whatsapp.net`);

  const sock = sessions[accountId];
  if (!sock) {
    throw new Error("WhatsApp account not connected");
  }

  // Convert the browser audio to Opus/OGG that WhatsApp accepts as a voice note
  const oggBuffer = await transcodeToOpusOgg(inputBuffer);

  const sent = await sock.sendMessage(jid, {
    audio: oggBuffer,
    ptt: true,
    mimetype: 'audio/ogg; codecs=opus'
  });

  const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const msgId = (sent && sent.key && sent.key.id) || ('m_' + Math.random().toString(36).substr(2, 9));

  // Persist the audio file so it can be replayed in the CRM
  const mediaPath = path.join(MEDIA_DIR, msgId + '.ogg');
  try { fs.writeFileSync(mediaPath, oggBuffer); } catch (e) { console.error('Falha ao salvar áudio enviado:', e); }

  await runQuery(
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [msgId, convoId, 'me', '[Mensagem de voz]', timeStr, Date.now(), 'audio', mediaPath]
  );

  await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, convoId]);

  return { id: msgId, from: 'me', text: '[Mensagem de voz]', time: timeStr, type: 'audio' };
}

// Auto reconnect active sessions on startup
async function initSessions() {
  const connectedAccounts = await allRows("SELECT id FROM whatsapp_accounts WHERE status = 'connected'");
  let delay = 0;
  for (const acc of connectedAccounts) {
    const sessionDir = path.join(__dirname, 'sessions', acc.id);
    const credsFile = path.join(sessionDir, 'creds.json');
    // Slot fantasma: marcado "connected" no banco, mas sem credencial salva
    // (ex.: sessões apagadas no reset). NÃO reconectar — isso gerava QR/408 em
    // loop e atrapalhava os números reais. Apenas marca como desconectado.
    if (!fs.existsSync(credsFile)) {
      console.log(`Skipping auto-connect for ${acc.id}: sem creds.json (sessão fantasma). Marcando desconectado.`);
      runQuery("UPDATE whatsapp_accounts SET status = 'disconnected' WHERE id = ?", [acc.id])
        .catch(e => console.error(`Falha ao marcar ${acc.id} desconectado:`, e));
      continue;
    }
    // Espaça as reconexões (3s entre cada) p/ não abrir vários handshakes ao
    // mesmo tempo e estrangular o event loop (causa de timeouts 408).
    console.log(`Auto connecting WhatsApp session for ${acc.id} (em ${delay}ms)`);
    setTimeout(() => {
      connectWhatsApp(acc.id).catch(e => console.error(`Failed auto connect for ${acc.id}:`, e));
    }, delay);
    delay += 3000;
  }
}

module.exports = {
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  initSessions,
  sessions,
  sessionQrs,
  MEDIA_DIR
};
