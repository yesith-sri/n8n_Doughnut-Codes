# Hosted Trivy REST wrapper

Vercel cannot run the `trivy` binary, and the stock `trivy server` endpoint is Twirp/RPC intended for the Trivy CLI, not for a browser/serverless REST call. Run this tiny wrapper on the DigitalOcean droplet instead:

```bash
cd /opt/forge
node scripts/trivy-rest-wrapper.mjs
```

Required env on the droplet:

```bash
PORT=8081
TRIVY_SERVER=http://127.0.0.1:8080
TRIVVY_API_KEY=<same token used by Vercel>
```

Then set Vercel:

```bash
TRIVVY_API=http://<droplet-ip>:8081
TRIVVY_API_KEY=<same token>
```

The wrapper accepts:

- `POST /scan` with `{ "image": "nginx:latest" }`
- `POST /api/scan` with `{ "image": "nginx:latest" }`
- `POST /v1/scan` with `{ "image": "nginx:latest" }`
- `GET /scan/nginx%3Alatest`

Auth header:

```http
Trivy-Token: <TRIVVY_API_KEY>
```

It returns native Trivy JSON (`{ SchemaVersion, Results: [...] }`), which `/api/scan` already normalizes for the frontend.

## systemd example

```ini
[Unit]
Description=Forge Trivy REST Wrapper
After=network.target

[Service]
WorkingDirectory=/opt/forge
Environment=PORT=8081
Environment=TRIVY_SERVER=http://127.0.0.1:8080
Environment=TRIVVY_API_KEY=replace-me
ExecStart=/usr/bin/node /opt/forge/scripts/trivy-rest-wrapper.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
