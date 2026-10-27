// Известные провайдеры ИИ. opencode — локальный CLI-агент (https://opencode.ai):
// работает без API-ключа, модель указывается в формате provider/model.
const AI_PROVIDERS = {
  none: { label: 'Выключено', baseUrl: '', model: '' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-small-latest' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama (локально)', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder' },
  opencode: { label: 'OpenCode CLI (локальный агент)', baseUrl: '', model: '', bin: 'opencode' },
  cline: { label: 'Cline CLI (локальный агент)', baseUrl: '', model: '', bin: 'cline' },
  custom: { label: 'Другой (OpenAI-совместимый)', baseUrl: '', model: '' }
};

function providerDef(name) {
  return AI_PROVIDERS[name] || AI_PROVIDERS.none;
}

module.exports = { AI_PROVIDERS, providerDef };
