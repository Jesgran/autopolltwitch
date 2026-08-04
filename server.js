import 'dotenv/config';
import express from 'express';
import tmi from 'tmi.js';

// Render fornisce automaticamente PORT: va sempre rispettato, non va hardcodato.
const PORT = Number(process.env.PORT || 3939);
const POLL_DURATION_SECONDS = Number(process.env.POLL_DURATION_SECONDS || 60);
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

  const match = message.trim().match(/^v(10|[1-9])$/i);
  if (!match) return;

  const value = Number(match[1]);
  const user = (tags['display-name'] || tags.username || '').toLowerCase();
  if (!user) return;

  votes.set(user, value); // un voto per utente, l'ultimo scritto vince
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
async function sendToDiscord({ url, title, average, count }) {
  const embed = {
    title: title || 'Traccia in ascolto',
    url: url || undefined,
    description:
      count > 0
        ? `⭐ **Voto medio: ${average.toFixed(1)} / 10** (${count} vot${count === 1 ? 'o' : 'i'})`
        : '⭐ Nessun voto ricevuto per questo brano.',
    color: 0x9146ff, // viola Twitch
    timestamp: new Date().toISOString(),
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });
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
    const safariUrl = (req.body?.url || '').trim();
    const safariTitle = (req.body?.title || '').trim();
    const youtubeTitle = await getYoutubeTitle(safariUrl);
    const finalTitle = youtubeTitle || safariTitle || safariUrl || 'Traccia in ascolto';

    votes = new Map();
    pollActive = true;

    await twitchClient.say(
      process.env.TWITCH_CHANNEL,
      `🎵 Vota il brano da 1 a 10 scrivendo v seguito dal numero (es. v9)! Avete ${POLL_DURATION_SECONDS} secondi ⏳`
    );

    res.status(200).send('Sondaggio avviato');

    setTimeout(async () => {
      pollActive = false;

      const values = Array.from(votes.values());
      const count = values.length;
      const average = count > 0 ? values.reduce((a, b) => a + b, 0) / count : 0;

      if (count > 0) {
        await twitchClient.say(
          process.env.TWITCH_CHANNEL,
          `📊 Voto medio: ${average.toFixed(1)}/10 su ${count} vot${count === 1 ? 'o' : 'i'}!`
        );
      } else {
        await twitchClient.say(process.env.TWITCH_CHANNEL, '📊 Nessun voto ricevuto stavolta 😅');
      }

      await sendToDiscord({ url: safariUrl, title: finalTitle, average, count });
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

app.listen(PORT, () => {
  console.log(`✅ Server in ascolto su http://localhost:${PORT}`);
  console.log(`   Punta lo Stream Deck su: http://localhost:${PORT}/trigger`);
});
