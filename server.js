require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const GROQ_KEY     = process.env.GROQ_KEY;
const OR_KEY       = process.env.OR_KEY;
const CEREBRAS_KEY = process.env.CEREBRAS_KEY;
const COHERE_KEY   = process.env.COHERE_KEY;
const WEATHER_KEY  = process.env.WEATHER_KEY;

const FAST_CHAIN = [
  { name:'GROQ',       key:GROQ_KEY,     url:'https://api.groq.com/openai/v1/chat/completions',       model:'llama-3.3-70b-versatile',               type:'openai' },
  { name:'CEREBRAS',   key:CEREBRAS_KEY, url:'https://api.cerebras.ai/v1/chat/completions',           model:'llama-3.3-70b',                         type:'openai' },
  { name:'COHERE',     key:COHERE_KEY,   url:'https://api.cohere.com/v2/chat',                        model:'command-r-plus',                        type:'cohere' },
  { name:'OPENROUTER', key:OR_KEY,       url:'https://openrouter.ai/api/v1/chat/completions',         model:'meta-llama/llama-3.3-70b-instruct:free', type:'openai' },
];

const VISION_PROVIDER = {
  name:'GROQ-VISION', key:GROQ_KEY,
  url:'https://api.groq.com/openai/v1/chat/completions',
  model:'meta-llama/llama-4-scout-17b-16e-instruct',
  type:'openai'
};

const SEARCH_PROVIDER = {
  name:'PERPLEXITY', key:OR_KEY,
  url:'https://openrouter.ai/api/v1/chat/completions',
  model:'perplexity/sonar',
  type:'openai'
};

async function callProvider(provider, messages, maxTokens = 800) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.key}`
  };
  let body;
  if (provider.type === 'cohere') {
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string' ? m.content : (m.content.find?.(p => p.type === 'text')?.text || '')
    }));
    const preamble = messages.find(m => m.role === 'system')?.content || '';
    body = JSON.stringify({ model: provider.model, messages: msgs, preamble, max_tokens: maxTokens, temperature: 0.7 });
  } else {
    if (provider.url.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://b24technologies.app';
      headers['X-Title'] = 'JOY by B24 Technologies';
    }
    body = JSON.stringify({ model: provider.model, messages, max_tokens: maxTokens, temperature: 0.7 });
  }
  const res = await fetch(provider.url, { method: 'POST', headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${provider.name} ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  if (provider.type === 'cohere') {
    return { reply: data.message?.content?.[0]?.text || null, provider: provider.name };
  } else {
    if (data.error) throw new Error(`${provider.name}: ${data.error.message}`);
    return { reply: data.choices?.[0]?.message?.content || null, provider: provider.name };
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'JOY Backend Online ⚡', version: '2.0.0', by: 'B24 Technologies' });
});

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  let lastError = null;
  for (const provider of FAST_CHAIN) {
    if (!provider.key) continue;
    try {
      const result = await callProvider(provider, messages, 800);
      if (result.reply) return res.json({ reply: result.reply, provider: result.provider });
    } catch (err) { lastError = err.message; continue; }
  }
  res.status(503).json({ error: 'All providers failed: ' + lastError });
});

app.post('/api/vision', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  try {
    const result = await callProvider(VISION_PROVIDER, messages, 800);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/search', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });
  try {
    const result = await callProvider(SEARCH_PROVIDER, messages, 800);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  if (!WEATHER_KEY) return res.status(500).json({ error: 'WEATHER_KEY not set' });
  try {
    const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}&units=metric`);
    if (!r.ok) throw new Error('Weather error ' + r.status);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/weather/comment', async (req, res) => {
  const { weatherInfo, userText } = req.body;
  if (!weatherInfo) return res.status(400).json({ error: 'weatherInfo required' });
  const prompt = `Weather: ${weatherInfo.temp}°C, ${weatherInfo.desc}, in ${weatherInfo.city}. User asked: "${userText}". Reply in 1-2 warm sentences with 1 emoji.`;
  try {
    const result = await callProvider(FAST_CHAIN[0], [
      { role: 'system', content: 'You are JOY, a friendly AI by B24 Technologies.' },
      { role: 'user', content: prompt }
    ], 120);
    res.json({ comment: result.reply });
  } catch (err) {
    res.json({ comment: `It's ${weatherInfo.temp}°C and ${weatherInfo.desc} out there! 🌡️` });
  }
});

app.post('/api/imagine', async (req, res) => {
  const { prompt, width = 1024, height = 1024, model = 'flux' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  try {
    const clean   = prompt.trim().slice(0, 500);
    const encoded = encodeURIComponent(clean);
    const url     = `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&model=${model}&nologo=true&enhance=true&seed=${Date.now()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Pollinations error ' + r.status);
    const ab     = await r.arrayBuffer();
    const base64 = Buffer.from(ab).toString('base64');
    const mime   = r.headers.get('content-type') || 'image/jpeg';
    res.json({ image: `data:${mime};base64,${base64}`, prompt: clean });
  } catch (err) {
    console.error('[IMAGINE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 JOY Backend v2.0 on port ${PORT}`);
  console.log(`   Groq:       ${GROQ_KEY     ? '✅' : '❌'}`);
  console.log(`   Cerebras:   ${CEREBRAS_KEY ? '✅' : '❌'}`);
  console.log(`   Cohere:     ${COHERE_KEY   ? '✅' : '❌'}`);
  console.log(`   OpenRouter: ${OR_KEY       ? '✅' : '❌'}`);
  console.log(`   Weather:    ${WEATHER_KEY  ? '✅' : '❌'}`);
  console.log(`   Pollinations: ✅ (no key needed)\n`);
});
