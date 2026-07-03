require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const NodeCache = require('node-cache');

const app = express();
const cache = new NodeCache({ stdTTL: 86400 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json());

function router(prompt) {
  const simple = ['переведи','артикль','как пишется','что значит','спряжение'];
  const isSimple = simple.some(w => prompt.toLowerCase().includes(w));
  return isSimple ? 'claude-haiku-4-5' : 'claude-sonnet-4-5';
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Espanol backend работает!' });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    const model = router(message);
    const messages = [...history, { role: 'user', content: message }];
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: 'Ты репетитор испанского языка. Отвечай на русском, объясняй примерами.',
      messages
    });
    res.json({ reply: response.content[0].text, model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/errors', async (req, res) => {
  try {
    const { user_id, word, error_type, context } = req.body;
    const { data, error } = await supabase
      .from('user_errors')
      .insert([{ user_id, word, error_type, context, created_at: new Date() }]);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/words/:level', async (req, res) => {
  try {
    const { level } = req.params;
    const cacheKey = `words_${level}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ words: cached, fromCache: true });
    const { data, error } = await supabase
      .from('daily_words')
      .select('*')
      .eq('level', level)
      .limit(10);
    if (error) throw error;
    cache.set(cacheKey, data);
    res.json({ words: data, fromCache: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plan', async (req, res) => {
  try {
    const { user_id, level, weak_areas } = req.body;
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'Ты методист по испанскому языку. Составляй чёткие планы обучения.',
      messages: [{
        role: 'user',
        content: `Составь план на 7 дней для уровня ${level}. Слабые места: ${weak_areas.join(', ')}`
      }]
    });
    res.json({ plan: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/news', async (req, res) => {
  try {
    const { level } = req.body;
    const cacheKey = `news_${level}_${new Date().toDateString()}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ news: cached, fromCache: true });
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'Ты учитель испанского. Пиши новости на испанском с переводом и объяснением слов.',
      messages: [{
        role: 'user',
        content: `Напиши короткую новость на испанском для уровня ${level} с переводом и 5 новыми словами`
      }]
    });
    cache.set(cacheKey, response.content[0].text);
    res.json({ news: response.content[0].text, fromCache: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/dialog', async (req, res) => {
  try {
    const { situation, history = [], message } = req.body;
    const messages = [...history, { role: 'user', content: message }];
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: `Ты собеседник для практики испанского. Ситуация: ${situation}. Говори на испанском, исправляй ошибки мягко.`,
      messages
    });
    res.json({ reply: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
