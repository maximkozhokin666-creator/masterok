const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'www');
fs.mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'pdf-kp.js', 'pdf-fonts.js']) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}
console.log('Web assets copied to www/');
