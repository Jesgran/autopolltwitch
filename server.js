import 'dotenv/config';
import express from 'express';
import tmi from 'tmi.js';

// Rete di sicurezza: qualsiasi errore async sfuggito ai try/catch finisce
// qui, loggato, invece di far crashare il processo senza traccia.
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection (il processo NON crasha, ma controlla questo errore):', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception (il processo NON crasha, ma controlla questo errore):', err);
});

// Render fornisce automaticamente PORT: va sempre rispettato, non va hardcodato.
const PORT = Number(process.env.PORT || 3939);
const POLL_DURATION_SECONDS = Number(process.env.POLL_DURATION_SECONDS || 120);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const TRIGGER_SECRET = process.env.TRIGGER_SECRET;

if (!process.env.TWITCH_BOT_USERNAME || !process.env.TWITCH_OAUTH_TOKEN || !process.env.TWITCH_CHANNEL) {
  console.error('❌ Mancano variabili Twitch (TWITCH_BOT_USERNAME, TWITCH_OAUTH_TOKEN, TWITCH_CHANNEL).');
  process.exit(1);
}
if (!DISCORD_WEBHOOK_URL) {
  console.error('❌ Manca DISCORD_WEBHOOK_URL.');
  process.exit(1);
}
if (!TRIGGER_SECRET) {
  console.error('❌ Manca TRIGGER_SECRET: serve per proteggere /trigger, che sarà un URL pubblico su internet.');
  process.exit(1);
}

// ---------- Stato del sondaggio ----------
let pollActive = false;
let votes = new Map(); // username (lowercase) -> numero votato
let pollInfo = null; // { title, url, startedAt, durationMs }

// ---------- Overlay: client SSE connessi ----------
const overlayClients = new Set();

function broadcastOverlay(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of overlayClients) {
    res.write(data);
  }
}

function currentStats() {
  const values = Array.from(votes.values());
  const count = values.length;
  const average = count > 0 ? values.reduce((a, b) => a + b, 0) / count : 0;
  return { count, average };
}

// Lista votanti in ordine decrescente di voto: [{ user, value }, ...]
function currentVoteEntries() {
  return Array.from(votes.entries())
    .map(([user, value]) => ({ user, value }))
    .sort((a, b) => b.value - a.value);
}

// ---------- Client Twitch ----------
const twitchClient = new tmi.Client({
  identity: {
    username: process.env.TWITCH_BOT_USERNAME,
    password: process.env.TWITCH_OAUTH_TOKEN,
  },
  channels: [process.env.TWITCH_CHANNEL],
});

twitchClient.on('message', (channel, tags, message, self) => {
  if (self || !pollActive) return;

  const match = message.trim().match(/^v(10(?:\.0)?|[1-9](?:\.\d)?)$/i);
  if (!match) return;

  const value = Number.parseFloat(match[1]);
  const user = (tags['display-name'] || tags.username || '').toLowerCase();
  if (!user) return;

  votes.set(user, value); // un voto per utente, l'ultimo scritto vince

  const { count, average } = currentStats();
  broadcastOverlay({ type: 'vote_update', count, average });
});

await twitchClient.connect();
console.log('✅ Bot Twitch connesso al canale', process.env.TWITCH_CHANNEL);
// Da qui in poi il bot resta connesso in permanenza: su Render non serve
// che nessuno lo avvii manualmente ogni volta che si va in live.

// ---------- Titolo YouTube via oEmbed (più pulito del titolo della tab) ----------
async function getYoutubeTitle(url) {
  try {
    const isYoutube = /youtube\.com\/watch|youtu\.be\//.test(url);
    if (!isYoutube) return null;

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;

    const data = await res.json();
    return data.title || null;
  } catch {
    return null;
  }
}

// ---------- Invio a Discord ----------

// I campi degli embed Discord hanno un limite di 1024 caratteri: se i
// votanti sono tanti, spezzo la lista in più campi "Voti (1/2)", "Voti (2/2)" ecc.
function chunkVotersList(voteEntries, maxChars = 1000) {
  const lines = voteEntries.map((v) => `${v.user}: **${v.value}**`);
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

async function sendToDiscord({ url, title, average, count, voteEntries }) {
  const fields = [];

  if (count > 0) {
    const chunks = chunkVotersList(voteEntries);
    chunks.forEach((chunk, i) => {
      fields.push({
        name: chunks.length > 1 ? `Voti (${i + 1}/${chunks.length})` : 'Voti',
        value: chunk,
        inline: false,
      });
    });
  }

  const embed = {
    title: title || 'Traccia in ascolto',
    url: url || undefined,
    description:
      count > 0
        ? `⭐ **Voto medio: ${average.toFixed(1)} / 10** (${count} vot${count === 1 ? 'o' : 'i'})`
        : '⭐ Nessun voto ricevuto per questo brano.',
    color: 0x9146ff, // viola Twitch
    fields,
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`❌ Discord ha rifiutato il webhook (${res.status}):`, body);
    }
  } catch (err) {
    // Non rilanciare l'errore: se questa fetch fallisce, non deve MAI
    // far crashare il processo (un errore async non gestito qui
    // ucciderebbe l'intero server su Node moderno).
    console.error('❌ Errore di rete inviando il webhook Discord:', err);
  }
}

// ---------- Server HTTP per il trigger locale ----------
const app = express();
app.use(express.json());

function checkSecret(req, res) {
  const provided = req.query.secret || req.headers['x-trigger-secret'];
  if (provided !== TRIGGER_SECRET) {
    res.status(401).send('Secret mancante o errato');
    return false;
  }
  return true;
}

app.post('/trigger', async (req, res) => {
  if (!checkSecret(req, res)) return;

  if (pollActive) {
    res.status(409).send('Sondaggio già in corso');
    return;
  }

  try {
    const browserUrl = (req.body?.url || '').trim();
    const browserTitle = (req.body?.title || '').trim();
    const youtubeTitle = await getYoutubeTitle(browserUrl);
    const finalTitle = youtubeTitle || browserTitle || browserUrl || 'Traccia in ascolto';

    votes = new Map();
    pollActive = true;
    pollInfo = {
      title: finalTitle,
      url: browserUrl,
      startedAt: Date.now(),
      durationMs: POLL_DURATION_SECONDS * 1000,
    };

    await twitchClient.say(
      process.env.TWITCH_CHANNEL,
      `🎵 Vota il brano da 1 a 10 scrivendo v seguito dal numero, decimali ammessi (es. v9 o v6.7)! Avete ${POLL_DURATION_SECONDS} secondi ⏳`
    );

    broadcastOverlay({
      type: 'poll_start',
      title: finalTitle,
      url: browserUrl,
      durationSeconds: POLL_DURATION_SECONDS,
    });

    res.status(200).send('Sondaggio avviato');

    setTimeout(async () => {
      // TUTTO qui dentro è avvolto in try/catch: se qualcosa fallisce
      // (chat, Discord, qualsiasi cosa) il server NON deve crashare.
      // Un errore async non gestito in un setTimeout può far terminare
      // l'intero processo Node — e su Render questo si traduce in un
      // riavvio silenzioso, senza che nessuno se ne accorga.
      try {
        pollActive = false;
        pollInfo = null;

        const { count, average } = currentStats();
        const voteEntries = currentVoteEntries();

        if (count > 0) {
          await twitchClient.say(
            process.env.TWITCH_CHANNEL,
            `📊 Voto medio: ${average.toFixed(1)}/10 su ${count} vot${count === 1 ? 'o' : 'i'}!`
          );
        } else {
          await twitchClient.say(process.env.TWITCH_CHANNEL, '📊 Nessun voto ricevuto stavolta 😅');
        }

        broadcastOverlay({ type: 'poll_end', count, average });

        await sendToDiscord({ url: browserUrl, title: finalTitle, average, count, voteEntries });
      } catch (err) {
        console.error('❌ Errore durante la chiusura del sondaggio:', err);
      }
    }, POLL_DURATION_SECONDS * 1000);
  } catch (err) {
    pollActive = false;
    console.error('Errore durante il trigger:', err);
    res.status(500).send('Errore, controlla il terminale');
  }
});

app.get('/', (req, res) => {
  res.send('Twitch Poll Bot attivo.');
});

// Endpoint leggero per i servizi di keep-alive (es. UptimeRobot / cron-job.org)
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// ---------- Stream di eventi live (SSE) per l'overlay ----------
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  overlayClients.add(res);

  // Se un overlay si collega mentre un sondaggio è già in corso, aggiornalo subito
  if (pollActive && pollInfo) {
    const { count, average } = currentStats();
    const secondsLeft = Math.max(
      0,
      Math.round((pollInfo.startedAt + pollInfo.durationMs - Date.now()) / 1000)
    );
    res.write(
      `data: ${JSON.stringify({
        type: 'poll_start',
        title: pollInfo.title,
        url: pollInfo.url,
        durationSeconds: Math.round(pollInfo.durationMs / 1000),
        secondsLeft,
      })}\n\n`
    );
    res.write(`data: ${JSON.stringify({ type: 'vote_update', count, average })}\n\n`);
  }

  req.on('close', () => {
    overlayClients.delete(res);
  });
});

// ---------- Pagina overlay da usare come Browser Source in OBS ----------
app.get('/overlay', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<title>Overlay Sondaggio</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: transparent;
    font-family: 'Segoe UI', Arial, sans-serif;
    overflow: hidden;
  }
  #card {
    display: none;
    width: 480px;
    padding: 20px 24px;
    border-radius: 16px;
    background: rgba(20, 12, 30, 0.85);
    color: #fff;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  #title {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  #average {
    font-size: 42px;
    font-weight: 800;
    color: #9146ff;
  }
  #count {
    font-size: 16px;
    opacity: 0.8;
  }
  #barBg {
    width: 100%;
    height: 10px;
    border-radius: 5px;
    background: rgba(255,255,255,0.15);
    overflow: hidden;
  }
  #barFill {
    height: 100%;
    width: 100%;
    background: linear-gradient(90deg, #9146ff, #ff5fa2);
    transition: width 1s linear;
  }
  #timer {
    margin-top: 6px;
    font-size: 14px;
    opacity: 0.7;
    text-align: right;
  }
</style>
</head>
<body>
<div id="card">
  <div id="title">🎵 ...</div>
  <div id="row">
    <span id="average">0.0</span>
    <span id="count">0 voti</span>
  </div>
  <div id="barBg"><div id="barFill"></div></div>
  <div id="timer"></div>
</div>

<script>
  const card = document.getElementById('card');
  const titleEl = document.getElementById('title');
  const averageEl = document.getElementById('average');
  const countEl = document.getElementById('count');
  const barFill = document.getElementById('barFill');
  const timerEl = document.getElementById('timer');

  let durationSeconds = 120;
  let secondsLeft = 0;
  let countdownInterval = null;

  function startCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      secondsLeft = Math.max(0, secondsLeft - 1);
      timerEl.textContent = secondsLeft + 's';
      barFill.style.width = Math.max(0, (secondsLeft / durationSeconds) * 100) + '%';
      if (secondsLeft <= 0) clearInterval(countdownInterval);
    }, 1000);
  }

  const source = new EventSource('/events');

  source.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'poll_start') {
      card.style.display = 'block';
      titleEl.textContent = '🎵 ' + data.title;
      durationSeconds = data.durationSeconds;
      secondsLeft = data.secondsLeft ?? data.durationSeconds;
      averageEl.textContent = '0.0';
      countEl.textContent = '0 voti';
      barFill.style.width = '100%';
      timerEl.textContent = secondsLeft + 's';
      startCountdown();
    }

    if (data.type === 'vote_update') {
      averageEl.textContent = data.average.toFixed(1);
      countEl.textContent = data.count + (data.count === 1 ? ' voto' : ' voti');
    }

    if (data.type === 'poll_end') {
      averageEl.textContent = data.average.toFixed(1);
      countEl.textContent = data.count + (data.count === 1 ? ' voto' : ' voti');
      timerEl.textContent = 'Chiuso';
      clearInterval(countdownInterval);
      setTimeout(() => { card.style.display = 'none'; }, 8000);
    }
  };
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`✅ Server in ascolto su http://localhost:${PORT}`);
  console.log(`   Punta lo Stream Deck su: http://localhost:${PORT}/trigger`);
});
