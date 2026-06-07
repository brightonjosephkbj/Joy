require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow large base64 images

/* ─────────────────────────────────────────
   KEYS  (from .env / Render env vars)
───────────────────────────────────────── */
const GROQ_KEY        = process.env.GROQ_KEY;
const OR_KEY          = process.env.OR_KEY;
const CEREBRAS_KEY    = process.env.CEREBRAS_KEY;
const COHERE_KEY      = process.env.COHERE_KEY;
const WEATHER_KEY     = process.env.WEATHER_KEY;
const POLLINATIONS_KEY = process.env.POLLINATIONS_KEY;

/* ─────────────────────────────────────────
   PROVIDER CONFIGS
───────────────────────────────────────── */
const FAST_CHAIN = [
  { name:'GROQ',       key:GROQ_KEY,     url:'https://api.groq.com/openai/v1/chat/completions',          model:'llama-3.3-70b-versatile',                      type:'openai' },
  { name:'CEREBRAS',   key:CEREBRAS_KEY, url:'https://api.cerebras.ai/v1/chat/completions',              model:'llama-3.3-70b',                                type:'openai' },
  { name:'COHERE',     key:COHERE_KEY,   url:'https://api.cohere.com/v2/chat',                           model:'command-r-plus',                               type:'cohere' },
  { name:'OPENROUTER', key:OR_KEY,       url:'https://openrouter.ai/api/v1/chat/completions',            model:'meta-llama/llama-3.3-70b-instruct:free',        type:'openai' },
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

/* ─────────────────────────────────────────
   CALL PROVIDER HELPER
───────────────────────────────────────── */
async function callProvider(provider, messages, maxTokens = 800) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.key}`
  };

  let body;

  if (provider.type === 'cohere') {
    const cohereMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content.find?.(p => p.type === 'text')?.text || '')
      }));
    const preamble = messages.find(m => m.role === 'system')?.content || '';
    body = JSON.stringify({ model: provider.model, messages: cohereMessages, preamble, max_tokens: maxTokens, temperature: 0.7 });
  } else {
    if (provider.url.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://b24technologies.app';
      headers['X-Title']      = 'JOY by B24 Technologies';
    }
    body = JSON.stringify({ model: provider.model, messages, max_tokens: maxTokens, temperature: 0.7 });
  }

  const res = await fetch(provider.url, { method: 'POST', headers, body });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${provider.name} ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();

  if (provider.type === 'cohere') {
    return { reply: data.message?.content?.[0]?.text || null, provider: provider.name };
  } else {
    if (data.error) throw new Error(`${provider.name}: ${data.error.message}`);
    return { reply: data.choices?.[0]?.message?.content || null, provider: provider.name };
  }
}

/* ─────────────────────────────────────────
   ROUTES
───────────────────────────────────────── */

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'JOY Backend Online ⚡', version: '1.0.0', by: 'B24 Technologies' });
});

// ── FAST CHAT (fallback chain)
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  let lastError = null;

  for (const provider of FAST_CHAIN) {
    if (!provider.key) continue; // skip if key not set
    try {
      const result = await callProvider(provider, messages, 800);
      if (result.reply) {
        return res.json({ reply: result.reply, provider: result.provider });
      }
    } catch (err) {
      lastError = err.message;
      console.error(`[${provider.name}] failed:`, err.message);
      continue;
    }
  }

  res.status(503).json({ error: 'All providers failed. Last error: ' + lastError });
});

// ── VISION
app.post('/api/vision', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  try {
    const result = await callProvider(VISION_PROVIDER, messages, 800);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (err) {
    console.error('[VISION]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SEARCH
app.post('/api/search', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  try {
    const result = await callProvider(SEARCH_PROVIDER, messages, 800);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (err) {
    console.error('[SEARCH]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WEATHER
app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  if (!WEATHER_KEY)  return res.status(500).json({ error: 'WEATHER_KEY not set' });

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${WEATHER_KEY}&units=metric`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('OpenWeatherMap error ' + r.status);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('[WEATHER]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WEATHER AI COMMENT
app.post('/api/weather/comment', async (req, res) => {
  const { weatherInfo, userText } = req.body;
  if (!weatherInfo) return res.status(400).json({ error: 'weatherInfo required' });

  const prompt = `Current weather: ${weatherInfo.temp}°C (feels like ${weatherInfo.feels}°C), ${weatherInfo.desc}, humidity ${weatherInfo.humidity}%, wind ${weatherInfo.windSpd} km/h in ${weatherInfo.city}, ${weatherInfo.country}. User asked: "${userText}". Give a short warm 1-2 sentence response about the weather. Be conversational, use 1 emoji, don't repeat all numbers.`;

  try {
    const result = await callProvider(FAST_CHAIN[0], [
      { role: 'system', content: 'You are JOY, a friendly AI assistant by B24 Technologies.' },
      { role: 'user',   content: prompt }
    ], 120);
    res.json({ comment: result.reply });
  } catch (err) {
    res.json({ comment: `It's ${weatherInfo.temp}°C and ${weatherInfo.desc} out there! 🌡️` });
  }
});

// ── IMAGE GENERATION (Pollinations AI)
app.post('/api/imagine', async (req, res) => {
  const { prompt, width = 1024, height = 1024, model = 'flux', nologo = true } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!POLLINATIONS_KEY) return res.status(500).json({ error: 'POLLINATIONS_KEY not set' });

  try {
    // Clean and encode the prompt
    const cleanPrompt = prompt.trim().slice(0, 500);
    const encodedPrompt = encodeURIComponent(cleanPrompt);

    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=${model}&nologo=${nologo}&enhance=true`;

    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${POLLINATIONS_KEY}` }
    });

    if (!r.ok) throw new Error('Pollinations error ' + r.status);

    // Get image as buffer and return as base64
    const buffer = await r.buffer();
    const base64  = buffer.toString('base64');
    const mimeType = r.headers.get('content-type') || 'image/jpeg';

    res.json({
      image: `data:${mimeType};base64,${base64}`,
      prompt: cleanPrompt,
      model
    });

  } catch (err) {
    console.error('[IMAGINE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── IMAGE GENERATION (URL mode — faster, no base64)
app.post('/api/imagine/url', async (req, res) => {
  const { prompt, width = 1024, height = 1024, model = 'flux' } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const cleanPrompt  = prompt.trim().slice(0, 500);
  const encodedPrompt = encodeURIComponent(cleanPrompt);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&model=${model}&nologo=true&enhance=true&key=${POLLINATIONS_KEY}`;

  // Return the URL directly — client loads it as an <img src>
  res.json({ url: imageUrl, prompt: cleanPrompt });
});


app.listen(PORT, () => {
  console.log(`\n🚀 JOY Backend running on port ${PORT}`);
  console.log(`   Groq:        ${GROQ_KEY        ? '✅' : '❌ not set'}`);
  console.log(`   Cerebras:    ${CEREBRAS_KEY    ? '✅' : '❌ not set'}`);
  console.log(`   Cohere:      ${COHERE_KEY      ? '✅' : '❌ not set'}`);
  console.log(`   OpenRouter:  ${OR_KEY          ? '✅' : '❌ not set'}`);
  console.log(`   Weather:     ${WEATHER_KEY     ? '✅' : '❌ not set'}`);
  console.log(`   Pollinations:${POLLINATIONS_KEY? '✅' : '❌ not set'}\n`);
});
