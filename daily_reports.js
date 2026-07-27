// execucao1 Sprint1 (2026-07-25): RELATÓRIO DIÁRIO de leads — ranking do mais quente ao menos
// quente, por ambiente (pré-venda e pós-venda), gerado às 8h (America/Sao_Paulo) pelo scheduler
// do index.js e gravado na tabela ai_reports (type 'daily-pre' / 'daily-pos').
// Modelado no reports.js (Relatório crítico): mesma API Anthropic (callClaude), mesmos limites
// de chunk. Diferença: o markdown final é montado AQUI em JS (sem chamada "reduce") — só as
// análises por lead passam pelo modelo.
const crypto = require('crypto');
const { runQuery, getRow, allRows } = require('./db');
const { getAiSettings } = require('./ai');
const { callClaude, callAI } = require('./reports'); // execucao14: callAI = Gemini quando configurado

const CHUNK_SIZE = 8;           // mesmos limites do reports.js (folga p/ thinking do modelo)
const LEAD_CAP = 80;            // por ambiente, priorizando conversas mais ativas
const MAX_MSGS_PER_LEAD = 50;
const MAX_CHARS_PER_LEAD = 2500;
const MAP_MAX_TOKENS = 3000;
const JANELA_MS = 72 * 3600 * 1000; // atividade das últimas 72h define quem entra no relatório

// Dependências do index.js injetadas no boot (regra pré/pós NUNCA é duplicada aqui).
let _deps = null;
function init(deps) { _deps = deps; } // { posLineInfo, POS_STAGES }

// pipeline462 (fix — Henry reportou relatórios travados 'running' pra sempre): o timeout de
// socket do callClaude (reports.js, 120s + 1 retry) depende do socket ficar OCIOSO; se a API
// mandar qualquer byte de keep-alive no meio de uma resposta lenta, o timer reseta e a promise
// NUNCA resolve/rejeita — o job fica 'running' indefinidamente (visto ao vivo numa validação:
// >10min travado no lote 1/10 sem log de erro nenhum). Deadline externo dura (Promise.race)
// garante que o job SEMPRE termina (sucesso ou erro claro) em vez de travar pra sempre.
const HARD_DEADLINE_MS = 280000; // folga acima do pior caso teórico do callClaude (120s x2 + margem)
function withHardDeadline(promise, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Tempo limite (' + Math.round(HARD_DEADLINE_MS / 1000) + 's) excedido aguardando ' + label + ' — a API não respondeu a tempo (trave de rede/keep-alive).')), HARD_DEADLINE_MS);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

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
[{"lead":"nome","temperatura_0_100":N,"situacao":"1 frase objetiva do momento atual","pendencia":"o que está travado/aguardando (ou null)","proximo_passo":"ação concreta recomendada ao vendedor, aplicando boas práticas de conversão (follow-up com prazo marcado, CTA único e claro, ancoragem de valor antes do preço, tratamento direto da objeção)","ambiente_sugerido":"'pre' se a conversa indica cliente ainda DECIDINDO a contratação, 'pos' se indica cliente que JÁ CONTRATOU/pagou/está com trâmite em andamento (DS-160, CASV, agendamento, suporte), ou null se indeterminado"}]
Critérios de temperatura: cliente aguardando resposta, prazo de viagem próximo, pediu preço/proposta, pagamento em andamento = quente; sumiu há dias, respostas frias, fora de escopo = frio.
Baseie-se SOMENTE no texto. Não inclua nada fora do JSON.`;

// execucao3 (2026-07-25, pedido do Henry): seção final de PROPOSTAS E SUGESTÕES do dia, baseada
// nas melhores práticas de atendimento/vendas com foco em CONVERSÃO. Gerada numa 2ª chamada ao
// modelo com o resumo consolidado dos leads do dia (padrões que se repetem > casos isolados).
const SUGG_SYSTEM = `Você é um consultor sênior de vendas consultivas por WhatsApp, especializado em CONVERSÃO para serviços de assessoria de vistos (Vale Visto).
Receberá um JSON com o resumo do dia: cada lead com temperatura (0-100), situação, pendência e próximo passo.
Gere APENAS markdown (sem título de nível 1), com EXATAMENTE três blocos nesta ordem:
### 🩺 Diagnóstico geral — padrões fora das melhores práticas
3 a 6 PADRÕES GERAIS do dia que NÃO se alinham às melhores práticas de atendimento/vendas — SEM citar leads individuais aqui (visão de conjunto): ex. "a maioria das conversas fica sem follow-up com prazo marcado", "preço é passado antes da ancoragem de valor em boa parte dos atendimentos", "tempo médio de 1ª resposta acima do ideal". Cada item "- **Padrão:** explicação em 1-2 frases + qual melhor prática está sendo ferida."
### ⚠️ Problemas de atendimento identificados
3 a 5 problemas CONCRETOS observados no dia, cada um "- **Problema:** explicação em 1-2 frases, citando pelo nome os leads onde ocorre." Procure: demora de resposta, cliente aguardando sem retorno, falta de follow-up com prazo, preço passado sem ancoragem de valor, mensagens sem CTA, respostas genéricas/longas, lead quente esfriando sem ação.
### ✅ Recomendações (melhores práticas)
3 a 6 recomendações CONCRETAS e acionáveis para o time converter mais, baseadas nas melhores práticas de atendimento e vendas: tempo de resposta, follow-up com dia/hora marcados, um único CTA claro por mensagem, ancoragem de valor ANTES do preço, prova social, tratamento direto de objeções, senso de urgência legítimo (prazo de viagem/vaga de agenda), e resgate de leads sumidos.
Formato de cada recomendação: "- **Título curto:** explicação em 1-2 frases, citando pelo nome os leads do dia a que se aplica."
Priorize padrões que se repetem em vários leads; termine com a recomendação nº 1 do dia (a de maior impacto em conversão). Não invente dados — use somente o resumo recebido.`;

// execucao2 (2026-07-25): contato entre parênteses após o nome no ranking — telefone WhatsApp
// ou, na falta dele, o e-mail do lead. Mapa determinístico (nome normalizado → contato) montado
// a partir do banco; o modelo NUNCA gera o contato (evita alucinação de números).
function montaContactMap(picked) {
  const map = {};
  for (const item of picked) {
    const l = item.lead || {};
    const key = String(l.name || '').trim().toLowerCase();
    if (!key || map[key] !== undefined) continue; // nome duplicado: primeiro vence
    map[key] = (l.phone && String(l.phone).trim()) || (l.email && String(l.email).trim()) || null;
  }
  return map;
}

function montaMarkdown(env, dia, itens, total, contactMap, sugestoes) {
  contactMap = contactMap || {};
  const label = env === 'pos' ? 'Pós-venda' : 'Pré-venda';
  itens.sort((a, b) => (b.temperatura_0_100 || 0) - (a.temperatura_0_100 || 0));
  const q = itens.filter(i => (i.temperatura_0_100 || 0) >= 70).length;
  const m = itens.filter(i => (i.temperatura_0_100 || 0) >= 40 && (i.temperatura_0_100 || 0) < 70).length;
  const f = itens.length - q - m;
  // execucao4: normaliza o ambiente sugerido pelo modelo ('pre'|'pos'|null) para a sinalização.
  const ambDe = (i) => { const a = String(i.ambiente_sugerido || '').toLowerCase(); return (a === 'pre' || a === 'pos') ? a : null; };
  const errados = itens.filter(i => ambDe(i) && ambDe(i) !== env).length;
  const linhas = [];
  linhas.push('# Relatório diário — ' + label + ' — ' + dataBR(dia));
  linhas.push('');
  // execucao4 (pedido do Henry): hora de geração + janela coberta pelo relatório.
  const geradoEm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date());
  linhas.push('_Gerado em ' + geradoEm + ' (horário de Brasília) — análise das conversas das últimas ' + Math.round(JANELA_MS / 3600000) + ' horas._');
  linhas.push('');
  linhas.push('**' + itens.length + ' leads analisados** (' + total + ' com atividade nas últimas 72h) — 🔥 ' + q + ' quentes · 🌤️ ' + m + ' mornos · ❄️ ' + f + ' frios. Do mais quente ao menos quente:');
  linhas.push('');
  if (errados > 0) {
    linhas.push('🚨 **' + errados + ' lead(s) possivelmente no AMBIENTE ERRADO** — veja as linhas "⚠️ Ambiente" nos cards abaixo.');
    linhas.push('');
  }
  // execucao10 (pedido do Henry, 2026-07-26): o DIAGNÓSTICO GERAL (padrões vs melhores práticas)
  // vem ANTES dos casos específicos — seção 1 = visão de conjunto; seção 2 = caso a caso.
  if (sugestoes && String(sugestoes).trim()) {
    linhas.push('## 1️⃣ Diagnóstico geral do atendimento (padrões × melhores práticas)');
    linhas.push('');
    linhas.push(String(sugestoes).trim());
    linhas.push('');
    linhas.push('---');
    linhas.push('');
  }
  linhas.push('## 2️⃣ Casos específicos — ranking do mais quente ao menos quente');
  linhas.push('');
  for (const i of itens) {
    const t = Number(i.temperatura_0_100) || 0;
    const ico = t >= 70 ? '🔥' : (t >= 40 ? '🌤️' : '❄️');
    const contato = contactMap[String(i.lead || '').trim().toLowerCase()];
    linhas.push('## ' + ico + ' ' + t + '° — ' + (i.lead || '(sem nome)') + (contato ? ' (' + contato + ')' : ''));
    if (i.situacao) linhas.push('- **Situação:** ' + i.situacao);
    if (i.pendencia) linhas.push('- **Pendência:** ' + i.pendencia);
    if (i.proximo_passo) linhas.push('- **Próximo passo:** ' + i.proximo_passo);
    // execucao4: sinaliza lead cujo teor da conversa indica o OUTRO ambiente (pré↔pós).
    const amb = ambDe(i);
    if (amb && amb !== env) {
      linhas.push('- **⚠️ Ambiente:** a conversa indica ' + (amb === 'pos' ? 'PÓS-VENDA' : 'PRÉ-VENDA') + ' — este lead está no ambiente ' + (env === 'pos' ? 'PÓS-venda' : 'PRÉ-venda') + ' (verificar transferência).');
    }
    linhas.push('');
  }
  if (!itens.length) linhas.push('_Nenhum lead com atividade nas últimas 72h neste ambiente._');
  // execucao10: a seção de diagnóstico/propostas foi MOVIDA para o TOPO (seção 1️⃣, acima).
  return linhas.join('\n');
}

const STALE_RUNNING_MS = 20 * 60 * 1000; // job 'running'/'queued' há mais tempo que isso é considerado morto (ex.: pm2 restart no meio do job) e libera nova tentativa.

async function runOne(env, dia) {
  const type = env === 'pos' ? 'daily-pos' : 'daily-pre';
  // 1 job por vez por tipo (mesmo padrão do reports.js) — MAS com destrava automático de jobs
  // travados (ex.: pm2 restart durante a execução deixava a linha em 'running' pra sempre e
  // bloqueava TODAS as gerações seguintes deste tipo, sem erro nenhum aparecer pro usuário).
  const running = await getRow("SELECT id, created_at FROM ai_reports WHERE type = ? AND status IN ('queued','running') LIMIT 1", [type]);
  if (running) {
    const age = Date.now() - (Date.parse(running.created_at || '') || 0);
    if (age < STALE_RUNNING_MS) { console.log('[daily-report]', type, 'já em andamento — pulando.'); return null; }
    console.warn('[daily-report]', type, 'job', running.id, 'travado há', Math.round(age / 60000), 'min — marcando como erro e liberando nova geração.');
    await runQuery("UPDATE ai_reports SET status='error', progress=NULL, error=? WHERE id=?",
      ['Job travado (processo reiniciado durante a execução?) — marcado como erro automaticamente após ' + Math.round(age / 60000) + ' min sem concluir.', running.id]);
  }
  const id = newId();
  await runQuery(
    "INSERT INTO ai_reports (id, type, period_from, period_to, status, progress, result, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, type, dia, dia, 'running', 'selecionando leads…', null, null, new Date().toISOString()]
  );
  try {
    const cfg = await getAiSettings();
    // execucao14: Gemini (gemini_key, a mesma do atendimento) tem prioridade; Anthropic é fallback.
    if (!cfg.anthropic_key && !cfg.gemini_key) throw new Error('nenhuma chave de IA configurada (Gemini ou Anthropic)');
    // pipeline463 (2026-07-27): este nome de modelo só é USADO por callAI (reports.js) no caminho
    // de FALLBACK (Anthropic) — quando cfg.gemini_key existe, callAI ignora `model` e usa a lista
    // de modelos Gemini (ai.js/GEMINI_MODELS) com fallback próprio. Mantido válido só para não
    // quebrar o caminho Anthropic quando não houver gemini_key.
    const model = cfg.anthropic_model || 'claude-fable-5';
    const { picked, total } = await findCandidates(env);
    const evid = [];
    const chunks = [];
    for (let i = 0; i < picked.length; i += CHUNK_SIZE) chunks.push(picked.slice(i, i + CHUNK_SIZE));
    for (let i = 0; i < chunks.length; i++) {
      await setReport(id, { status: 'running', progress: 'lote ' + (i + 1) + '/' + chunks.length });
      const userText = chunks[i].map((it, x) => '--- LEAD ' + (x + 1) + ' ---\n' + buildLeadContext(it)).join('\n\n');
      const out = await withHardDeadline(callAI(cfg, model, MAP_MAX_TOKENS, MAP_SYSTEM, userText), 'lote ' + (i + 1) + '/' + chunks.length);
      let parsed;
      try { const mm = out.match(/\[[\s\S]*\]/); parsed = JSON.parse(mm ? mm[0] : out); }
      catch (e) {
        // pipeline463: antes este catch sumia em silêncio (parsed=[] sem log) — agora deixa
        // rastro no pm2 (só tamanho da resposta, SEM texto de cliente) para diagnosticar
        // truncamento por maxOutputTokens ou bloqueio de safety em vez de virar relatório pobre
        // sem ninguém perceber.
        console.warn('[daily-report]', type, 'lote', (i + 1) + '/' + chunks.length, ': JSON não parseável (' + (out ? out.length : 0) + ' chars recebidos) — erro:', e.message);
        parsed = [];
      }
      evid.push(...(Array.isArray(parsed) ? parsed : []));
    }
    // execucao3: 2ª chamada — recomendações do dia com base no resumo consolidado dos leads.
    let sugestoes = '';
    if (evid.length) {
      try {
        await setReport(id, { status: 'running', progress: 'gerando propostas e sugestões…' });
        const resumo = JSON.stringify(evid.map(i => ({
          lead: i.lead, temperatura: i.temperatura_0_100, situacao: i.situacao,
          pendencia: i.pendencia, proximo_passo: i.proximo_passo
        })));
        sugestoes = await withHardDeadline(callAI(cfg, model, 2000, SUGG_SYSTEM, resumo), 'propostas e sugestões');
      } catch (e) { console.error('[daily-report] sugestões falharam (relatório sai sem a seção):', e && e.message); sugestoes = ''; }
    }
    const md = montaMarkdown(env, dia, evid, total, montaContactMap(picked), sugestoes);
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
  return allRows("SELECT id, type, period_from, period_to, status, progress, error, created_at, analyzed_at FROM ai_reports WHERE type = ? ORDER BY created_at DESC LIMIT ?", [type, limit || 30]);
}
function latestDaily(env) {
  const type = env === 'pos' ? 'daily-pos' : 'daily-pre';
  return getRow("SELECT * FROM ai_reports WHERE type = ? AND status = 'done' ORDER BY created_at DESC LIMIT 1", [type]);
}
function getDaily(id) {
  return getRow("SELECT * FROM ai_reports WHERE id = ? AND type IN ('daily-pre','daily-pos')", [id]);
}

module.exports = { init, runDailyReports, listDaily, latestDaily, getDaily, hojeSPiso };
