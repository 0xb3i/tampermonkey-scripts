const { resolve } = require('node:path');

const DEFAULT_SITES = Object.freeze(['chatgpt', 'gemini', 'tika', 'aistudio']);
const DEFAULT_SCRIPT_PATH = resolve(__dirname, '../userscripts/copy-cleaner.user.js');

module.exports = {
  DEFAULT_SCRIPT_PATH: DEFAULT_SCRIPT_PATH,
  DEFAULT_SITES: DEFAULT_SITES,
};
