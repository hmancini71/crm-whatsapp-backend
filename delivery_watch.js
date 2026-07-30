// ===========================================================================
// delivery_watch.js — v506 · VIGIA DE ENTREGA (dirigido a evento)
//
// PROBLEMA: o WhatsApp aceita a mensagem (status 2 = 1 tique) e, quando o
// endereço @lid pertence a OUTRA linha nossa, nunca entrega. O CRM mostrava
// "enviado" e o cliente não recebia nada. O caso Samira passou CINCO DIAS
// assim sem ninguém perceber.
//
// POR QUE NÃO UMA VARREDURA PERIÓDICA: o sinal aqui é a AUSÊNCIA de um
// evento (o recibo que nunca chega). Varrer de hora em hora é caro, atrasa o
// aviso e só olha para trás. Aqui a ausência VIRA um evento: cada envio arma
// um relógio SÓ PARA AQUELA MENSAGEM; o recibo desarma. Se o relógio vence,
// isso É o alerta. Nada roda quando não há nada errado.
//
// CICLO DE VIDA DE UM ALERTA
//   envio          -> arm(msgId, sentAt)         relógio de 3h para a mensagem
//   recibo (>=3)   -> disarm(msgId, st)          cancela e resolve sozinho
//   relógio vence  -> _fire(msgId)               grava linha em delivery_alerts
//   boot do pm2    -> init()                     rearma as últimas 24h
//
// O rearme no boot é RECUPERAÇÃO de restart, não rotina periódica: roda uma
// única vez, quando o processo sobe, para que um `pm2 restart` não apague os
// relógios que estavam em memória.
// ===========================================================================
const { runQuery, getRow, allRows } = require('./db');

// 3h é o mesmo limiar do aviso visual do v505 — os dois têm que concordar,
// senão o card mostra vermelho e o contador diz que está tudo bem.
const WATCH_MS = 3 * 60 * 60 * 1000;
// No boot só reconsideramos as últimas 24h. Sem esse teto o primeiro restart
// criaria ~700 alertas de histórico de uma vez e o contador viraria ruído.
const REARM_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_REARM = 500;

const _timers = new Map(); // msgId -> Timeout

async function ensureTable() {
  await runQuery(`CREATE TABLE IF NOT EXISTS delivery_alerts (
    msg_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    our_number TEXT,
    owner_line TEXT,
    sent_at INTEGER,
    alerted_at INTEGER,
    resolved_at INTEGER,
    resolved_by TEXT
  )`);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_delivery_alerts_open ON delivery_alerts (resolved_at, sent_at)");
}

function _clear(msgId) {
  const t = _timers.get(msgId);
  if (t) { clearTimeout(t); _timers.delete(msgId); }
}

// O relógio de UMA mensagem venceu. Antes de alertar, relê o status no banco:
// o recibo pode ter chegado no meio do caminho (corrida, restart, replay).
async function _fire(msgId) {
  _timers.delete(msgId);
  try {
    const m = await getRow(
      "SELECT id, conversationId, status, deleted, timestamp, our_number FROM messages WHERE id = ?",
      [msgId]
    );
    if (!m) return;                                  // mensagem apagada do banco
    if (Number(m.deleted)) return;                   // apagada para todos
    if ((Number(m.status) || 0) > 2) return;         // entregue/lido: nada a alertar
    // v513: se JA entregamos algo DEPOIS desta nesta mesma conversa, o cliente
    // esta alcancavel e este tique solitario nao e problema de entrega — nao vira
    // alerta. Caso Christyan: o "Ola" das 18:57 preso na linha muda continuava em
    // vermelho mesmo depois de a mensagem longa das 22:08 ser entregue a ele.
    const _depois = await getRow(
      "SELECT 1 AS x FROM messages WHERE conversationId = ? AND [from] = 'me' AND timestamp > ? AND COALESCE(status,0) >= 3 LIMIT 1",
      [m.conversationId, Number(m.timestamp) || 0]
    );
    if (_depois) return;
    const c = await getRow("SELECT jid_account FROM conversations WHERE id = ?", [m.conversationId]);
    await runQuery(
      "INSERT OR IGNORE INTO delivery_alerts (msg_id, conversation_id, our_number, owner_line, sent_at, alerted_at) VALUES (?, ?, ?, ?, ?, ?)",
      [m.id, m.conversationId, m.our_number || null, (c && c.jid_account) || null, Number(m.timestamp) || null, Date.now()]
    );
    // NUNCA logar o texto da mensagem — só identificadores.
    console.log('[v506] sem confirmacao de entrega: msg ' + msgId + ' / conversa ' + m.conversationId);
  } catch (e) {
    console.error('[v506] falha ao avaliar ' + msgId + ':', e && e.message);
  }
}

// Arma o relógio de UMA mensagem recém-enviada. Idempotente: rearmar a mesma
// mensagem cancela o relógio anterior em vez de acumular dois.
function arm(msgId, sentAt) {
  try {
    if (!msgId) return;
    _clear(msgId);
    const elapsed = Date.now() - (Number(sentAt) || Date.now());
    const wait = Math.max(1000, WATCH_MS - elapsed);
    const t = setTimeout(() => { _fire(msgId).catch(() => {}); }, wait);
    if (t.unref) t.unref(); // um relógio pendente não segura o processo no shutdown
    _timers.set(msgId, t);
  } catch (e) { /* vigia nunca derruba o envio */ }
}

// Chamado por TODO recibo (messages.update e message-receipt.update passam pelo
// mesmo bumpMsgStatus). status >= 3 = entregue: desarma e resolve o alerta se
// já existir — é isso que faz o contador sumir sozinho do CRM.
function disarm(msgId, st) {
  try {
    if (!msgId || (Number(st) || 0) < 3) return;
    _clear(msgId);
    runQuery(
      "UPDATE delivery_alerts SET resolved_at = ?, resolved_by = 'recibo' WHERE msg_id = ? AND resolved_at IS NULL",
      [Date.now(), msgId]
    ).catch(e => console.error('[v506] falha ao resolver alerta ' + msgId + ':', e && e.message));
    // v513: se ESTA mensagem chegou, o cliente esta alcancavel nesta conversa.
    // Qualquer alerta ANTERIOR da mesma conversa e ruido: resolve junto, sem
    // pedir nada na tela. Caso Christyan: o "Ola" das 18:57 (linha muda) sai do
    // vermelho no momento em que a mensagem das 22:08 e entregue.
    runQuery(
      "UPDATE delivery_alerts SET resolved_at = ?, resolved_by = 'entregue depois' WHERE resolved_at IS NULL AND conversation_id = (SELECT conversationId FROM messages WHERE id = ?) AND sent_at < (SELECT timestamp FROM messages WHERE id = ?)",
      [Date.now(), msgId, msgId]
    ).catch(e => console.error('[v513] falha ao resolver alertas anteriores de ' + msgId + ':', e && e.message));
  } catch (e) { /* vigia nunca derruba o recibo */ }
}

// RECUPERAÇÃO DE RESTART (não é rotina periódica): roda uma vez no boot e
// rearma o que ainda estava sem recibo. O que já passou das 3h dispara quase
// imediatamente; o resto espera o tempo que falta.
async function init() {
  await ensureTable();
  const since = Date.now() - REARM_WINDOW_MS;
  const rows = await allRows(
    "SELECT id, timestamp FROM messages WHERE `from` = 'me' AND COALESCE(status,0) <= 2 " +
    "AND COALESCE(deleted,0) = 0 AND timestamp > ? ORDER BY timestamp DESC LIMIT ?",
    [since, MAX_REARM]
  );
  for (const r of (rows || [])) arm(r.id, r.timestamp);
  console.log('[v506] vigia de entrega ativo: ' + ((rows && rows.length) || 0) + ' mensagem(ns) das ultimas 24h sob observacao.');
  return (rows && rows.length) || 0;
}

// Alertas em aberto, do mais recente para o mais antigo. O filtro por
// COALESCE(m.status,0) <= 2 é rede de segurança: se um recibo entrou por um
// caminho que não passou pelo disarm, o alerta some da lista mesmo assim.
async function listOpen(limit) {
  return await allRows(
    "SELECT a.msg_id, a.conversation_id, a.our_number, a.owner_line, a.sent_at, a.alerted_at, " +
    "       m.type AS type, m.status AS status, substr(COALESCE(m.text,''), 1, 120) AS preview, " +
    "       c.name AS conv_name, c.phone AS conv_phone, c.account AS conv_account " +
    "  FROM delivery_alerts a " +
    "  LEFT JOIN messages m ON m.id = a.msg_id " +
    "  LEFT JOIN conversations c ON c.id = a.conversation_id " +
    " WHERE a.resolved_at IS NULL AND COALESCE(m.status,0) <= 2 AND COALESCE(m.deleted,0) = 0 " +
    " ORDER BY a.sent_at DESC LIMIT ?",
    [Number(limit) || 200]
  );
}

async function countOpen() {
  const r = await getRow(
    "SELECT COUNT(*) AS n FROM delivery_alerts a LEFT JOIN messages m ON m.id = a.msg_id " +
    " WHERE a.resolved_at IS NULL AND COALESCE(m.status,0) <= 2 AND COALESCE(m.deleted,0) = 0"
  );
  return (r && r.n) || 0;
}

// Baixa manual: para a mensagem que realmente nunca vai ser entregue (cliente
// bloqueou, número morto). Sem isso o contador ficaria preso para sempre.
// v511: 'motivo' registra POR QUE o alerta saiu da lista — 'manual' (clique em Dar baixa),
// 'reenvio' (a mensagem foi reenviada) ou 'entregue' (chegou antes do clique).
async function dismiss(msgId, motivo) {
  await runQuery(
    "UPDATE delivery_alerts SET resolved_at = ?, resolved_by = ? WHERE msg_id = ? AND resolved_at IS NULL",
    [Date.now(), motivo || 'manual', msgId]
  );
  _clear(msgId);
  return true;
}

async function dismissAll() {
  const r = await runQuery(
    "UPDATE delivery_alerts SET resolved_at = ?, resolved_by = 'manual' WHERE resolved_at IS NULL",
    [Date.now()]
  );
  return (r && r.changes) || 0;
}

module.exports = { init, arm, disarm, listOpen, countOpen, dismiss, dismissAll, WATCH_MS };
