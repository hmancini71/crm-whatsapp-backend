// ===========================================================================
// outbox.js — v508 · FILA DE SAÍDA ("conectou, mandou mensagem")
//
// PROBLEMA QUE ISTO RESOLVE (pedido do Henry, 29/07/2026):
//   Até o v507, quando a linha DONA do endereço @lid estava fora do ar — mesmo
//   que fosse por 11 segundos, no meio de uma reconexão — o CRM devolvia 409 e
//   jogava uma tarja vermelha na cara do atendente mandando reconectar. Ele
//   tinha razão: a linha JÁ ESTAVA conectada, a queda era um piscar, e o aviso
//   virou ruído. Aviso não entrega mensagem.
//
// REGRA A PARTIR DAQUI: o envio nunca é recusado por linha fora do ar. A
// mensagem entra na fila, aparece no chat com relógio, e sai SOZINHA no
// instante em que a linha volta. Sem tarja, sem clique, sem repetir o texto.
//
// A fila NÃO desvia de linha: o dono do endereço continua sendo o dono (v504).
// Ela só espera. Se em 24h a linha não voltar, a mensagem é marcada como
// falha e o vigia de entrega (delivery_watch) cuida do alerta.
// ===========================================================================
const path = require('path');
const fs = require('fs');
const { runQuery, getRow, allRows } = require('./db');

const TICK_MS = 6000;                        // olha a fila a cada 6s
const GIVEUP_MS = 24 * 60 * 60 * 1000;       // 24h esperando = desiste
let _timer = null;
let _busy = false;

async function ensureTable() {
  await runQuery(`CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    msg_id TEXT,
    conversation_id TEXT,
    account TEXT,
    kind TEXT,
    text TEXT,
    quoted_id TEXT,
    file_path TEXT,
    mimetype TEXT,
    file_name TEXT,
    created_at INTEGER,
    tries INTEGER DEFAULT 0,
    sent_at INTEGER,
    failed_at INTEGER,
    last_error TEXT
  )`);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_outbox_open ON outbox (sent_at, failed_at, created_at)");
}

function _rid(p) { return p + Math.random().toString(36).slice(2, 11); }
function _hora() { return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function _lineOpen(acc) {
  try {
    const { sessions } = require('./whatsapp');
    return !!(sessions[acc] && sessions[acc].ws && sessions[acc].ws.isOpen);
  } catch (e) { return false; }
}

// Extensão do arquivo em fila. Precisa bater com o que o WhatsApp vai receber
// depois, senão o arquivo volta do disco com o mime errado.
function _ext(kind, mimetype, fileName) {
  const m = String(mimetype || '').toLowerCase();
  if (kind === 'audio') return m.includes('ogg') ? '.ogg' : (m.includes('mp4') ? '.mp4' : '.webm');
  const e = path.extname(fileName || '');
  if (e) return e;
  if (m.startsWith('image/')) return '.jpg';
  if (m.startsWith('video/')) return '.mp4';
  return '.bin';
}
function _tipo(kind, mimetype) {
  if (kind === 'audio') return 'audio';
  const m = String(mimetype || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

// Coloca um envio na fila e devolve o objeto que o chat mostra AGORA.
// A mensagem entra em messages com status 0 (relógio) — o mesmo desenho que o
// WhatsApp usa para "saindo". Quando sai de verdade, esta linha é apagada e
// fica só a mensagem real gravada pelo sendWhatsApp*.
// o = { convoId, account, kind:'text'|'audio'|'media', text, quotedId, buffer, mimetype, fileName }
async function enqueue(o) {
  await ensureTable();
  const id = _rid('o_');
  const msgId = _rid('q_');
  const ts = Date.now();
  const hora = _hora();
  let filePath = null;
  let tipo = 'text';
  let texto = o.text || '';
  if (o.buffer) {
    const { MEDIA_DIR } = require('./whatsapp');
    tipo = _tipo(o.kind, o.mimetype);
    filePath = path.join(MEDIA_DIR, msgId + _ext(o.kind, o.mimetype, o.fileName));
    fs.writeFileSync(filePath, o.buffer);
    texto = o.kind === 'audio' ? '[Mensagem de voz]' : (o.fileName || '[Arquivo]');
  }
  await runQuery(
    "INSERT INTO messages (id, conversationId, `from`, text, time, timestamp, type, mediaPath, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
    [msgId, o.convoId, 'me', texto, hora, ts, tipo, filePath]
  );
  await runQuery(
    "INSERT INTO outbox (id, msg_id, conversation_id, account, kind, text, quoted_id, file_path, mimetype, file_name, created_at, tries) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)",
    [id, msgId, o.convoId, o.account, o.kind, o.text || null, o.quotedId || null, filePath, o.mimetype || null, o.fileName || null, ts]
  );
  await runQuery("UPDATE conversations SET lastTime = ? WHERE id = ?", [hora, o.convoId]);
  console.log(`[outbox] na fila: ${o.kind} para ${o.convoId} pela linha ${o.account} (aguardando a linha voltar)`);
  return { id: msgId, conversationId: o.convoId, from: 'me', text: texto, time: hora, timestamp: ts, type: tipo, status: 0, pendente: true };
}

// Um item da fila. Só sai quando a linha DONA está aberta — nunca por outra.
async function _enviar(row) {
  const wa = require('./whatsapp');
  if (row.kind === 'text') {
    return await wa.sendWhatsAppMessage(row.account, row.conversation_id, row.text, row.quoted_id || undefined);
  }
  const buf = fs.readFileSync(row.file_path);
  if (row.kind === 'audio') return await wa.sendWhatsAppAudio(row.account, row.conversation_id, buf);
  return await wa.sendWhatsAppMedia(row.account, row.conversation_id, buf, row.mimetype, row.file_name);
}

async function flush() {
  if (_busy) return;
  _busy = true;
  try {
    const rows = await allRows(
      "SELECT * FROM outbox WHERE sent_at IS NULL AND failed_at IS NULL ORDER BY created_at ASC LIMIT 40"
    );
    for (const row of rows) {
      const idade = Date.now() - (Number(row.created_at) || 0);
      if (!_lineOpen(row.account)) {
        if (idade > GIVEUP_MS) {
          await runQuery("UPDATE outbox SET failed_at = ?, last_error = ? WHERE id = ?",
            [Date.now(), 'linha fora do ar por mais de 24h', row.id]);
          console.log(`[outbox] desistiu de ${row.msg_id}: linha ${row.account} fora do ar ha 24h`);
        }
        continue;
      }
      try {
        await _enviar(row);
        await runQuery("DELETE FROM messages WHERE id = ?", [row.msg_id]);   // tira o provisório
        if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch (e) {} }
        await runQuery("UPDATE outbox SET sent_at = ? WHERE id = ?", [Date.now(), row.id]);
        console.log(`[outbox] saiu sozinha: ${row.kind} de ${row.conversation_id} pela linha ${row.account} apos ${Math.round(idade / 1000)}s na fila`);
      } catch (e) {
        const t = (Number(row.tries) || 0) + 1;
        await runQuery("UPDATE outbox SET tries = ?, last_error = ? WHERE id = ?", [t, String(e && e.message || e).slice(0, 300), row.id]);
        if (t >= 8) {
          await runQuery("UPDATE outbox SET failed_at = ? WHERE id = ?", [Date.now(), row.id]);
          console.log(`[outbox] desistiu de ${row.msg_id} apos 8 tentativas: ${String(e && e.message || e).slice(0, 120)}`);
        }
      }
    }
  } catch (e) { console.error('[outbox] flush:', e && e.message); }
  _busy = false;
}

// Liga a fila. Chamado uma vez no boot, ao lado do delivery_watch.
async function start() {
  await ensureTable();
  if (_timer) return;
  _timer = setInterval(() => { flush().catch(() => {}); }, TICK_MS);
  console.log('[outbox] fila de saida ativa (tick ' + TICK_MS + 'ms)');
  flush().catch(() => {});
}

module.exports = { ensureTable, enqueue, flush, start };
