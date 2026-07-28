// Backfill de transcrição de áudios (transcricao-20260728) — roda UMA VEZ, fora do pm2:
//   cd /opt/crm-backend && nohup node backfill_transcricao.js > backfill_transcricao.log 2>&1 &
// Transcreve TODOS os áudios com transcription IS NULL (mais recentes primeiro), 1 por vez,
// com pausa de 2s entre chamadas para não disputar rate limit com o atendente de IA.
// Resumível: se for interrompido, rodar de novo continua de onde parou (só pega os NULL).
// Falhas e arquivos ausentes ficam NULL (o CRM mostra o botão 📝 Transcrever como fallback).
// NÃO importa whatsapp.js (não abre Baileys); usa a mesma conexão sqlite do db.js (WAL).
const fs = require('fs');
const { transcreverAudio } = require('./ai');
const { runQuery, allRows } = require('./db');

const SLEEP_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // Pequena espera p/ o db.js terminar migrations/seeds do require
  await sleep(3000);
  const rows = await allRows(
    "SELECT id, mediaPath FROM messages WHERE type='audio' AND transcription IS NULL AND mediaPath IS NOT NULL ORDER BY timestamp DESC"
  );
  console.log('[backfill] ' + new Date().toISOString() + ' — áudios a transcrever: ' + rows.length);
  let ok = 0, vazio = 0, semArquivo = 0, falha = 0, i = 0;
  for (const r of rows) {
    i++;
    try {
      if (!r.mediaPath || !fs.existsSync(r.mediaPath)) { semArquivo++; continue; }
      const t = await transcreverAudio(r.mediaPath);
      if (t === null || t === undefined) {
        falha++; // transcreverAudio já logou o motivo; fica NULL (botão on-demand no CRM)
      } else {
        await runQuery("UPDATE messages SET transcription = ? WHERE id = ?", [t, r.id]);
        if (String(t).trim()) ok++; else vazio++;
      }
    } catch (e) {
      falha++;
      console.error('[backfill] erro em ' + r.id + ':', e && e.message ? e.message : e);
    }
    if (i % 50 === 0) console.log('[backfill] ' + i + '/' + rows.length + ' — ok=' + ok + ' vazio=' + vazio + ' sem_arquivo=' + semArquivo + ' falha=' + falha);
    await sleep(SLEEP_MS);
  }
  console.log('[backfill] FIM ' + new Date().toISOString() + ': total=' + rows.length + ' ok=' + ok + ' vazio=' + vazio + ' sem_arquivo=' + semArquivo + ' falha=' + falha);
  process.exit(0);
})().catch((e) => { console.error('[backfill] fatal:', e); process.exit(1); });
