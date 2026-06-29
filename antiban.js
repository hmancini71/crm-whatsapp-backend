// ===================== Governador anti-banimento do WhatsApp =====================
// Postura CONSERVADORA (máxima segurança). Centraliza as proteções que reduzem o risco
// de bloqueio pela Meta nos DISPAROS do CRM:
//   - pacing: intervalo grande + jitter entre mensagens do MESMO número (sem rajada)
//   - cap diário por número, com WARM-UP (número novo manda pouco e sobe aos poucos)
//   - cap por hora por número
//   - horário comercial (não dispara proativo fora do expediente)
//   - variação de texto (evita mensagens byte-a-byte idênticas em massa)
//   - comportamento humano (marca "lido" + presença "digitando" + pausa antes de responder)
//
// Persistência dos caps em SQLite (sobrevive a restart): tabelas wa_send_stats e wa_account_age (db.js).
const { runQuery, getRow } = require('./db');

// --- Parâmetros (conservador) -------------------------------------------------
const CFG = {
  minGapMs: 20000,          // intervalo MÍNIMO entre envios do mesmo número
  maxGapMs: 60000,          // ... com jitter até este teto (20–60s)
  hourlyCap: 12,            // máx. mensagens/HORA por número
  warmupDailyByDay: [15, 25, 40, 60, 80], // cap DIÁRIO por idade do número (dia 1..5)
  dailyCapMature: 100,      // cap diário após o warm-up (dia 6+)
  humanizeMinMs: 1500,      // "digitando" antes de responder
  humanizeMaxMs: 5000,
};

// Data YYYY-MM-DD no fuso de São Paulo (en-CA já entrega nesse formato).
function _ymd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

// Expediente: seg–sex 9–18h, sáb 9–13h (BRT). Domingo fechado.
function isBusinessHours(d = new Date()) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(d);
    const wd = p.find(x => x.type === 'weekday').value;
    const h = parseInt(p.find(x => x.type === 'hour').value, 10);
    return (['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(wd) && h >= 9 && h < 18)
        || (wd === 'Sat' && h >= 9 && h < 13);
  } catch (e) { return true; }
}

const _lastSendAt = {};   // accountId -> ts do último envio (pacing em memória)
const _hourly = {};       // accountId -> { hourKey, count }

async function _dailyCount(accountId) {
  try {
    const r = await getRow("SELECT count FROM wa_send_stats WHERE account_id = ? AND ymd = ?", [accountId, _ymd()]);
    return (r && r.count) || 0;
  } catch (e) { return 0; }
}
async function _ageDays(accountId) {
  try {
    const r = await getRow("SELECT first_send_at FROM wa_account_age WHERE account_id = ?", [accountId]);
    if (!r || !r.first_send_at) return 0; // nunca disparou → 1º dia (idade 0)
    return Math.max(0, Math.floor((Date.now() - new Date(r.first_send_at).getTime()) / 86400000));
  } catch (e) { return 0; }
}

async function dailyCap(accountId) {
  const age = await _ageDays(accountId);
  return age >= CFG.warmupDailyByDay.length ? CFG.dailyCapMature : CFG.warmupDailyByDay[age];
}

// Pode fazer um disparo PROATIVO agora? (cap diário + cap horário). Não bloqueia resposta reativa.
async function canSendProactive(accountId) {
  const cap = await dailyCap(accountId);
  const used = await _dailyCount(accountId);
  if (used >= cap) return { ok: false, reason: `cap diário do número atingido (${used}/${cap}) — proteção/warm-up` };
  const hk = _ymd() + ':' + new Date().getHours();
  const h = _hourly[accountId];
  const hc = (h && h.hourKey === hk) ? h.count : 0;
  if (hc >= CFG.hourlyCap) return { ok: false, reason: `cap por hora atingido (${hc}/${CFG.hourlyCap})` };
  return { ok: true };
}

// Registra um envio (para os caps) e define first_send_at na 1ª vez.
async function recordSend(accountId) {
  try {
    const ymd = _ymd();
    await runQuery("INSERT OR IGNORE INTO wa_send_stats (account_id, ymd, count) VALUES (?, ?, 0)", [accountId, ymd]);
    await runQuery("UPDATE wa_send_stats SET count = count + 1 WHERE account_id = ? AND ymd = ?", [accountId, ymd]);
    await runQuery("INSERT OR IGNORE INTO wa_account_age (account_id, first_send_at) VALUES (?, ?)", [accountId, new Date().toISOString()]);
  } catch (e) { /* best-effort: nunca quebra o envio */ }
  const hk = _ymd() + ':' + new Date().getHours();
  const h = _hourly[accountId];
  _hourly[accountId] = (h && h.hourKey === hk) ? { hourKey: hk, count: h.count + 1 } : { hourKey: hk, count: 1 };
  _lastSendAt[accountId] = Date.now();
}

// Espera o intervalo (com jitter) desde o último envio DESTE número — evita rajada.
async function pace(accountId) {
  const gap = CFG.minGapMs + Math.floor(Math.random() * (CFG.maxGapMs - CFG.minGapMs));
  const wait = Math.max(0, (_lastSendAt[accountId] || 0) + gap - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

// Varia sutilmente o fim do texto p/ não enviar mensagens idênticas em massa (Meta penaliza isso).
function varyText(text) {
  const tails = ['', ' ', '  ', ' 🙂', ' 🙏', ' ✨', '.'];
  return String(text || '').replace(/\s+$/, '') + tails[Math.floor(Math.random() * tails.length)];
}

// Comportamento humano antes de responder: marca lido (se houver a chave) + "digitando" + pausa.
async function humanize(sock, jid, msgKey) {
  try {
    if (sock && msgKey) { try { await sock.readMessages([msgKey]); } catch (e) {} }
    if (sock && jid) { try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {} }
    await new Promise(r => setTimeout(r, CFG.humanizeMinMs + Math.floor(Math.random() * (CFG.humanizeMaxMs - CFG.humanizeMinMs))));
    if (sock && jid) { try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {} }
  } catch (e) { /* não crítico */ }
}

module.exports = { CFG, isBusinessHours, canSendProactive, recordSend, pace, dailyCap, varyText, humanize };
