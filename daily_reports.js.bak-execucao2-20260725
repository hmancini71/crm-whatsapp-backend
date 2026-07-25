// execucao1 Sprint1 (2026-07-25): RELATÓRIO DIÁRIO de leads — ranking do mais quente ao menos
// quente, por ambiente (pré-venda e pós-venda), gerado às 8h (America/Sao_Paulo) pelo scheduler
// do index.js e gravado na tabela ai_reports (type 'daily-pre' / 'daily-pos').
// Modelado no reports.js (Relatório crítico): mesma API Anthropic (callClaude), mesmos limites
// de chunk. Diferença: o markdown final é montado AQUI em JS (sem chamada "reduce") — só as
// análises por lead passam pelo modelo.
const crypto = require('crypto');
const { runQuery, getRow, allRows } = require('./db');
const { getAiSettings } = require('./ai');
const { callClaude } = require('./reports');

const CHUNK_SIZE = 8;           // mesmos limites do reports.js (folga p/ thinking do modelo)
const LEAD_CAP = 80;            // por ambiente, priorizando conversas mais ativas
const MAX_MSGS_PER_LEAD = 50;
const MAX_CHARS_PER_LEAD = 2500;
const MAP_MAX_TOKENS = 3000;
const JANELA_MS = 72 * 3600 * 1000; // atividade das últimas 72h define quem entra no relatório

// Dependências do index.js injetadas no boot (regra pré/pós NUNCA é duplicada aqui).
let _deps = null;
function init(deps) { _deps = deps; } // { posLineInfo, POS_STAGES }

const newId = () => crypto.randomBytes(12).toString('hex');
const hojeSPiso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dataBR = (iso) => { const [y, m, d] = String(iso).split('-'); return d + '/' + m + '/' + y; };

async function setReport(id, fields) {
  const cur = await getRow("SELECT * FROM ai_reports WHERE id = ?", [id]);
  const next = Object.assign({}, cur, fields);
  await runQuery("UPDATE ai_reports SET status=?, progress=?, result=?, error=? WHERE id=?",
    [next.status, next.progress, next.result, next.error, id]);
}

// Um lead pertence ao ambiente PÓS se: está na ponte, tem pos_stage de coluna pós, ou é de linha 2030.
function isPosLead(l, posSet, posDigits) {
  if (l.bridge === 1) return true;
  if (l.pos_stage && _deps.POS_STAGES.includes(l.pos_stage)) return true;
  if (posSet.has(l.account)) return true;
  const rn = String(l.recv_number || '').replace(/\D/g, '');
  return !!(rn && posDigits.some(d => rn.endsWith(d)));
}

// Seleciona os leads do ambiente com atividade nas últimas 72h (msgs ou criação recente).
async function findCandidates(env) {
  const { posSet, posDigits } = await _deps.posLineInfo();
  const all = await allRows("SELECT * FROM leads WHERE archived = 0");
  const doEnv = all.filter(l => {
    const pos = isPosLead(l, posSet, posDigits);
    if (env === 'pos') return pos;
    return !pos && !['convertida', 'declinado'].includes(l.stage);
  });
  const convs = await allRows("SELECT id, account, phone, whatsapp_jid FROM conversations WHERE (archived IS NULL OR archived = 0)");
  const norm = (p) => String(p || '').replace(/\D/g, '');
  const since = Date.now() - JANELA_MS;
  const out = [];
  for (const l of doEnv) {
    const lt = norm(l.phone).slice(-8);
    const conv = convs.find(c =>
      (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
      (lt.length === 8 && norm(c.phone).slice(-8) === lt));
    let msgs = [];
    if (conv) {
      msgs = await allRows("SELECT `from`, text, timestamp FROM messages WHERE conversationId = ? AND timestamp >= ? ORDER BY timestamp ASC", [conv.id, since]);
    }
    const novo = Date.parse(l.createdAt || '') >= since;
    if (msgs.length > 0 || novo) out.push({ lead: l, msgs });
  }
  out.sort((a, b) => b.msgs.length - a.msgs.length);
  return { picked: out.slice(0, LEAD_CAP), total: out.length };
}

function buildLeadContext(item) {
  const l = item.lead;
  const msgs = item.msgs.slice(-MAX_MSGS_PER_LEAD);
  let lines = msgs.map(m => (m.from === 'me' ? 'VENDEDOR: ' : 'CLIENTE: ') + String(m.text || '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 'VENDEDOR: '.length);
  let text = lines.join('\n');
  if (text.length > MAX_CHARS_PER_LEAD) text = text.slice(text.length - MAX_CHARS_PER_LEAD);
  const meta = [
    'Lead: ' + (l.name || '(sem nome)'),
    'Etapa: ' + (l.pos_stage || l.stage || '?'),
    'Origem: ' + (l.source || 'não informado'),
    'Nota: ' + (l.score || 'sem nota'),
    'Pagamento: ' + (l.status_pagamento || 'lead')
  ].join(' | ');
  return meta + '\nConversa (últimas 72h):\n' + (text || '(lead novo, sem mensagens no período)');
}

const MAP_SYSTEM = `Você é um analista sênior de vendas/CRM da Vale Visto (consultoria de vistos e imigração).
Receberá um lote de conversas de WhatsApp entre VENDEDOR e CLIENTES das últimas 72 horas.
Para CADA lead, avalie o quão QUENTE ele está AGORA (probabilidade de fechar/urgência de atenção) e resuma a situação.
Responda APENAS um array JSON, um objeto por lead, no formato:
[{"lead":"nome","temperatura_0_100":N,"situacao":"1 frase objetiva do momento atual","pendencia":"o que está travado/aguardando (ou null)","proximo_passo":"ação concreta recomendada ao vendedor"}]
Critérios de temperatura: cliente aguardando resposta, prazo de viagem próximo, pediu preço/proposta, pagamento em andamento = quente; sumiu há dias, respostas frias, fora de escopo = frio.
Baseie-se SOMENTE no texto. Não inclua nada fora do JSON.`;

function montaMarkdown(env, dia, itens, total) {
  const label = env === 'pos' ? 'Pós-venda' : 'Pré-venda';
  itens.sort((a, b) => (b.temperatura_0_100 || 0) - (a.temperatura_0_100 || 0));
  const q = itens.filter(i => (i.temperatura_0_100 || 0) >= 70).length;
  const m = itens.filter(i => (i.temperatura_0_100 || 0) >= 40 && (i.temperatura_0_100 || 0) < 70).length;
  const f = itens.length - q - m;
  const linhas = [];
  linhas.push('# Relatório diário — ' + label + ' — ' + dataBR(dia));
  linhas.push('');
  linhas.push('**' + itens.length + ' leads analisados** (' + total + ' com atividade nas últimas 72h) — 🔥 ' + q + ' quentes · 🌤️ ' + m + ' mornos · ❄️ ' + f + ' frios. Do mais quente ao menos quente:');
  linhas.push('');
  for (const i of itens) {
    const t = Number(i.temperatura_0_100) || 0;
    const ico = t >= 70 ? '🔥' : (t >= 40 ? '🌤️' : '❄️');
    linhas.push('## ' + ico + ' ' + t + '° — ' + (i.lead || '(sem nome)'));
    if (i.situacao) linhas.push('- **Situação:** ' + i.situacao);
    if (i.pendencia) linhas.push('- **Pendência:** ' + i.pendencia);
    if (i.proximo_passo) linhas.push('- **Próximo passo:** ' + i.proximo_passo);
    linhas.push('');
  }
  if (!itens.length) linhas.push('_Nenhum lead com atividade nas últimas 72h neste ambiente._');
  return linhas.join('\n');
}

async function runOne(env, dia) {
  const type = env === 'pos' ? 'daily-pos' : 'daily-pre';
  // 1 job por vez por tipo (mesmo padrão do reports.js).
  const running = await getRow("SELECT id FROM ai_reports WHERE type = ? AND status IN ('queued','running') LIMIT 1", [type]);
  if (running) { console.log('[daily-report]', type, 'já em andamento — pulando.'); return null; }
  const id = newId();
  await runQuery(
    "INSERT INTO ai_reports (id, type, period_from, period_to, status, progress, result, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, type, dia, dia, 'running', 'selecionando leads…', null, null, new Date().toISOString()]
  );
  try {
    const cfg = await getAiSettings();
    if (!cfg.anthropic_key) throw new Error('chave Anthropic não configurada');
    const model = cfg.anthropic_model || 'claude-fable-5';
    const { picked, total } = await findCandidates(env);
    const evid = [];
    const chunks = [];
    for (let i = 0; i < picked.length; i += CHUNK_SIZE) chunks.push(picked.slice(i, i + CHUNK_SIZE));
    for (let i = 0; i < chunks.length; i++) {
      await setReport(id, { status: 'running', progress: 'lote ' + (i + 1) + '/' + chunks.length });
      const userText = chunks[i].map((it, x) => '--- LEAD ' + (x + 1) + ' ---\n' + buildLeadContext(it)).join('\n\n');
      const out = await callClaude(cfg.anthropic_key, model, MAP_MAX_TOKENS, MAP_SYSTEM, userText);
      let parsed;
      try { const mm = out.match(/\[[\s\S]*\]/); parsed = JSON.parse(mm ? mm[0] : out); }
      catch (e) { parsed = []; }
      evid.push(...(Array.isArray(parsed) ? parsed : []));
    }
    const md = montaMarkdown(env, dia, evid, total);
    await setReport(id, { status: 'done', progress: 'concluído', result: md, error: null });
    console.log('[daily-report]', type, dia, 'concluído:', evid.length, 'leads.');
    return id;
  } catch (e) {
    console.error('[daily-report]', type, 'erro:', e && e.message);
    await setReport(id, { status: 'error', progress: null, error: (e && e.message) || 'erro desconhecido' });
    return null;
  }
}

// Gera os DOIS relatórios do dia (pré e pós), em sequência para não concorrer na API.
async function runDailyReports(dia) {
  if (!_deps) { console.error('[daily-report] init() não foi chamado — abortado.'); return; }
  const d = dia || hojeSPiso();
  await runOne('pre', d);
  await runOne('pos', d);
}

function listDaily(env, limit) {
  const type = env === 'pos' ? 'daily-pos' : 'daily-pre';
  return allRows("SELECT id, type, period_from, period_to, status, progress, error, created_at FROM ai_reports WHERE type = ? ORDER BY created_at DESC LIMIT ?", [type, limit || 30]);
}
function latestDaily(env) {
  const type = env === 'pos' ? 'daily-pos' : 'daily-pre';
  return getRow("SELECT * FROM ai_reports WHERE type = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1", [type]);
}
function getDaily(id) {
  return getRow("SELECT * FROM ai_reports WHERE id = ? AND type IN ('daily-pre','daily-pos')", [id]);
}

module.exports = { init, runDailyReports, listDaily, latestDaily, getDaily, hojeSPiso };
