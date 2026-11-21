'use strict';

// PM2 process file for Oracle / always-on Muhurat2.
//
// On the server:
//   cd /path/to/repo
//   npm install
//   # set .env: UPSTOX_ACCESS_TOKEN, MUHURAT_LIVE*, budgets, and:
//   #   MUHURAT_AUTO_APPROVE=paper   # safe default (simulated)
//   #   MUHURAT_AUTO_APPROVE=live    # real Upstox orders (needs LIVE flags)
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup          # enable boot restart (run the command it prints)
//
// Useful:
//   pm2 logs muhurat2
//   pm2 restart muhurat2
//   pm2 stop muhurat2

const path = require('path');

module.exports = {
  apps: [
    {
      name: 'muhurat2',
      script: path.join(__dirname, 'tools', 'muhurat.js'),
      args: '--both',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      max_restarts: 30,
      min_uptime: '15s',
      restart_delay: 5000,
      kill_timeout: 15000,
      time: true,
      out_file: path.join(__dirname, 'logs', 'muhurat2-out.log'),
      error_file: path.join(__dirname, 'logs', 'muhurat2-error.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        // Non-interactive approval (required under PM2 — no TTY).
        // Prefer setting this in .env; uncomment to force here:
        // MUHURAT_AUTO_APPROVE: 'paper',
      },
    },
  ],
};
