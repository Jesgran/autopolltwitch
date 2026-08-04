Questo progetto è un prototipo e come tale è quasi totalmente vibe coddato, copiarlo è consentito ma non confermo il funzionamento 

## 2. Crea il servizio su Render
Impostazioni:
   - **Root Directory**: vuoto (se la repo contiene solo questa cartella) oppure `render-server` (se hai messo tutto il progetto nella stessa repo)
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (con keep-alive UptimeRobot, vedi sotto) o Starter (~7$/mese, sempre acceso senza trucchi)

## 3. Variabili d'ambiente su Render

| Chiave | Valore |
|---|---|
| `TWITCH_BOT_USERNAME` | username del bot ([twitchtokengenerator.com](https://twitchtokengenerator.com)) |
| `TWITCH_OAUTH_TOKEN` | token del bot, formato `oauth:...` |
| `TWITCH_CHANNEL` | il canale Twitch, es. `miocanale` |
| `DISCORD_WEBHOOK_URL` | URL del webhook Discord |
| `TRIGGER_SECRET` | stringa lunga a caso, es. genera con `openssl rand -hex 16` |
| `POLL_DURATION_SECONDS` | `60` |

## 4. Tieni il servizio sveglio con UptimeRobot (free tier)

2. Monitor Type: **HTTP(s)**
3. URL: `https://il-tuo-nome-app.onrender.com/health`