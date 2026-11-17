# Per-user broker profiles

Each friend gets their own env file. Login (or `--user=`) loads that file on top of the shared root `.env`.

## Layout

```
users/
  accounts.json     # login id → env file + PIN + broker label (gitignored)
  a.env             # User A — Upstox token, budgets, static IPs
  b.env             # User B — Angel / other keys
  accounts.json.example
  user.env.example
```

## accounts.json

```json
{
  "users": [
    { "id": "a", "name": "User A", "broker": "upstox", "env": "a.env", "pin": "1234" },
    { "id": "b", "name": "User B", "broker": "angelone", "env": "b.env", "pin": "5678" }
  ]
}
```

## Run

```bash
# Direct
npm run muhurat2 -- --user=a

# Interactive login + PIN
npm run muhurat2 -- --login

# Or
MUHURAT_USER=a npm run muhurat2
```

## 10 friends on one Oracle box

Run **one process per user** (separate ports):

```bash
MUHURAT_USER=a MUHURAT_WEB_PORT=3001 npm run muhurat2
MUHURAT_USER=b MUHURAT_WEB_PORT=3002 npm run muhurat2
```

Open `http://<oracle-ip>:3001/` for A, `:3002` for B, etc.

## Brokers

- **upstox** — live muhurat orders work today (`UPSTOX_ACCESS_TOKEN`, static IPs).
- **angelone** — data/login keys supported; muhurat live orders are still Upstox-oriented.
- **zerodha / paytm** — add keys in their `.env` for future adapters; not order-wired yet.
