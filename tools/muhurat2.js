'use strict';

// Muhurat v2 launcher — step profit-lock trail for stocks + options.
//   node tools/muhurat2.js
//   node tools/muhurat2.js --option
//   npm run muhurat2
//   npm run muhurat2 -- --option

process.env.MUHURAT_TRAIL = process.env.MUHURAT_TRAIL || 'step';

// Normalize singular --option / option → --Options for the shared CLI.
for (let i = 2; i < process.argv.length; i += 1) {
  const a = String(process.argv[i]);
  if (
    a === '--option' ||
    a === '--Option' ||
    a === 'option' ||
    a === 'Option' ||
    /^--?option$/i.test(a)
  ) {
    process.argv[i] = '--Options';
  }
}

require('./muhurat.js');
