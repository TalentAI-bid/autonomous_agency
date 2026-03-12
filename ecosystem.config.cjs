module.exports = {
  apps: [
    // ── Node.js Application Services ──────────────────────────────────────────
    {
      name: 'agentcore-api',
      cwd: '/opt/autonomous_agency/agentcore',
      script: 'dist/index.js',
      node_args: '--env-file=/opt/autonomous_agency/agentcore/.env',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'agentcore-workers',
      cwd: '/opt/autonomous_agency/agentcore',
      script: 'dist/queues/workers.js',
      node_args: '--env-file=/opt/autonomous_agency/agentcore/.env',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'agentcore-dashboard',
      cwd: '/opt/autonomous_agency/dashboard',
      script: 'node_modules/.bin/next',
      args: 'start',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },

    // ── Docker-based Services ─────────────────────────────────────────────────
    // SearXNG — meta-search engine (required for discovery + enrichment)
    {
      name: 'searxng',
      script: 'docker',
      args: 'run --rm --name agentcore-searxng -p 8888:8080 -v /opt/autonomous_agency/agentcore/searxng:/etc/searxng:rw -e SEARXNG_BASE_URL=http://localhost:8888 --memory=512m searxng/searxng:latest',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    // Crawl4AI — web scraper (required for enrichment page scraping)
    {
      name: 'crawl4ai',
      script: 'docker',
      args: 'run --rm --name agentcore-crawl4ai -p 11235:11235 -e MAX_CONCURRENT_TASKS=5 --memory=2g unclecode/crawl4ai:latest',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
