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
const { runQuery, getRow, allRows, isGoogleAdsFirstMsg } = require('./db');
const { getNovoLeadReply, getAiSettings } = require('./ai');
// ids de mensagens enviadas pela IA (o eco fromMe delas NÃO move o card — a IA move quando concluir)
const _aiSentIds = new Set();

// Mensagens-padrão dos anúncios do META (click-to-WhatsApp). Ao chegar uma delas, o lead é
// classificado como "Meta Ads" (tracking.channel). Lista informada pelo Henry.
const META_AD_MESSAGES = [
  'olá! quero informações sobre primeiro visto ou renovação.',
  'olá! gostaria de saber mais detalhes sobre a oferta de renovação de visto.',
  'olá! gostaria de saber mais informações sobre como tirar o primeiro visto.',
  'olá! gostaria de saber mais informações sobre a renovação de visto.',
  'olá. vim do site e gostaria de saber mais sobre os serviços de visto americano'
];
function _normMsg(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function isMetaAdMessage(text) { const t = _normMsg(text); return META_AD_MESSAGES.some(m => t === m || t.startsWith(m)); }
async function markLeadMeta(fromJid, phone) {
  try {
    const tail = String(phone || '').replace(/\D/g, '').slice(-8);
    let lead = null;
    if (fromJid) lead = await getRow("SELECT id, tracking FROM leads WHERE whatsapp_jid = ? LIMIT 1", [fromJid]);
    if (!lead && tail.length >= 8) lead = await getRow("SELECT id, tracking FROM leads WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + tail]);
    if (!lead) return;
    let tk = {}; try { tk = lead.tracking ? JSON.parse(lead.tracking) : {}; } catch (e) { tk = {}; }
    if (tk.channel === 'Meta Ads') return;
    tk.channel = 'Meta Ads';
    await runQuery("UPDATE leads SET tracking = ? WHERE id = ?", [JSON.stringify(tk), lead.id]);
    console.log(`[meta] lead ${lead.id} classificado como Meta Ads pelo texto do anúncio.`);
  } catch (e) { console.error('[meta classify]', e && e.message); }
}

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
    try {
      url = await Promise.race([
        sock.profilePictureUrl(jid, 'image'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
      ]);
    } catch (e) { url = null; }
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

// Número (linha) NOSSA a partir do socket conectado — carimbado em cada mensagem que enviamos,
// para o histórico saber de QUAL número saiu cada mensagem (imune a futuras trocas de linha).
function sockNumber(sock) {
  try { if (sock && sock.user && sock.user.id) return '+' + sock.user.id.split(':')[0].split('@')[0]; } catch (e) {}
  return '';
}

// Registra um evento na linha do tempo do lead (best-effort; nunca quebra a ação principal).
// Espelha o logLeadHistory do index.js para que as movimentações AUTOMÁTICAS (IA) também
// apareçam no "Histórico do cliente".
async function logHistory(leadId, phone, name, type, detail, meta) {
  try {
    const id = 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ph = String(phone || '').replace(/\D/g, '');
    await runQuery(
      "INSERT INTO lead_history (id, lead_id, phone, name, type, detail, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, leadId || null, ph || null, name || null, type, detail || '', meta ? JSON.stringify(meta) : null, new Date().toISOString()]
    );
  } catch (e) { console.error('[history] log falhou:', e && e.message); }
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
    await runQuery("INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, our_number) VALUES (?, ?, ?, ?, ?, ?, ?)", [msgId, convoId, 'me', cfg.message, timeStr, Date.now(), sockNumber(sock)]);
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
          // Bolinha como no WhatsApp Web: conta SÓ mensagens do cliente e ZERA quando NÓS
          // respondemos (qualquer mensagem nossa = conversa "lida"). Cliente → +1; nós → 0.
          await runQuery(
            "UPDATE conversations SET lastTime = ?, unread = " + (isMine ? "0" : "unread + 1") + ", archived = 0 WHERE id = ?",
            [timeStr, convoId]
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
          "INSERT OR IGNORE INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath, our_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [msgId, convoId, isMine ? 'me' : 'them', text, timeStr, msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now(), incomingType, incomingMediaPath, isMine ? sockNumber(sock) : null]
        );

        // Regras de lead só valem para mensagens RECEBIDAS (do cliente), não para as nossas
        if (!isMine) {
        // Nosso número que RECEBEU esta mensagem (carimbado no lead p/ ficar
        // imune a futuras trocas de número entre slots). Vem do socket conectado.
        let ourNumber = '';
        try { if (sock.user && sock.user.id) ourNumber = '+' + sock.user.id.split(':')[0].split('@')[0]; } catch (e) {}
        // Check if phone matches any lead (active OR archived); if archived, restore it
        const searchNumber = fromJid.split('@')[0];
        // Dedup ROBUSTO: procura o lead pelos ÚLTIMOS 8 DÍGITOS do telefone (normalizado), além do jid.
        // Evita criar duplicata quando o telefone foi salvo formatado/sem DDI — causa nº 1 de duplicação.
        const _pdig = String(phone || '').replace(/\D/g, '');
        const _last8 = _pdig.length >= 8 ? _pdig.slice(-8) : '';
        let lead = _last8
          ? await getRow("SELECT * FROM leads WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?)", [fromJid, `%${_last8}%`])
          : await getRow("SELECT * FROM leads WHERE whatsapp_jid = ?", [fromJid]);
        // Achou por telefone mas sem jid salvo? Carimba o jid para futuras buscas casarem direto.
        if (lead && !lead.whatsapp_jid && fromJid) {
          try { await runQuery("UPDATE leads SET whatsapp_jid = ? WHERE id = ?", [fromJid, lead.id]); } catch (e) {}
        }
        if (!lead) {
          const leadId = 'l_' + Math.random().toString(36).substr(2, 9);
          const createdAt = new Date().toISOString().slice(0, 10);
          let formattedPhone = phone;
          if (!fromJid.endsWith('@lid') && phone.startsWith('+55') && phone.length === 14) {
            formattedPhone = `+55 ${phone.slice(3, 5)} ${phone.slice(5, 10)}-${phone.slice(10)}`;
          }
          // Regra de origem: a 1ª mensagem (pré-preenchida pelo site, clique vindo de
          // anúncio do Google Ads) começa SEMPRE com a frase padrão → origem "Google Ads".
          // Qualquer outra abertura mantém o padrão "Venda".
          const leadSource = isGoogleAdsFirstMsg(text) ? "Google Ads" : "Venda";
          console.log(`[WhatsApp ${id}] No lead found for ${phone}. Creating new lead: leadId=${leadId} (source=${leadSource})`);
          await runQuery(
            "INSERT INTO leads (id, name, company, phone, email, value, stage, source, account, owner, tags, createdAt, archived, whatsapp_jid, recv_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [leadId, name, "", fromJid.endsWith('@lid') ? "" : formattedPhone, "", 0, "novo", leadSource, id, "Rafael Andrade", JSON.stringify([]), createdAt, 0, fromJid, ourNumber]
          );
        } else if (lead.archived === 1) {
          // Lead arquivado ("bloqueado") voltou a falar → restaura. Vai para "Novo Leads",
          // MAS preserva estágios terminais (convertida/declinado nunca viram 'novo').
          console.log(`[WhatsApp ${id}] Archived lead ${lead.name} sent a new message. Restoring.`);
          // Reforço: leads em Proposta, Follow-up, Convertida e Clientes antigos mantêm a etapa ao reativar.
          // EXCEÇÃO (regra do Henry): lead DECLINADO/CANCELADO que faz contato de novo "fecha a conexão" e
          // RECOMEÇA na 1ª coluna (Novo Leads) — o motivo e a data do fechamento ficam guardados no
          // histórico (lead_history), que sobrevive ao reset.
          await runQuery("UPDATE leads SET archived = 0, stage = CASE WHEN stage IN ('proposta','followup','convertida','clientes_antigos') THEN stage ELSE 'novo' END WHERE id = ?", [lead.id]);
          // Recomeçou em "novo" (ex.: era declinado): limpa o motivo antigo — um novo cancelamento exigirá
          // um motivo novo. O motivo/data anteriores permanecem no histórico.
          await runQuery("UPDATE leads SET decline_reason = NULL WHERE id = ? AND stage = 'novo'", [lead.id]);
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
        // na 1ª mensagem, não só a partir da segunda. Também grava last_client_ts (persistente,
        // NÃO é zerado quando respondemos) usado para ordenar as colunas por antiguidade da msg do cliente.
        await runQuery("UPDATE leads SET lastClientReply = ?, last_client_ts = ? WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)", [new Date().toISOString(), Date.now(), fromJid, `%${searchNumber}%`]);
        // Carimba o número recebido se o lead ainda não tiver (vale para criar,
        // restaurar e existentes — backfill automático no próximo contato).
        if (ourNumber) {
          // SEMPRE carimba o número REAL que recebeu (inclusive 2030). NUNCA mascara com outra linha.
          await runQuery("UPDATE leads SET recv_number = ? WHERE (whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)) AND (recv_number IS NULL OR recv_number = '')", [ourNumber, fromJid, `%${searchNumber}%`]);
        }
        // Mensagem-padrão de anúncio do META → classifica o lead como Meta Ads.
        if (isMetaAdMessage(text)) await markLeadMeta(fromJid, phone);
        // Resposta automática fora do horário: vale APENAS para leads JÁ em atendimento
        // (Tratamento inicial, Proposta enviada, Follow-up pagamento, Venda convertida,
        // Lead declinou/cancelado e Clientes antigos). NÃO vale para "Novo Leads" — esses são
        // atendidos pela IA (que já inclui o aviso de fora do horário quando conclui).
        let _autoReplyOk = false;
        try {
          const _tail = (fromJid.split('@')[0] || '').replace(/\D/g, '').slice(-8);
          let _lead = await getRow("SELECT stage FROM leads WHERE archived = 0 AND whatsapp_jid = ? LIMIT 1", [fromJid]);
          if (!_lead && _tail.length >= 8) {
            _lead = await getRow("SELECT stage FROM leads WHERE archived = 0 AND phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", [`%${_tail}%`]);
          }
          // JAMAIS automação para estágios terminais (Venda convertida / Declinou / Clientes antigos).
          if (_lead && _lead.stage && !['novo', 'convertida', 'declinado', 'clientes_antigos'].includes(_lead.stage)) _autoReplyOk = true;
        } catch (e) {}
        if (_autoReplyOk && !(await isPosLine(id))) await maybeAutoReply(sock, fromJid, convoId); // 2030/pós: sem automação

        // ===== IA (Gemini): 1ª interação nos leads em "Novo Leads" =====
        // Coleta dados do cliente conforme as instruções de Configurações; quando
        // concluir (dados coletados), É A IA quem move o card para Tratamento inicial.
        try {
          const sn2 = fromJid.split('@')[0];
          const aiLead = await getRow(
            "SELECT * FROM leads WHERE archived = 0 AND stage = 'novo' AND (whatsapp_jid = ? OR (phone IS NOT NULL AND phone LIKE ?)) LIMIT 1",
            [fromJid, `%${sn2}%`]
          );
          if (aiLead && !(await isPosLine(id))) {
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
                "INSERT OR IGNORE INTO messages (id, conversationId, `from`, text, time, timestamp, ai, our_number) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
                [aiMsgId, convoId, 'me', replyText, tAi, Date.now(), sockNumber(sock)]
              );
              await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [tAi, convoId]);
              // IA respondeu → zera o controle de tempo (fomos os últimos a falar)
              await runQuery("UPDATE leads SET lastClientReply = NULL WHERE id = ?", [aiLead.id]);
              if (ai.dados_coletados && ai.visa_tag) {
                // SÓ transfere após identificar o serviço E ter perguntado o horário do contato telefônico:
                // grava a TAG do serviço, marca "Novo lead" e move p/ o Tratamento inicial (1ª coluna).
                // "Novo lead" sai quando um humano responder.
                await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'novolead', tags = ? WHERE id = ? AND stage = 'novo'", [JSON.stringify([ai.visa_tag]), aiLead.id]);
                await logHistory(aiLead.id, aiLead.phone, aiLead.name, 'movimentacao', 'Movido para "Tratamento inicial" (atendimento automático da IA)', { to: 'tratamento' });
                // Registra nos comentários o horário que o cliente informou para o consultor ligar (se houver).
                if (ai.horario_contato) {
                  const note = '📞 Horário p/ ligar (informado pelo cliente): ' + String(ai.horario_contato).slice(0, 200);
                  await runQuery("UPDATE leads SET comments = TRIM(COALESCE(comments,'') || char(10) || ?) WHERE id = ?", [note, aiLead.id]);
                }
                console.log(`[IA] "${aiLead.name}": serviço identificado (${ai.visa_tag})${ai.horario_contato ? ', horário p/ ligar: ' + ai.horario_contato : ''} → Tratamento inicial + tag "Novo lead".`);
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
          const snTail = sn.replace(/\D/g, '').slice(-8);
          await runQuery("UPDATE leads SET lastClientReply = NULL WHERE whatsapp_jid = ? OR (phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ?)", [fromJid, `%${snTail}%`]);
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

  // Status de entrega/leitura das NOSSAS mensagens (ticks). A Meta envia messages.update com
  // update.status: 2=enviado(1 tick), 3=entregue(2 ticks), 4=lido(2 ticks azuis), 5=tocado.
  // Como gravamos a mensagem com id = key.id, dá pra atualizar direto por id (só sobe, nunca desce).
  sock.ev.on('messages.update', async (updates) => {
    try {
      for (const u of (updates || [])) {
        const st = u && u.update && u.update.status;
        const mid = u && u.key && u.key.id;
        if (mid && typeof st === 'number' && st >= 2) {
          await runQuery("UPDATE messages SET status = ? WHERE id = ? AND status < ?", [st, mid, st]);
        }
      }
    } catch (err) {
      console.error(`[WhatsApp ${id}] Error in messages.update handler:`, err);
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

  // Insert into DB (status >= 2 = enviado/1 tick; messages.update sobe p/ entregue/lido)
  await runQuery(
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, status, our_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [msgId, convoId, 'me', text, timeStr, Date.now(), Math.max(2, (sent && sent.status) || 0), sockNumber(sock)]
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
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath, our_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [msgId, convoId, 'me', '[Mensagem de voz]', timeStr, Date.now(), 'audio', mediaPath, sockNumber(sock)]
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
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath, our_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [msgId, convoId, 'me', label, timeStr, Date.now(), type, mediaPath, sockNumber(sock)]
  );
  await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [timeStr, convoId]);
  return { id: msgId, from: 'me', text: label, time: timeStr, type: type };
}

// Edita o texto de uma mensagem JÁ enviada por nós (protocolo de edição do WhatsApp; janela ~15 min).
async function editWhatsAppMessage(accountId, convoId, msgId, newText) {
  const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
  if (!convo) throw new Error("Conversation not found");
  const jid = convo.whatsapp_jid ? convo.whatsapp_jid : (convo.phone.includes('@') ? convo.phone : `${sanitizePhoneNumber(convo.phone)}@s.whatsapp.net`);
  const sock = sessions[accountId];
  if (!sock) throw new Error("WhatsApp account not connected");
  const key = { remoteJid: jid, fromMe: true, id: msgId };
  await sock.sendMessage(jid, { text: newText, edit: key });
  await runQuery("UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND conversationId = ?", [newText, msgId, convoId]);
  return { id: msgId, text: newText, edited: 1 };
}

// Apaga PARA TODOS uma mensagem enviada por nós (revoke do WhatsApp).
async function deleteWhatsAppMessage(accountId, convoId, msgId) {
  const convo = await getRow("SELECT * FROM conversations WHERE id = ?", [convoId]);
  if (!convo) throw new Error("Conversation not found");
  const jid = convo.whatsapp_jid ? convo.whatsapp_jid : (convo.phone.includes('@') ? convo.phone : `${sanitizePhoneNumber(convo.phone)}@s.whatsapp.net`);
  const sock = sessions[accountId];
  if (!sock) throw new Error("WhatsApp account not connected");
  const key = { remoteJid: jid, fromMe: true, id: msgId };
  await sock.sendMessage(jid, { delete: key });
  await runQuery("UPDATE messages SET deleted = 1 WHERE id = ? AND conversationId = ?", [msgId, convoId]);
  return { id: msgId, deleted: 1 };
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

// Processa o BACKLOG: faz a IA responder os leads de "Novo Leads" cujo cliente está aguardando
// (lastClientReply != NULL) — ex.: mensagens que chegaram enquanto a IA estava desligada.
// Mesma lógica do fluxo em tempo real (responde, zera o tempo, e move ao concluir).
// True se a linha `lineId` for PÓS-VENDA (marcada 'pos' em wa_sale_types, ex.: wa5/2030).
// A IA atua APENAS nas linhas de pré-venda — nunca no pós-venda (2030).
async function isPosLine(lineId) {
  try {
    const stRow = await getRow("SELECT value FROM app_settings WHERE key = 'wa_sale_types'");
    let map = {}; try { map = stRow && stRow.value ? JSON.parse(stRow.value) : {}; } catch (e) { map = {}; }
    return map[lineId] === 'pos';
  } catch (e) { return false; }
}

async function processNovoBacklog(limit) {
  const cfg = await getAiSettings();
  if (!cfg || !cfg.enabled || !cfg.novo_enabled || !cfg.gemini_key) {
    return { ok: false, reason: 'A IA dos Novo Leads está desligada (Configurações → IA).' };
  }
  const cap = Math.max(1, Math.min(50, Number(limit) || 25));
  const leads = await allRows("SELECT * FROM leads WHERE archived = 0 AND stage = 'novo' ORDER BY createdAt ASC");
  let sent = 0, moved = 0, done = 0; const skipped = [];
  for (const lead of leads) {
    if (done >= cap) break;
    try {
      // Casa a conversa por JID exato; só por telefone se houver telefone (>=8 dígitos).
      // (Sem isso, lead sem telefone casava com LIKE '%' = qualquer conversa → resposta no contato errado.)
      const sn = (lead.phone || '').replace(/\D/g, '');
      let convo = null;
      if (lead.whatsapp_jid) {
        convo = await getRow("SELECT * FROM conversations WHERE whatsapp_jid = ? LIMIT 1", [lead.whatsapp_jid]);
      }
      if (!convo && sn.length >= 8) {
        convo = await getRow("SELECT * FROM conversations WHERE phone IS NOT NULL AND REPLACE(REPLACE(REPLACE(REPLACE(phone,'+',''),' ',''),'-',''),'(','') LIKE ? LIMIT 1", ['%' + sn.slice(-8)]);
      }
      if (!convo) { continue; } // sem conversa identificável → não faz parte do backlog
      // Só responde se o CLIENTE foi o último a falar (está realmente aguardando). Idempotente.
      const lastMsg = await getRow("SELECT `from` FROM messages WHERE conversationId = ? ORDER BY timestamp DESC LIMIT 1", [convo.id]);
      if (!lastMsg || lastMsg.from !== 'them') continue;
      const account = convo.account || lead.account;
      if (await isPosLine(account)) continue; // IA atua só no pré-venda (nunca no 2030/pós)
      const sock = sessions[account];
      if (!sock) { skipped.push((lead.name || lead.id) + ' — linha desconectada'); done++; continue; }
      const jid = convo.whatsapp_jid ? convo.whatsapp_jid
        : (String(convo.phone || '').includes('@') ? convo.phone : sanitizePhoneNumber(convo.phone) + '@s.whatsapp.net');
      const ai = await getNovoLeadReply(convo.id, lead.name);
      if (!ai || !ai.reply) { skipped.push((lead.name || lead.id) + ' — IA não retornou resposta'); done++; continue; }
      let outOfHours = false;
      try {
        const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
        const wd = p.find(x => x.type === 'weekday').value;
        const h = parseInt(p.find(x => x.type === 'hour').value, 10);
        const open = (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd) && h >= 9 && h < 18) || (wd === 'Sat' && h >= 9 && h < 13);
        outOfHours = !open;
      } catch (e) {}
      let replyText = ai.reply;
      if (ai.dados_coletados && ai.visa_tag && outOfHours) {
        replyText += '\n\n⏰ Nosso horário de atendimento é de segunda a sexta, das 9h às 18h, e aos sábados, das 9h às 13h. No momento estamos fora do horário, mas em breve um de nossos consultores dará continuidade ao seu atendimento. 🙏';
      }
      const sentAi = await sock.sendMessage(jid, { text: replyText });
      const aiMsgId = (sentAi && sentAi.key && sentAi.key.id) || ('m_' + Math.random().toString(36).substr(2, 9));
      _aiSentIds.add(aiMsgId);
      if (_aiSentIds.size > 500) { const first = _aiSentIds.values().next().value; _aiSentIds.delete(first); }
      const tAi = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      await runQuery(
        "INSERT OR IGNORE INTO messages (id, conversationId, `from`, text, time, timestamp, status, ai, our_number) VALUES (?, ?, 'me', ?, ?, ?, 2, 1, ?)",
        [aiMsgId, convo.id, replyText, tAi, Date.now(), sockNumber(sock)]
      );
      await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [tAi, convo.id]);
      await runQuery("UPDATE leads SET lastClientReply = NULL WHERE id = ?", [lead.id]);
      sent++; done++;
      if (ai.dados_coletados && ai.visa_tag) {
        await runQuery("UPDATE leads SET stage = 'tratamento', priority = 'novolead', tags = ? WHERE id = ? AND stage = 'novo'", [JSON.stringify([ai.visa_tag]), lead.id]);
        await logHistory(lead.id, lead.phone, lead.name, 'movimentacao', 'Movido para "Tratamento inicial" (atendimento automático da IA)', { to: 'tratamento' });
        moved++;
      }
      console.log(`[IA backlog] respondido: "${lead.name}"${(ai.dados_coletados && ai.visa_tag) ? ' (→ Tratamento)' : ''}.`);
    } catch (e) {
      skipped.push((lead.name || lead.id) + ' — erro: ' + (e && e.message));
    }
  }
  return { ok: true, candidatos: leads.length, respondidos: sent, movidos: moved, pulados: skipped };
}

module.exports = {
  sendWhatsAppMedia,
  connectWhatsApp,
  disconnectWhatsApp,
  sendWhatsAppMessage,
  sendWhatsAppAudio,
  editWhatsAppMessage,
  deleteWhatsAppMessage,
  processNovoBacklog,
  initSessions,
  sessions,
  sessionQrs,
  MEDIA_DIR,
  AVATAR_DIR,
  avatarFileForJid,
  fetchAndStoreAvatar
};
