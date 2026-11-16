const targets = { alerts: './main.js', 'binance-live': './binance-live-main.js', 'binance-paper': './paper-main.js' };
const mode = process.env.BOT_MODE || 'alerts';
if (!targets[mode]) throw new Error('Unknown BOT_MODE');
if (mode === 'binance-paper') process.argv.push('--live', '--binance');
await import(targets[mode]);
