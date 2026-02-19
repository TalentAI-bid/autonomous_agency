# AgentCore — Deployment Guide

Complete step-by-step guide to deploying the AgentCore AI recruiting platform on a production server.

---

## Architecture Overview

```
Internet → Nginx → :3000 (Next.js Dashboard)
                 → :4000 (Fastify API)

API ─→ PostgreSQL :5432 (direct — migrations/seeding)
     → PgBouncer  :6432 (pooled — runtime queries)
     → Redis      :6379 (BullMQ queues + cache + sessions)

Workers (7 agent types) ─→ Redis (BullMQ)
                         → PostgreSQL (via PgBouncer)
                         → SearXNG (search)
                         → Crawl4AI (web scraping)
                         → Together AI / Claude API (LLM)
                         → SMTP (email sending)
```

---

## 1. Server Prerequisites

### Minimum specs
- **OS:** Ubuntu 22.04 LTS (or Debian 12)
- **CPU:** 4 vCPU
- **RAM:** 8 GB
- **Disk:** 40 GB SSD
- **Network:** Open ports 22 (SSH), 80, 443, 3000, 4000

### Required software

**Option A — Docker (recommended):**
```bash
# Install Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker --version          # Docker 24+
docker compose version    # v2.x
```

**Option B — Manual (Node.js + native services):**
```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# PostgreSQL 16
sudo apt-get install -y postgresql-16

# Redis 7
sudo apt-get install -y redis-server

# PM2 (process manager)
npm install -g pm2
```

---

## 2. Get the Code

```bash
# Clone or upload the project to your server
cd /opt
git clone <your-repo-url> agentcore-platform
# OR: scp -r ./agents user@server:/opt/agentcore-platform

cd /opt/agentcore-platform
ls
# Should show:  agentcore/   dashboard/   DEPLOYMENT.md
```

---

## 3. Environment Configuration

### 3a. Backend (agentcore)

```bash
cd /opt/agentcore-platform/agentcore
cp .env.example .env
nano .env
```

Fill in **all** values:

```env
# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://agentcore:STRONG_PASSWORD@localhost:5432/agentcore
PGBOUNCER_URL=postgresql://agentcore:STRONG_PASSWORD@localhost:6432/agentcore

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── JWT (MUST CHANGE — generate with: openssl rand -hex 64) ──────────────────
JWT_SECRET=<64-char-random-hex>
JWT_REFRESH_SECRET=<64-char-random-hex>

# ── AI APIs ───────────────────────────────────────────────────────────────────
TOGETHER_API_KEY=<your-together-ai-key>        # https://api.together.ai
TOGETHER_API_URL=https://api.together.xyz/v1
CLAUDE_API_KEY=<your-anthropic-key>            # https://console.anthropic.com

# ── External Services ─────────────────────────────────────────────────────────
SEARXNG_URL=http://localhost:8888              # Self-hosted SearXNG
CRAWL4AI_URL=http://localhost:11235            # Self-hosted Crawl4AI

# ── SMTP (for outreach emails) ────────────────────────────────────────────────
SMTP_HOST=smtp.sendgrid.net                   # or smtp.gmail.com, smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=apikey                              # or your email address
SMTP_PASS=<your-smtp-password-or-api-key>

# ── Application ───────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=4000
CORS_ORIGIN=http://YOUR_SERVER_IP:3000        # or https://yourdomain.com
LOG_LEVEL=info
```

Generate secure JWT secrets:
```bash
openssl rand -hex 64   # run twice — once for JWT_SECRET, once for JWT_REFRESH_SECRET
```

### 3b. Frontend (dashboard)

```bash
cd /opt/agentcore-platform/dashboard
cp .env.local.example .env.local
nano .env.local
```

```env
NEXT_PUBLIC_API_URL=http://YOUR_SERVER_IP:4000/api
NEXT_PUBLIC_WS_URL=ws://YOUR_SERVER_IP:4000/ws/realtime
```

> If using a domain with HTTPS, use `https://` and `wss://` instead.

---

## 4a. Deploy with Docker Compose (Recommended)

All services (Postgres, Redis, PgBouncer, API, Workers, Dashboard) run as containers.

```bash
cd /opt/agentcore-platform/agentcore

# Step 1: Start infrastructure (DB + Redis)
docker compose up -d postgres redis pgbouncer

# Step 2: Wait for health checks (30 seconds)
sleep 30
docker compose ps   # postgres, redis, pgbouncer should be "healthy"

# Step 3: Build the API image and run database setup
docker compose build agentcore-api
docker compose run --rm agentcore-api sh -c "
  node dist/queues/workers.js &
  sleep 2 &&
  node -e \"
    import('./dist/config/env.js').then(() => process.exit(0))
  \"
"

# Actually, run migrations directly:
docker compose run --rm agentcore-api node -e "
  const { db } = await import('./dist/config/database.js');
  process.exit(0);
"

# Simpler: exec into a temporary container
docker compose run --rm agentcore-api sh

# Inside container:
node dist/index.js &
# Then in another terminal:
```

**Simpler approach — run migrations from host:**
```bash
# Install deps and build first (outside Docker)
npm install
npm run build

# Run migrations (uses DATABASE_URL pointing to Docker postgres)
export DATABASE_URL=postgresql://agentcore:agentcore@localhost:5432/agentcore
npm run db:migrate

# Apply Row-Level Security
psql $DATABASE_URL -f scripts/setup-rls.sql

# Seed initial data (admin@acme.com / password123)
npm run db:seed

# Now start ALL services
docker compose up -d

# Check all services are running
docker compose ps
docker compose logs -f agentcore-api
```

**Verify deployment:**
```bash
curl http://localhost:4000/api/health
# Expected: {"status":"ok","timestamp":"..."}

curl http://localhost:3000
# Expected: 200 OK (Next.js login page)
```

---

## 4b. Deploy Manually with PM2 (No Docker)

### PostgreSQL setup

```bash
sudo -u postgres psql
```
```sql
CREATE USER agentcore WITH PASSWORD 'STRONG_PASSWORD';
CREATE DATABASE agentcore OWNER agentcore;
GRANT ALL PRIVILEGES ON DATABASE agentcore TO agentcore;
\q
```

### Redis setup

```bash
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

### Build and migrate

```bash
# Backend
cd /opt/agentcore-platform/agentcore
npm install
npm run build
npm run db:migrate
psql $DATABASE_URL -f scripts/setup-rls.sql
npm run db:seed

# Frontend
cd /opt/agentcore-platform/dashboard
npm install
npm run build
```

### Start with PM2

```bash
cd /opt/agentcore-platform/agentcore

# API server
pm2 start dist/index.js --name agentcore-api \
  --env production

# Agent workers (separate process)
pm2 start dist/queues/workers.js --name agentcore-workers \
  --env production

# Next.js dashboard
cd /opt/agentcore-platform/dashboard
pm2 start npm --name agentcore-dashboard -- start

# Save PM2 config and enable autostart
pm2 save
pm2 startup   # follow the printed command
```

**Check status:**
```bash
pm2 status
pm2 logs agentcore-api
pm2 logs agentcore-workers
```

---

## 5. Database Initialization

Run these in order after the infrastructure is up:

```bash
cd /opt/agentcore-platform/agentcore

# 1. Apply Drizzle ORM migrations (creates all 15 tables)
npm run db:migrate

# 2. Enable Row-Level Security (required for multi-tenant isolation)
psql $DATABASE_URL -f scripts/setup-rls.sql

# 3. Seed initial data (creates test tenant + admin user)
npm run db:seed
```

After seeding you can log in with:
- **Email:** `admin@acme.com`
- **Password:** `password123`
- **Tenant:** Acme Corp

> Change this password immediately after first login via Settings.

---

## 6. Self-Hosted Services (Optional)

The agent pipeline uses SearXNG (web search) and Crawl4AI (web scraping). You can self-host them or point to existing instances.

### SearXNG (search engine)
```bash
docker run -d --name searxng \
  -p 8888:8080 \
  -e SEARXNG_SECRET=$(openssl rand -hex 32) \
  searxng/searxng:latest
```

### Crawl4AI (web scraper)
```bash
docker run -d --name crawl4ai \
  -p 11235:11235 \
  unclecode/crawl4ai:latest
```

Update `agentcore/.env`:
```env
SEARXNG_URL=http://localhost:8888
CRAWL4AI_URL=http://localhost:11235
```

---

## 7. Nginx Reverse Proxy (Production)

Install Nginx and configure a reverse proxy to serve both services behind a clean domain:

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/agentcore
```

```nginx
# Dashboard (port 3000)
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# API (port 4000)
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/agentcore /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Add HTTPS with Let's Encrypt
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com -d api.yourdomain.com
```

After HTTPS, update your `.env` files:
```env
# agentcore/.env
CORS_ORIGIN=https://yourdomain.com

# dashboard/.env.local
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
NEXT_PUBLIC_WS_URL=wss://api.yourdomain.com/ws/realtime
```

---

## 8. First Login & Creating Your First Agent

### Login
1. Open `http://YOUR_SERVER:3000` (or your domain)
2. Email: `admin@acme.com` / Password: `password123`
3. You'll be redirected to the Dashboard

### Create an Agent (4-Step Wizard)

Navigate to **Agents → New Agent**:

**Step 1 — Mission**
- **Name:** e.g. `Senior React Engineers — London`
- **Mission:** e.g. `Find senior React engineers with 5+ years experience, TypeScript expertise, preferably with fintech or startup background. Target London-based or remote-first candidates.`
- **Use case:** Talent Acquisition

**Step 2 — Documents (optional)**
- Upload a job spec PDF or DOCX
- The agent will extract requirements from it automatically
- Click **Skip** if you don't have one yet

**Step 3 — Configuration**
- **Score threshold:** 70 (candidates scoring below this are rejected)
- **Email tone:** Professional / Friendly / Direct

**Step 4 — Launch**
- Review the configuration
- Click **Launch Agent**
- You'll be redirected to the agent monitoring page

### Monitor the Pipeline

The agent detail page `/agents/[id]` shows:
- **7 status cards** — one per agent type (discovery, document, enrichment, scoring, outreach, reply, action)
- **Live activity feed** — real-time WebSocket events
- **Contacts list** — discovered candidates with scores

Pipeline flow:
```
Discovery → Document (parse LinkedIn profiles)
         → Enrichment (find emails, company data)
         → Scoring (rank against requirements)
         → Outreach (send personalized emails via Claude)
         → Reply (classify responses)
         → Action (schedule interviews)
```

---

## 9. Health Checks & Monitoring

```bash
# API health
curl http://localhost:4000/api/health

# Database connection
psql $DATABASE_URL -c "SELECT count(*) FROM tenants;"

# Redis
redis-cli ping   # PONG

# Docker logs
docker compose logs -f agentcore-api
docker compose logs -f agentcore-workers

# PM2 logs
pm2 logs agentcore-api --lines 100
pm2 logs agentcore-workers --lines 100

# BullMQ queue status (connect to Redis)
redis-cli
> KEYS bull:*            # list all queues
> LLEN bull:tenant_*:discovery:wait   # pending jobs
```

---

## 10. Backups

```bash
# PostgreSQL backup
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql

# Docker volume backup
docker compose exec postgres pg_dumpall -U agentcore > backup_full.sql

# Restore
psql $DATABASE_URL < backup_YYYYMMDD.sql

# Automated daily backup (cron)
crontab -e
# Add:
0 2 * * * pg_dump postgresql://agentcore:PASSWORD@localhost:5432/agentcore > /backups/agentcore_$(date +\%Y\%m\%d).sql
```

---

## 11. Troubleshooting

### API won't start — "JWT_SECRET is required"
```bash
# Check your .env file exists and has values
cat agentcore/.env | grep JWT
# Should not be blank
```

### "permission denied for table contacts" (RLS not applied)
```bash
# Re-run the RLS setup script
psql $DATABASE_URL -f scripts/setup-rls.sql
# Verify:
psql $DATABASE_URL -c "SELECT tablename, policyname FROM pg_policies WHERE schemaname='public';"
```

### Workers not processing jobs
```bash
# Check Redis connection
redis-cli -u $REDIS_URL ping

# Check BullMQ queue keys
redis-cli keys "bull:*" | head -20

# Restart workers
docker compose restart agentcore-workers
# or: pm2 restart agentcore-workers
```

### SMTP emails not sending
```bash
# Test SMTP from command line
openssl s_client -connect smtp.gmail.com:587 -starttls smtp

# Check SMTP env vars
grep SMTP agentcore/.env
```

### Dashboard shows "Network Error" or blank screen
```bash
# Verify API is running and CORS is correct
curl http://localhost:4000/api/health
grep CORS agentcore/.env    # Should match dashboard origin
grep NEXT_PUBLIC dashboard/.env.local  # Should point to API
```

### Database migration fails
```bash
# Use DATABASE_URL (direct :5432), NOT PGBOUNCER_URL for migrations
export DATABASE_URL=postgresql://agentcore:PASSWORD@localhost:5432/agentcore
npm run db:migrate

# Check migration state
psql $DATABASE_URL -c "SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC;"
```

---

## Quick Reference

| Service | Port | URL |
|---------|------|-----|
| Dashboard | 3000 | http://localhost:3000 |
| API | 4000 | http://localhost:4000/api |
| WebSocket | 4000 | ws://localhost:4000/ws/realtime |
| PostgreSQL | 5432 | postgresql://localhost:5432/agentcore |
| PgBouncer | 6432 | postgresql://localhost:6432/agentcore |
| Redis | 6379 | redis://localhost:6379 |
| SearXNG | 8888 | http://localhost:8888 |
| Crawl4AI | 11235 | http://localhost:11235 |

| Credential | Value |
|-----------|-------|
| Default email | admin@acme.com |
| Default password | password123 |
| DB user | agentcore |
| DB name | agentcore |
