module.exports = {
  apps: [
    {
      name: 'agentcore-api',
      cwd: '/opt/autonomous_agency/agentcore',
      script: 'dist/index.js',
      node_args: '--env-file=/opt/autonomous_agency/agentcore/.env',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1G',
    },
    {
      name: 'agentcore-workers',
      cwd: '/opt/autonomous_agency/agentcore',
      script: 'dist/queues/workers.js',
      node_args: '--env-file=/opt/autonomous_agency/agentcore/.env',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '1G',
    },
    {
      name: 'agentcore-dashboard',
      cwd: '/opt/autonomous_agency/dashboard',
      script: 'node_modules/.bin/next',
      args: 'start',
      exec_mode: 'fork',
      instances: 1,
      max_memory_restart: '512M',
      env: { NODE_ENV: 'production', PORT: 3000 },
    },
  ],
};
