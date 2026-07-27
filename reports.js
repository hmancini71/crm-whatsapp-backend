// pipeline452: "Relatório crítico de conversão" (guia IA) — analisa, via API Anthropic (Claude),
// as conversas de WhatsApp dos leads do "Tratamento inicial" num período e responde: (a)
// principais dificuldades de conversão; (b) nível de qualificação dos leads; (c) principais
// razões pelas quais os leads não fecham; (d) principais gaps no processo de conversão; (e)
// principais deficiências do nosso papel como vendedor.
//
// IMPORTANTE: isto é 100% INDEPENDENTE do loop de IA do Gemini (ai.js) usado no atendimento e
// follow-up do WhatsApp — não reaproveita nem altera nada daquele fluxo, só lê mensagens já
// gravadas no banco. Roda em BACKGROUND (setImmediate + awaits sequenciais) para não travar o
// event loop; só 1 job por vez (checado via status 'queued'/'running' na tabela ai_reports).
const https = require('https');
const crypto = require('crypto');
const { runQuery, getRow, allRows } = require('./db');
const { getAiSettings } = require('./ai');

// pipeline454 (fix bug relatado pelo Henry — "Resposta vazia da API Anthropic"): CHUNK_SIZE
// reduzido de 12 p/ 8 e MAX_CHARS_PER_LEAD de 3500 p/ 2500 como margem de segurança — o modelo
// 'claude-fable-5' usa "thinking" adaptativo que NÃO pode ser desligado (a API rejeita
// thinking.type=disabled p/ este modelo: "Thinking defaults to adaptive mode") e os tokens de
// thinking consomem o mesmo orçamento de max_tokens da resposta; lotes menores dão mais folga
// pro bloco de texto real não ser cortado.
const CHUNK_SIZE = 8;
const LEAD_CAP = 150;
const MAX_MSGS_PER_LEAD = 50;
const MAX_CHARS_PER_LEAD = 2500;
const MAP_MAX_TOKENS = 3000; // pipeline454: era 2000 — mais folga p/ thinking + JSON de saída
const REDUCE_MAX_TOKENS = 4000;

function newId() { return crypto.randomBytes(12).toString('hex'); }

// ===== Chamada REST à API Anthropic (Messages API) =====
function callClaudeOnce(apiKey, model, maxTokens, systemText, userText) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemText || '',
      messages: [{ role: 'user', content: userText }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let j;
        try { j = JSON.parse(data); } catch (e) {
          return reject(new Error('Resposta inválida da API Anthropic (HTTP ' + res.statusCode + '): ' + String(data).slice(0, 200)));
        }
        // pipeline454 (fix): SEMPRE propaga o erro REAL (status + type + message) em vez de
        // esconder atrás de "Resposta vazia" — checa erro/status ANTES de tentar extrair texto.
        if (res.statusCode === 401) return reject(new Error('chave Anthropic inválida'));
        if (j.error) {
          const etype = j.error.type || 'erro';
          const emsg = String(j.error.message || '').slice(0, 300);
          return reject(new Error('Erro da API Anthropic (HTTP ' + res.statusCode + ', ' + etype + '): ' + emsg));
        }
        if (res.statusCode >= 400) {
          return reject(new Error('Erro da API Anthropic (HTTP ' + res.statusCode + '): ' + String(data).slice(0, 300)));
        }
        // pipeline454 (fix): extração ROBUSTA — procura o primeiro bloco type==='text' em vez de
        // fixar content[0] (o modelo 'claude-fable-5' usa "thinking" adaptativo e devolve
        // content=[{type:'thinking',...}, {type:'text', text:'...'}] — content[0].text era
        // sempre undefined, causando o falso "Resposta vazia da API Anthropic").
        const blocks = Array.isArray(j.content) ? j.content : [];
        const textBlock = blocks.find(b => b && b.type === 'text' && b.text);
        if (!textBlock) {
          const kinds = blocks.map(b => b && b.type).join(',') || '(nenhum bloco)';
          return reject(new Error('Resposta vazia da API Anthropic (stop_reason=' + (j.stop_reason || '?') + ', blocos=' + kinds + ') — provavelmente estourou max_tokens antes do texto; tente um período/lote menor.'));
        }
        resolve(textBlock.text);
      });
    });
    req.on('error', (e) => reject(new Error('Falha de rede ao chamar a API Anthropic: ' + e.message)));
    req.on('timeout', () => { try { req.destroy(new Error('Timeout na API Anthropic')); } catch (e) {} });
    req.write(body); req.end();
  });
}

// Retry 1x (só p/ falhas transitórias — não repete em chave inválida).
async function callClaude(apiKey, model, maxTokens, systemText, userText) {
  try {
    return await callClaudeOnce(apiKey, model, maxTokens, systemText, userText);
  } catch (e) {
    if (/chave Anthropic inválida/i.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 1500));
    return await callClaudeOnce(apiKey, model, maxTokens, systemText, userText);
  }
}

// execucao14 (pedido do Henry, 2026-07-26): PROVEDOR DE IA dos relatórios — quando a chave do
// GEMINI está configurada (a MESMA do atendimento WhatsApp, cfg.gemini_key), os relatórios
// (crítico + diários) usam o Gemini (callGemini do ai.js, com fallback de modelo embutido);
// sem gemini_key, cai na Anthropic (callClaude) como antes. Os parsers de JSON dos dois
// relatórios já toleram texto ao redor (regex \[[\s\S]*\]), então a troca é transparente.
// pipeline463 (2026-07-27): os relatórios processam lotes de até 8 leads x 2500 chars (~20.000
// chars) e pedem JSON de até 3000-4000 tokens de saída — MUITO acima dos limites padrão do
// callGemini pensados para mensagens curtas do WhatsApp (4000 chars / 2048 tokens / 30s). Por
// isso passamos opts com limites próprios para o caminho dos relatórios; o atendente de IA do
// WhatsApp (ai.js) não é afetado, pois continua chamando callGemini SEM opts.
// pipeline463 (teste ao vivo, passo 5): com só maxChars/maxOutputTokens/timeoutMs, os lotes
// voltavam com JSON CORTADO NO MEIO na maioria das vezes (ex.: chunk 1/11, 2/11... "Unterminated
// string") e o relatório final saía com só 1 das 5 seções obrigatórias, sem erro visível. Causa:
// o modelo ativo em produção ('gemini-flash-latest') NÃO casa com o regex /2.5/ do ai.js, então
// o "thinking" interno dele consumia a maior parte do maxOutputTokens antes de escrever o JSON —
// o mesmo bug de fundo que motivou o thinkingBudget:0, só que noutro nome de modelo. Corrigido
// pedindo disableThinking:true (ai.js agora aceita isso p/ QUALQUER modelo; o atendente de
// WhatsApp não passa opts, então não é afetado).
const { callGemini } = require('./ai');
async function callAI(cfg, model, maxTokens, systemText, userText) {
  if (cfg && cfg.gemini_key) {
    console.log('[relatorio] motor: Gemini');
    return await callGemini(cfg, systemText, [{ role: 'user', text: userText }], false, {
      maxChars: 60000,
      maxOutputTokens: Math.max(maxTokens || 2048, 2048),
      timeoutMs: 180000,
      disableThinking: true
    });
  }
  console.log('[relatorio] motor: Anthropic (fallback)');
  return await callClaude(cfg.anthropic_key, model, maxTokens, systemText, userText);
}

// ===== Seleção de leads do "Tratamento inicial" no período =====
// Mesmo padrão de join lead→conversa usado em /api/dashboard/response-time (index.js): casa por
// whatsapp_jid exato ou pelos últimos 8 dígitos do telefone.
async function findLeadsAndMessages(fromIso, toIso) {
  const fromTs = new Date(fromIso + 'T00:00:00-03:00').getTime();
  const toTs = new Date(toIso + 'T23:59:59-03:00').getTime();

  const leads = await allRows(
    "SELECT id, name, phone, whatsapp_jid, source, value, tags, createdAt FROM leads WHERE archived = 0 AND stage = 'tratamento'"
  );
  const convs = await allRows("SELECT id, account, phone, whatsapp_jid FROM conversations WHERE (archived IS NULL OR archived = 0)");
  const norm = (p) => String(p || '').replace(/\D/g, '');
  const convByLead = new Map();
  for (const l of leads) {
    const lt = norm(l.phone).slice(-8);
    const conv = convs.find(c =>
      (l.whatsapp_jid && c.whatsapp_jid && c.whatsapp_jid === l.whatsapp_jid) ||
      (lt.length === 8 && norm(c.phone).slice(-8) === lt)
    );
    if (conv) convByLead.set(l.id, conv.id);
  }

  const convIds = Array.from(new Set(Array.from(convByLead.values())));
  if (!convIds.length) return { picked: [], truncated: false, totalCandidates: 0 };

  const ph = convIds.map(() => '?').join(',');
  const msgRows = await allRows(
    "SELECT conversationId, `from`, text, timestamp FROM messages WHERE conversationId IN (" + ph + ") AND timestamp >= ? AND timestamp <= ? ORDER BY conversationId, timestamp ASC",
    [...convIds, fromTs, toTs]
  );
  const msgsByConv = new Map();
  for (const m of msgRows) {
    if (!msgsByConv.has(m.conversationId)) msgsByConv.set(m.conversationId, []);
    msgsByConv.get(m.conversationId).push(m);
  }

  const createdInPeriod = (l) => {
    const t = Date.parse(l.createdAt || '');
    return !isNaN(t) && t >= fromTs && t <= toTs;
  };

  const candidates = [];
  for (const l of leads) {
    const convId = convByLead.get(l.id);
    const msgs = convId ? (msgsByConv.get(convId) || []) : [];
    if (createdInPeriod(l) || msgs.length > 0) {
      candidates.push({ lead: l, msgs });
    }
  }
  // Prioriza quem tem mais mensagens no período (conversas mais ricas p/ a análise) ao cortar.
  candidates.sort((a, b) => b.msgs.length - a.msgs.length);
  const truncated = candidates.length > LEAD_CAP;
  const picked = candidates.slice(0, LEAD_CAP);
  return { picked, truncated, totalCandidates: candidates.length };
}

function buildLeadContext(item) {
  const l = item.lead;
  const msgs = item.msgs.slice(-MAX_MSGS_PER_LEAD);
  let lines = msgs.map(m => (m.from === 'me' ? 'VENDEDOR: ' : 'CLIENTE: ') + String(m.text || '').replace(/\s+/g, ' ').trim())
    .filter(l2 => l2.length > 'VENDEDOR: '.length);
  let text = lines.join('\n');
  if (text.length > MAX_CHARS_PER_LEAD) text = text.slice(text.length - MAX_CHARS_PER_LEAD); // mantém o trecho mais RECENTE
  const meta = [
    'Lead: ' + (l.name || '(sem nome)'),
    'Origem: ' + (l.source || 'não informado'),
    'Valor estimado: ' + (l.value ? ('R$ ' + l.value) : 'não informado')
  ].join(' | ');
  return meta + '\nConversa:\n' + (text || '(sem mensagens no período)');
}

const MAP_SYSTEM = `Você é um analista sênior de vendas/CRM especializado em consultoria de vistos e imigração (Vale Visto).
Receberá um lote de conversas de WhatsApp entre um VENDEDOR e CLIENTES (leads) que ainda não fecharam negócio.
Para CADA lead do lote, extraia evidências OBJETIVAS (baseadas só no texto, sem inventar) em JSON.
Responda APENAS um array JSON, um objeto por lead, no formato:
[{"lead":"nome","objecoes":["..."],"qualificacao_0_10":N,"motivo_provavel_nao_fechou":"...","falhas_do_vendedor":["..."],"gaps_processo":["..."]}]
Se não houver evidência suficiente para um campo, use array vazio ou null. Não inclua texto fora do JSON.`;

const REDUCE_SYSTEM = `Você é um consultor de vendas sênior. Receberá evidências (JSON) extraídas de várias conversas de WhatsApp
de leads de uma consultoria de vistos/imigração (Vale Visto) que estão na fase "Tratamento inicial" (pré-venda) e
ainda não fecharam. Escreva um RELATÓRIO em markdown, em português do Brasil, com:
1. Um sumário executivo (3-5 linhas).
2. EXATAMENTE estas 5 seções, nesta ordem, cada uma com achados concretos e EXEMPLOS NOMINAIS (cite nomes de leads das evidências) e recomendações práticas ao final de cada seção:
   ## 1. Principais dificuldades de conversão
   ## 2. Nível de qualificação dos leads
   ## 3. Principais razões pelas quais os leads não fecham
   ## 4. Principais gaps no processo de conversão
   ## 5. Principais deficiências do nosso papel como vendedor
Seja direto, crítico e específico — evite generalidades. Baseie-se SOMENTE nas evidências fornecidas.`;

async function setReport(id, fields) {
  const cur = await getRow("SELECT * FROM ai_reports WHERE id = ?", [id]);
  const next = Object.assign({}, cur, fields);
  await runQuery(
    "UPDATE ai_reports SET status=?, progress=?, result=?, error=? WHERE id=?",
    [next.status, next.progress, next.result, next.error, id]
  );
}

async function runConversionReport(id, fromIso, toIso) {
  try {
    await setReport(id, { status: 'running', progress: 'buscando leads do Tratamento inicial…' });
    const cfg = await getAiSettings();
    const apiKey = cfg.anthropic_key;
    const model = cfg.anthropic_model || 'claude-fable-5';
    // execucao14: basta UMA das chaves (Gemini tem prioridade; Anthropic é o fallback).
    if (!apiKey && !cfg.gemini_key) throw new Error('nenhuma chave de IA configurada (Gemini ou Anthropic)');

    const { picked, truncated, totalCandidates } = await findLeadsAndMessages(fromIso, toIso);
    console.log('[reports] conversion-analysis', id, 'leads candidatos:', totalCandidates, 'selecionados:', picked.length, 'cortado:', !!truncated);
    if (!picked.length) throw new Error('Nenhum lead com conversa no período informado.');

    const chunks = [];
    for (let i = 0; i < picked.length; i += CHUNK_SIZE) chunks.push(picked.slice(i, i + CHUNK_SIZE));

    const cutNote = truncated ? (' (analisando os ' + LEAD_CAP + ' leads mais ativos de ' + totalCandidates + ' candidatos)') : '';
    const evidences = [];
    for (let i = 0; i < chunks.length; i++) {
      await setReport(id, { status: 'running', progress: 'chunk ' + (i + 1) + '/' + chunks.length + cutNote });
      const userText = chunks[i].map((item, idx) => '--- LEAD ' + (idx + 1) + ' ---\n' + buildLeadContext(item)).join('\n\n');
      let out;
      try {
        out = await callAI(cfg, model, MAP_MAX_TOKENS, MAP_SYSTEM, userText);
      } catch (e) {
        if (/chave Anthropic inválida/i.test(e.message)) throw e;
        throw new Error('Falha ao processar chunk ' + (i + 1) + '/' + chunks.length + ': ' + e.message);
      }
      let parsed;
      try {
        const m = out.match(/\[[\s\S]*\]/);
        parsed = JSON.parse(m ? m[0] : out);
      } catch (e) {
        // pipeline463: rastro no pm2 SEM texto de cliente — só tamanho da resposta, para
        // diagnosticar truncamento (maxOutputTokens) ou bloqueio de safety sem sumir em silêncio.
        console.warn('[reports] chunk ' + (i + 1) + '/' + chunks.length + ': JSON não parseável (' + (out ? out.length : 0) + ' chars recebidos) — erro: ' + e.message);
        parsed = [{ raw: out.slice(0, 1500) }];
      }
      evidences.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }

    await setReport(id, { status: 'running', progress: 'gerando relatório final…' });
    const reduceInput = 'Período analisado: ' + fromIso + ' a ' + toIso + '. Total de leads: ' + picked.length + cutNote + '.\n\n' +
      'Evidências por lead (JSON):\n' + JSON.stringify(evidences).slice(0, 60000);
    let finalMd;
    try {
      finalMd = await callAI(cfg, model, REDUCE_MAX_TOKENS, REDUCE_SYSTEM, reduceInput);
    } catch (e) {
      throw new Error('Falha ao gerar o relatório final: ' + e.message);
    }

    await setReport(id, { status: 'done', progress: 'concluído', result: finalMd, error: null });
    console.log('[reports] conversion-analysis', id, 'concluído. leads analisados:', picked.length);
  } catch (e) {
    let msg = e.message || 'Erro desconhecido';
    if (/chave Anthropic inválida|invalid x-api-key|authentication_error/i.test(msg)) msg = 'chave Anthropic inválida';
    if (/chave Anthropic não configurada/i.test(msg)) msg = 'chave Anthropic não configurada';
    console.error('[reports] conversion-analysis', id, 'erro:', msg);
    await setReport(id, { status: 'error', progress: null, error: msg });
  }
}

async function createConversionReportJob(fromIso, toIso) {
  const running = await getRow("SELECT id FROM ai_reports WHERE type = 'conversion-analysis' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1");
  if (running) { const err = new Error('Já existe um relatório em andamento.'); err.status = 409; throw err; }
  const id = newId();
  await runQuery(
    "INSERT INTO ai_reports (id, type, period_from, period_to, status, progress, result, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, 'conversion-analysis', fromIso, toIso, 'queued', 'na fila…', null, null, new Date().toISOString()]
  );
  setImmediate(() => { runConversionReport(id, fromIso, toIso).catch((e) => console.error('[reports] job não tratado:', e && e.message)); });
  return getRow("SELECT * FROM ai_reports WHERE id = ?", [id]);
}

function listConversionReports(limit) {
  return allRows("SELECT id, type, period_from, period_to, status, progress, error, created_at FROM ai_reports WHERE type = 'conversion-analysis' ORDER BY created_at DESC LIMIT ?", [limit || 10]);
}
function getConversionReport(id) {
  return getRow("SELECT * FROM ai_reports WHERE id = ? AND type = 'conversion-analysis'", [id]);
}
function getLatestConversionReport() {
  return getRow("SELECT * FROM ai_reports WHERE type = 'conversion-analysis' ORDER BY created_at DESC LIMIT 1");
}

module.exports = {
  createConversionReportJob,
  listConversionReports,
  getConversionReport,
  getLatestConversionReport,
  // execucao1 Sprint1 (2026-07-25): reutilizado pelo relatório diário (daily_reports.js).
  callClaude,
  callAI
};
