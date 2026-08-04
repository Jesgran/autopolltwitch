## Questo progetto è un prototipo e come tale è quasi totalmente vibe coddato, copiarlo è consentito ma non confermo il funzionamento 

Impostazioni:
   - **Root Directory**: vuoto
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free

| Chiave | Valore |
|---|---|
| `TWITCH_BOT_USERNAME` | username del bot ([twitchtokengenerator.com](https://twitchtokengenerator.com)) |
| `TWITCH_OAUTH_TOKEN` | token del bot, formato `oauth:...` |
| `TWITCH_CHANNEL` | il canale Twitch, es. `miocanale` |
| `DISCORD_WEBHOOK_URL` | URL del webhook Discord |
| `TRIGGER_SECRET` | stringa lunga a caso, es. genera con `openssl rand -hex 16` |
| `POLL_DURATION_SECONDS` | `60` |

2. Monitor Type: **HTTP(s)**
3. URL: `https://il-tuo-nome-app.onrender.com/health`
