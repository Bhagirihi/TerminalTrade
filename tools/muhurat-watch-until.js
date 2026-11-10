'use strict';

// Keep stock + options signals-only watchers alive until 15:30 IST.
// Emits AGENT_LOOP_TICK_muhurat every interval so the agent can summarize.

const { spawn } = require('child_process');
const path = require('path');
const { istDateKey, istToEpoch, istFullStr, istTimeStr } = require('../src/time');

const ROOT = path.join(__dirname, '..');
const TICK_SEC = Math.max(60, Number(process.argv[2]) || 300); // default 5 min

function untilCloseMs() {
  const day = istDateKey(Date.now());
  return istToEpoch(day, 15, 30);
}

function startWatcher(mode) {
  const child = spawn(process.execPath, [path.join(__dirname, 'muhurat-watch.js'), mode, '45'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MUHURAT_LIVE: 'false',
      MUHURAT_BUY_APPROVED: 'NO',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => process.stdout.write(`[${mode}] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[${mode}:err] ${b}`));
  child.on('exit', (code, signal) => {
    console.log(`[supervisor] ${mode} exited code=${code} signal=${signal}`);
  });
  return child;
}

async function main() {
  const endAt = untilCloseMs();
  console.log(`[supervisor] SIGNALS ONLY — watch until 15:30 IST · now ${istFullStr(Date.now())}`);
  console.log(`[supervisor] agent ticks every ${TICK_SEC}s · end ${new Date(endAt).toISOString()}`);

  let stock = startWatcher('stock');
  let options = startWatcher('options');

  while (Date.now() < endAt) {
    const leftMin = Math.max(0, Math.round((endAt - Date.now()) / 60000));
    if (!stock || stock.exitCode != null) {
      console.log('[supervisor] restarting stock watcher');
      stock = startWatcher('stock');
    }
    if (!options || options.exitCode != null) {
      console.log('[supervisor] restarting options watcher');
      options = startWatcher('options');
    }
    console.log(
      `AGENT_LOOP_TICK_muhurat ${JSON.stringify({
        prompt:
          'Read /tmp/muhurat-watch/stock-latest.json and options-latest.json (and last log lines). Summarize Live BUY/Watch changes for stock + options. Do NOT place orders. Stop watching after 15:30 IST.',
        at: istFullStr(Date.now()),
        clock: istTimeStr(Date.now()),
        minutesToClose: leftMin,
      })}`
    );
    const sleepMs = Math.min(TICK_SEC * 1000, Math.max(1000, endAt - Date.now()));
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  console.log(`[supervisor] 15:30 reached · stopping watchers · ${istFullStr(Date.now())}`);
  try { stock.kill('SIGTERM'); } catch (_) { /* ignore */ }
  try { options.kill('SIGTERM'); } catch (_) { /* ignore */ }
  console.log('AGENT_LOOP_TICK_muhurat {"prompt":"Market closed 15:30 IST. Give final stock+options summary from /tmp/muhurat-watch logs. No orders. Stop the watch loop.","done":true}');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
