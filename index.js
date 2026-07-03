node -e "
const fs = require('fs');
const code = \`require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const NodeCache = require('node-cache');
const ws = require('ws');

const app = express();
const cache = new NodeCache({ stdTTL: 86400 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } });

app.use(cors());
app.use(express.json());

function router(prompt) {
  const simple = ['переведи','артикль','как пишется','что значит','спряжение'];
  return simple.some(w => prompt.toLowerCase().includes(w)) ? 'claude-haiku-4-5' : 'claude-sonnet-4-5';
}

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const response = await anthropic.messages.create({
      model: router(message), max_tokens: 1024,
      system: 'Ты репетитор испанского. Отвечай на русском.',
      messages: [...history, { role: 'user', content: message }]
    });
    res.json({ reply: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news', async (req, res) => {
  try {
    const { level } = req.body;
    const key = 'news_' + level + '_' + new Date().toDateString();
    const cached = cache.get(key);
    if (cached) return res.json({ news: cached, fromCache: true });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      system: 'Пиши новости на испанском с переводом.',
      messages: [{ role: 'user', content: 'Новость для уровня ' + level }]
    });
    cache.set(key, response.content[0].text);
    res.json({ news: response.content[0].text, fromCache: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dialog', async (req, res) => {
  try {
    const { situation, history = [], message } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 512,
      system: 'Ситуация: ' + situation + '. Говори на испанском.',
      messages: [...history, { role: 'user', content: message }]
    });
    res.json({ reply: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3001, () => console.log('Сервер запущен на порту 3001'));
\`;
fs.writeFileSync('/var/www/espanol-backend/index.js', code);
console.log('Файл создан!');
"
