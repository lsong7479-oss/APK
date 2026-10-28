// 把 Capacitor 核心与插件的浏览器脚本复制到 www/lib/cap，供 index.html 直接引用（无需打包工具）
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'www', 'lib', 'cap');
fs.mkdirSync(out, { recursive: true });
const files = {
  'core.js': '@capacitor/core/dist/capacitor.js',
  'synapse.js': '@capacitor/synapse/dist/synapse.js',
  'filesystem.js': '@capacitor/filesystem/dist/plugin.js',
  'share.js': '@capacitor/share/dist/plugin.js',
  'preferences.js': '@capacitor/preferences/dist/plugin.js',
  'app.js': '@capacitor/app/dist/plugin.js',
};
for (const [name, src] of Object.entries(files)) {
  fs.copyFileSync(path.join(root, 'node_modules', src), path.join(out, name));
}
console.log('copied', Object.keys(files).join(', '));
