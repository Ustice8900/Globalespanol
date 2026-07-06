require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const NodeCache = require('node-cache');
const ws = require('ws');

const app = express();
const cache = new NodeCache({ stdTTL: 86400 });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { realtime: { transport: ws } });

// --- CORS: только наш домен ---
const allowedOrigins = ['https://sdvlanguage.ru', 'https://www.sdvlanguage.ru'];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '100kb' }));

// --- Rate limiting: 20 запросов в минуту с одного IP ---
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте через минуту.' }
});
app.use('/api/', apiLimiter);

// --- Проверка JWT токена Supabase ---
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Неверный или истёкший токен' });

    req.user = data.user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Ошибка авторизации' });
  }
}

// --- Валидация входных данных ---
function validateText(text, maxLen) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= maxLen;
}

function router(prompt) {
  const simple = ['переведи', 'артикль', 'как пишется', 'что значит', 'спряжение'];
  return simple.some(w => prompt.toLowerCase().includes(w)) ? 'claude-haiku-4-5' : 'claude-sonnet-4-5';
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', message: 'Espanol backend работает!' }));

app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { message, history = [] } = req.body;
    if (!validateText(message, 2000)) return res.status(400).json({ error: 'Некорректное сообщение' });
    if (!Array.isArray(history) || history.length > 30) return res.status(400).json({ error: 'Некорректная история' });

    const response = await anthropic.messages.create({
      model: router(message),
      max_tokens: 1024,
      system: 'Ты репетитор испанского языка. Отвечай на русском, объясняй примерами.',
      messages: [...history, { role: 'user', content: message }]
    });
    res.json({ reply: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/news', requireAuth, async (req, res) => {
  try {
    const { level } = req.body;
    const allowedLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    if (!allowedLevels.includes(level)) return res.status(400).json({ error: 'Некорректный уровень' });

    const key = 'news_' + level + '_' + new Date().toDateString();
    const cached = cache.get(key);
    if (cached) return res.json({ news: cached, fromCache: true });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'Пиши новости на испанском с переводом и объяснением слов.',
      messages: [{ role: 'user', content: 'Напиши новость для уровня ' + level }]
    });
    cache.set(key, response.content[0].text);
    res.json({ news: response.content[0].text, fromCache: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/dialog', requireAuth, async (req, res) => {
  try {
    const { situation, history = [], message } = req.body;
    if (!validateText(situation, 300)) return res.status(400).json({ error: 'Некорректная ситуация' });
    if (!validateText(message, 1000)) return res.status(400).json({ error: 'Некорректное сообщение' });
    if (!Array.isArray(history) || history.length > 30) return res.status(400).json({ error: 'Некорректная история' });

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: 'Ситуация: ' + situation + '. Говори на испанском, исправляй ошибки мягко.',
      messages: [...history, { role: 'user', content: message }]
    });
    res.json({ reply: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/plan', requireAuth, async (req, res) => {
  try {
    const { level, weak_areas } = req.body;
    const allowedLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    if (!allowedLevels.includes(level)) return res.status(400).json({ error: 'Некорректный уровень' });
    if (!Array.isArray(weak_areas) || weak_areas.length > 20 || !weak_areas.every(w => typeof w === 'string' && w.length <= 100)) {
      return res.status(400).json({ error: 'Некорректные слабые места' });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: 'Ты методист по испанскому языку. Составляй чёткие планы обучения.',
      messages: [{ role: 'user', content: 'Составь план на 7 дней для уровня ' + level + '. Слабые места: ' + weak_areas.join(', ') }]
    });
    res.json({ plan: response.content[0].text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Батч-перевод слов через Claude Haiku (используется при "прогреве" словаря) ---
async function translateBatch(words) {
  const wordList = words.map(w => w.word).join(', ');
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    system: 'Ты профессиональный лексикограф испанского языка. Отвечай ТОЛЬКО валидным JSON-массивом, без пояснений, без markdown-обёртки.',
    messages: [{
      role: 'user',
      content: `Для каждого испанского слова из списка дай: перевод на русский (translation_ru), русскую транскрипцию произношения кириллицей (transcription_ru), короткий пример предложения на испанском (example_es) и его перевод на русский (example_ru).
Слова: ${wordList}
Ответ строго в виде JSON-массива объектов в том же порядке, без каких-либо пояснений:
[{"word":"...", "translation_ru":"...", "transcription_ru":"...", "example_es":"...", "example_ru":"..."}]`
    }]
  });

  const raw = response.content[0].text.trim();
  const clean = raw.replace(/^```json\s*|\s*```$/g, '');
  return JSON.parse(clean);
}

app.get('/api/words/:level', async (req, res) => {
  try {
    const level = req.params.level;
    const allowedLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
    if (!allowedLevels.includes(level)) return res.status(400).json({ error: 'Некорректный уровень' });

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const cacheKey = `words_${level}_${limit}_${offset}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ words: cached, fromCache: true });

    const { data, error } = await supabase
      .from('vocabulary')
      .select('word, level, frequency_rank, translation_ru, transcription_ru, example_es, example_ru')
      .eq('level', level)
      .order('frequency_rank', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const missing = data.filter(w => !w.translation_ru);

    if (missing.length > 0) {
      try {
        const translated = await translateBatch(missing);
        const byWord = Object.fromEntries(translated.map(t => [t.word, t]));

        for (const t of translated) {
          await supabase.from('vocabulary').update({
            translation_ru: t.translation_ru,
            transcription_ru: t.transcription_ru,
            example_es: t.example_es,
            example_ru: t.example_ru
          }).eq('word', t.word);
        }

        data.forEach(w => {
          if (byWord[w.word]) Object.assign(w, byWord[w.word]);
        });
      } catch (translateError) {
        console.error('Ошибка перевода батча:', translateError.message);
      }
    }

    cache.set(cacheKey, data, 3600);
    res.json({ words: data, fromCache: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3001, () => console.log('Сервер запущен на порту 3001'));
