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
const { getNovoLeadReply, getAiSettings } = require('./ai');
// ids de mensagens enviadas pela IA (o eco fromMe delas NÃO move o card — a IA move quando concluir)
const _aiSentIds = new Set();

if (ffmpegPath) {
  try { ffmpeg.setFfmpegPath(ffmpegPath); } catch (e) { console.error('ffmpeg path set failed', e); }
}

const sessions = {};
const sessionQrs = {};

// Directory where voice notes / media are stored (ephemeral on Render)
const MEDIA_DIR = path.join(__dirname, 'media');
try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { /* ignore */ }

// Fotos de perfil do WhatsApp (avatares). Baixadas via Baileys e guardadas localmente.
const https = require('https');
const AVATAR_DIR = path.join(MEDIA_DIR, 'avatars');
try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch (e) { /* ignore */ }
function avatarFileForJid(jid) { return path.join(AVATAR_DIR, String(jid || '').replace(/[^a-zA-Z0-9._-]/g, '_') + '.jpg'); }
// Busca a foto de perfil do contato e salva em disco. Reusa por 7 dias. Tolerante a falhas
// (privacidade do contato / sem foto / jid @lid → simplesmente não salva e o card usa as iniciais).
async function fetchAndStoreAvatar(sock, jid) {
  try {
    if (!sock || !jid) return false;
    const file = avatarFileForJid(jid);
    try { const st = fs.statSync(file); if (Date.now() - st.mtimeMs < 7 * 86400000) return true; } catch (e) {}
    let url = null;
    try { url = await sock.profilePictureUrl(jid, 'image'); } catch (e) { url = null; }
    if (!url) return false;
    return await new Promise((resolve) => {
      https.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(false); }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => { try { fs.writeFileSync(file, Buffer.concat(chunks)); resolve(true); } catch (e) { resolve(false); } });
      }).on('error', () => resolve(false));
    });
  } catch (e) { return false; }
}

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

        // Desembrulha wrappers comuns: viewOnce, ephemeral, ptvMessage, etc.
        function unwrapInner(obj) {
          if (!obj) return obj;
          // viewOnceMessage / viewOnceMessageV2 / viewOnceMessageV2Extension
          if (obj.viewOnceMessage?.message) return unwrapInner(obj.viewOnceMessage.message);
          if (obj.viewOnceMessageV2?.message) return unwrapInner(obj.viewOnceMessageV2.message);
          if (obj.viewOnceMessageV2Extension?.message) return unwrapInner(obj.viewOnceMessageV2Extension.message);
          // ephemeralMessage
          if (obj.ephemeralMessage?.message) return unwrapInner(obj.ephemeralMessage.message);
          // documentWithCaptionMessage
          if (obj.documentWithCaptionMessage?.message) return unwrapInner(obj.documentWithCaptionMessage.message);
          // ptvMessage (vídeo redondo) → trata como vídeo
          if (obj.ptvMessage) return { videoMessage: obj.ptvMessage };
          return obj;
        }
        const innerMsg = unwrapInner(inner);

        if (innerMsg.conversation || innerMsg.extendedTextMessage?.text) {
          text = innerMsg.conversation || innerMsg.extendedTextMessage.text;
        } else if (innerMsg.imageMessage) {
          incomingType = 'image';
          text = innerMsg.imageMessage.caption || '[Imagem]';
          incomingMediaPath = await saveMedia(extFromMime(innerMsg.imageMessage.mimetype, '.jpg'));
        } else if (innerMsg.videoMessage) {
          incomingType = 'video';
          text = innerMsg.videoMessage.caption || '[Vídeo]';
          incomingMediaPath = await saveMedia(extFromMime(innerMsg.videoMessage.mimetype, '.mp4'));
        } else if (innerMsg.audioMessage) {
          incomingType = 'audio';
          text = '[Mensagem de voz]';
          incomingMediaPath = await saveMedia('.ogg');
        } else if (innerMsg.stickerMessage) {
          incomingType = 'sticker';
          text = '[Figurinha]';
          incomingMediaPath = await saveMedia(innerMsg.stickerMessage.isAnimated ? '.webp' : '.webp');
        } else if (innerMsg.documentMessage) {
          const doc = innerMsg.documentMessage;
          incomingType = 'document';
          const fileName = doc.fileName || 'documento';
          text = fileName;
          let ext = path.extname(fileName).toLowerCase();
          if (!ext) ext = extFromMime(doc.mimetype, '.bin');
          incomingMediaPath = await saveMedia(ext);
        } else if (innerMsg.locationMessage) {
          incomingType = 'text';
          const lat = innerMsg.locationMessage.degreesLatitude;
          const lng = innerMsg.locationMessage.degreesLongitude;
          text = '📍 Localização: https://maps.google.com/?q=' + lat + ',' + lng;
        } else if (innerMsg.liveLocationMessage) {
          incomingType = 'text';
          const lat2 = innerMsg.liveLocationMessage.degreesLatitude;
          const lng2 = innerMsg.liveLocationMessage.degreesLongitude;
          text = '📍 Localização ao vivo: https://maps.google.com/?q=' + lat2 + ',' + lng2;
        } else if (innerMsg.contactMessage || innerMsg.contactsArrayMessage) {
          incomingType = 'text';
          const cm = innerMsg.contactMessage || (innerMsg.contactsArrayMessage?.contacts || [])[0];
          text = '👤 Contato: ' + ((cm && cm.displayName) || 'contato compartilhado');
        } else if (innerMsg.reactionMessage) {
          incomingType = 'text';
          text = 'Reagiu: ' + (innerMsg.reactionMessage.text || '👍');
        } else if (innerMsg.pollCreationMessage || innerMsg.pollCreationMessageV3) {
          incomingType = 'text';
          const poll = innerMsg.pollCreationMessage || innerMsg.pollCreationMessageV3;
          text = '📊 Enquete: ' + (poll.name || 'enquete');
        } else if (innerMsg.groupInviteMessage) {
          incomingType = 'text';
          text = '👥 Convite de grupo: ' + (innerMsg.groupInviteMessage.groupName || 'grupo');
        } else if (innerMsg.interactiveMessage || innerMsg.buttonsMessage || innerMsg.listMessage || innerMsg.templateMessage) {
          incomingType = 'text';
          const im = innerMsg.interactiveMessage || innerMsg.buttonsMessage || innerMsg.listMessage || innerMsg.templateMessage;
          text = im?.body?.text || im?.contentText || im?.footerText || '[Mensagem interativa]';
        } else {
          // Catch-all: qualquer objeto com mimetype (tipos novos do WhatsApp)
          let mm = null;
          for (const k of Object.keys(innerMsg)) {
            const v = innerMsg[k];
            if (v && typeof v === 'object' && v.mimetype) { mm = v; break; }
          }
          if (mm) {
            const mime = String(mm.mimetype).toLowerCase();
            incomingType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.includes('webp') ? 'sticker' : 'document';
            text = mm.caption || mm.fileName || (incomingType === 'image' ? '[Imagem]' : incomingType === 'video' ? '[Vídeo]' : incomingType === 'audio' ? '[Mensagem de voz]' : incomingType === 'sticker' ? '[Figurinha]' : '[Arquivo]');
            let ext = mm.fileName ? path.extname(mm.fileName).toLowerCase() : '';
            if (!ext) ext = extFromMime(mm.mimetype, incomingType === 'sticker' ? '.webp' : '.bin');
            incomingMediaPath = await saveMedia(ext);
            if (!incomingMediaPath) { incomingType = 'text'; text = text || '[Mídia]'; }
          } else {
            // Nenhum conteúdo reconhecível — loga para diagnóstico e ignora silenciosamente
            const keys = Object.keys(innerMsg).join(', ');
            console.warn(`[WhatsApp ${id}] Tipo de mensagem não reconhecido (chaves: ${keys}) — ignorado.`);
            text = null; // sinaliza para não salvar
          }
        }
        // Mensagem sem conteúdo reconhecível (ex.: tipo desconhecido futuro) — ignora
        if (text === null) return;

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
        // Foto de perfil do contato (não-bloqueante; reusa por 7 dias)
        fetchAndStoreAvatar(sock, fromJid).catch(() => {});
        // Carimba lastClientReply para QUALQUER mensagem recebida do cliente
        // (novo, restaurado OU existente) — assim a bolinha de tempo aparece já
        // na 1ª mensagem, não só a partir da segunda.
        await runQuery("UPDATE leads SET lastClientReply = ? WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)", [new Date().toISOString(), fromJid, `%${searchNumber}%`]);
        // Carimba o número recebido se o lead ainda não tiver (vale para criar,
        // restaurar e existentes — backfill automático no próximo contato).
        if (ourNumber) {
          await runQuery("UPDATE leads SET recv_number = ? WHERE (whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)) AND (recv_number IS NULL OR recv_number = '')", [ourNumber, fromJid, `%${searchNumber}%`]);
        }
        // Resposta automática fora do horário de expediente (se habilitada).
        // PORÉM: se a IA vai atender este lead (em "Novo Leads" e IA ligada), é ELA quem fala
        // (inclusive o aviso de fora do horário) — então NÃO dispara a auto-resposta antiga,
        // para o cliente não receber mensagem duplicada.
        let _aiWillHandle = false;
        try {
          const _aiCfg = await getAiSettings();
          if (_aiCfg && _aiCfg.enabled && _aiCfg.novo_enabled && _aiCfg.gemini_key) {
            const _sn = fromJid.split('@')[0];
            const _nl = await getRow("SELECT id FROM leads WHERE archived = 0 AND stage = 'novo' AND (whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)) LIMIT 1", [fromJid, `%${_sn}%`]);
            if (_nl) _aiWillHandle = true;
          }
        } catch (e) {}
        if (!_aiWillHandle) await maybeAutoReply(sock, fromJid, convoId);

        // ===== IA (Gemini): 1ª interação nos leads em "Novo Leads" =====
        // Coleta dados do cliente conforme as instruções de Configurações; quando
        // concluir (dados coletados), É A IA quem move o card para Tratamento inicial.
        try {
          const sn2 = fromJid.split('@')[0];
          const aiLead = await getRow(
            "SELECT * FROM leads WHERE archived = 0 AND stage = 'novo' AND (whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)) LIMIT 1",
            [fromJid, `%${sn2}%`]
          );
          if (aiLead) {
            const ai = await getNovoLeadReply(convoId, aiLead.name);
            if (ai && ai.reply) {
              // Fora do horário? Seg–Sex 9h–18h, Sáb 9h–13h, Dom fechado (fuso de São Paulo).
              let outOfHours = false;
              try {
                const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
                const wd = p.find(x => x.type === 'weekday').value;
                const h = parseInt(p.find(x => x.type === 'hour').value, 10);
                const open = (['Mon','Tue','Wed','Thu','Fri'].includes(wd) && h >= 9 && h < 18) || (wd === 'Sat' && h >= 9 && h < 13);
                outOfHours = !open;
              } catch (e) {}
              // Ao concluir (handoff) e fora do horário, acrescenta o aviso de horário + retorno.
              let replyText = ai.reply;
              if (ai.dados_coletados && ai.visa_tag && outOfHours) {
                replyText += '\n\n⏰ Nosso horário de atendimento é de segunda a sexta, das 9h às 18h, e aos sábados, das 9h às 13h. No momento estamos fora do horário, mas em breve um de nossos consultores dará continuidade ao seu atendimento. 🙏';
              }
              const sentAi = await sock.sendMessage(fromJid, { text: replyText });
              const aiMsgId = (sentAi && sentAi.key && sentAi.key.id) || ('m_' + Math.random().toString(36).substr(2, 9));
              _aiSentIds.add(aiMsgId);
              if (_aiSentIds.size > 500) { const first = _aiSentIds.values().next().value; _aiSentIds.delete(first); }
              const tAi = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
              await runQuery(
                "INSERT OR IGNORE INTO messages (id, conversationId, `from`, text, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                [aiMsgId, convoId, 'me', replyText, tAi, Date.now()]
              );
              await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [tAi, convoId]);
              // IA respondeu → zera o controle de tempo (fomos os últimos a falar)
              await runQuery("UPDATE leads SET lastClientReply = NULL WHERE id = ?", [aiLead.id]);
              if (ai.dados_coletados && ai.visa_tag) {
                // SÓ transfere após identificar o serviço: grava a TAG do serviço, marca "Novo lead"
                // e move p/ o Tratamento inicial (1ª coluna). "Novo lead" sai quando um humano responder.
                await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'novolead', tags = ? WHERE id = ? AND stage = 'novo'", [JSON.stringify([ai.visa_tag]), aiLead.id]);
                console.log(`[IA] "${aiLead.name}": serviço identificado (${ai.visa_tag}) → Tratamento inicial + tag "Novo lead".`);
              } else {
                console.log(`[IA] "${aiLead.name}": IA respondeu (ainda coletando nome/serviço).`);
              }
            }
          }
        } catch (aiErr) { console.error('[IA novo-lead]', aiErr && aiErr.message); }
        } else {
          // NÓS respondemos (mensagem de saída): zera o lastClientReply para o
          // "controle de tempo" sumir — ele só vale enquanto o CLIENTE foi o último.
          const sn = fromJid.split('@')[0];
          await runQuery("UPDATE leads SET lastClientReply = NULL WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)", [fromJid, `%${sn}%`]);
          // A auto-resposta de fora do horário NÃO conta como atendimento:
          // não pode mover o lead de "Novo Leads" para "Tratamento inicial".
          let isAutoReply = false;
          try {
            const bhRow = await getRow("SELECT value FROM app_settings WHERE key = 'business_hours'");
            const bh = bhRow && bhRow.value ? JSON.parse(bhRow.value) : null;
            if (bh && bh.message && text && String(text).trim() === String(bh.message).trim()) isAutoReply = true;
          } catch (e) {}
          if (!isAutoReply && !_aiSentIds.has(msg.key.id)) {
            // Mensagem de um HUMANO (não auto-resposta, não IA).
            // Casa por jid E por telefone normalizado (8 últimos dígitos), robusto a formatação.
            const tail = sn.replace(/\D/g, '').slice(-8);
            const matchSql = "(whatsapp_jid = ? OR (phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?))";
            // Novos Leads: ao responder (pelo celular OU pelo CRM), move para "Tratamento inicial".
            await runQuery("UPDATE leads SET stage = 'tratamento' WHERE stage = 'novo' AND " + matchSql, [fromJid, `%${tail}%`]);
            // 1ª interação humana remove a tag "Novo lead" (some da 1ª coluna do Tratamento).
            await runQuery("UPDATE leads SET priority = '' WHERE priority = 'novolead' AND " + matchSql, [fromJid, `%${tail}%`]);
          }
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

// Envia foto/vídeo/documento pela conversa (e persiste no CRM)
async function sendWhatsAppMedia(accountId, convoId, buffer, mimetype, fileName) {
  const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
  if (!convo) throw new Error("Conversation not found");
  const jid = convo.whatsapp_jid ? convo.whatsapp_jid : (convo.phone.includes('@') ? convo.phone : `${sanitizePhoneNumber(convo.phone)}@s.whatsapp.net`);
  const sock = sessions[accountId];
  if (!sock) throw new Error("WhatsApp account not connected");
  const mime = String(mimetype || 'application/octet-stream').toLowerCase();
  let content, type, label;
  if (mime.startsWith('image/')) { content = { image: buffer, mimetype: mime }; type = 'image'; label = fileName || '[Imagem]'; }
  else if (mime.startsWith('video/')) { content = { video: buffer, mimetype: mime }; type = 'video'; label = fileName || '[Vídeo]'; }
  else { content = { document: buffer, mimetype: mime, fileName: fileName || 'arquivo' }; type = 'document'; label = fileName || '[Arquivo]'; }
  const sent = await sock.sendMessage(jid, content);
  const timeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const msgId = (sent && sent.key && sent.key.id) || ('m_' + Math.random().toString(36).substr(2, 9));
  let ext = path.extname(fileName || '');
  if (!ext) ext = type === 'image' ? '.jpg' : type === 'video' ? '.mp4' : '.bin';
  const mediaPath = path.join(MEDIA_DIR, msgId + ext);
  try { fs.writeFileSync(mediaPath, buffer); } catch (e) { console.error('Falha ao salvar mídia enviada:', e); }
  await runQuery(
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [msgId, convoId, 'me', label, timeStr, Date.now(), type, mediaPath]
  );
  await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, convoId]);
  return { id: msgId, from: 'me', text: label, time: timeStr, type: type };
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
  sendWhatsAppMedia,
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  initSessions,
  sessions,
  sessionQrs,
  MEDIA_DIR,
  AVATAR_DIR,
  avatarFileForJid,
  fetchAndStoreAvatar
};
