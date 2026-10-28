# Deploy on an Ubuntu server (PM2 + Nginx + MongoDB)

Replace `booking.example.com` with the real subdomain. Its DNS A record must point at the server before step 6.

## 1. Check the server

```bash
node -v                      # must be v22 or newer
ss -ltnp | grep 3080         # must print nothing (port free); otherwise set another PORT in .env
mongosh --quiet --eval "db.adminCommand('ping')"
```

## 2. Get the code and build

```bash
cd /var/www
git clone https://github.com/ajshan23/booking-custom.git
cd booking-custom
MONGOMS_DISABLE_POSTINSTALL=1 npm ci
npm run build
npm prune --omit=dev
```

`MONGOMS_DISABLE_POSTINSTALL=1` skips downloading a test-only MongoDB binary.

## 3. Create `.env`

```bash
cp .env.example .env
chmod 600 .env
# Run three times, one value each for SERVICE_API_KEY, ADMIN_API_KEY and TOKEN_ENCRYPTION_KEY:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
nano .env
```

Set at least:

```ini
PORT=3080
MONGODB_URI=mongodb://127.0.0.1:27017          # add user:password@ and ?authSource=admin if MongoDB uses auth
MONGODB_DATABASE=customcalander
SERVICE_API_KEY=<new value>
ADMIN_API_KEY=<new value>                      # Bearer key for admin API scripts
ADMIN_USERNAME=admin                           # portal sign-in at /login
ADMIN_PASSWORD=<at least 8 characters>
TOKEN_ENCRYPTION_KEY=<new value>               # never change it later: stored Google tokens depend on it
GOOGLE_CLIENT_ID=<from Google Cloud>
GOOGLE_CLIENT_SECRET=<from Google Cloud>
GOOGLE_REDIRECT_URI=https://booking.example.com/v1/google/callback
OPENAI_API_KEY=<key>
TRUST_PROXY_HOPS=1                             # behind Nginx
```

Working hours, durations and timezone can be left at their defaults and changed later in the portal.

## 4. Start with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
curl http://127.0.0.1:3080/health              # {"status":"ok"}
pm2 logs booking-calendar --lines 20
```

## 5. Nginx site

`/etc/nginx/sites-available/booking-calendar`:

```nginx
server {
    listen 80;
    server_name booking.example.com;

    location / {
        proxy_pass http://127.0.0.1:3080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/booking-calendar /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 6. HTTPS

```bash
certbot --nginx -d booking.example.com
```

## 7. Connect Google

1. Google Cloud Console → APIs & Services → Credentials → the OAuth client → add `https://booking.example.com/v1/google/callback` under Authorized redirect URIs.
2. OAuth consent screen → publish the app (or set it to Internal on Google Workspace). In Testing mode the connection expires every 7 days.
3. Open `https://booking.example.com/login`, sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`, and use **Connect Google** with the organizer account.

## 8. Point the Flowflex flow at it

In the imported flow, set the calendar base URL to `https://booking.example.com` and replace `REPLACE_WITH_SERVICE_API_KEY` in the API nodes' Authorization headers with the new `SERVICE_API_KEY`.

## Updating later

```bash
cd /var/www/booking-custom
git pull
MONGOMS_DISABLE_POSTINSTALL=1 npm ci && npm run build && npm prune --omit=dev
pm2 reload booking-calendar
```
