const vscode = require('vscode');

function cfg() {
  return vscode.workspace.getConfiguration('yandexLms');
}

function debugEnabled() {
  return cfg().get('debug') === true;
}

module.exports = { cfg, debugEnabled };
