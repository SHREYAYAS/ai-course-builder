// --- IntelliCourse Backend (clean unified) ---
// Load env early so downstream modules can read keys
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');

// AI service helpers (Gemini + YouTube integration lives here)
const {
  generateCourseWithAI,
  listAvailableModelsRest,
  testModelName,
  getSelectedModel,
} = require('./ai-service');

// Create app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// Serve static front-end files (index.html etc.)
app.use(express.static(path.join(__dirname)));

// Root
app.get('/', (_req, res) => {
  res.send('Hello from the IntelliCourse AI Backend!');
});

// Health + diagnostics
app.get('/health', (_req, res) => {
  const hasKey = !!process.env.GEMINI_API_KEY;
  const hasYT = !!process.env.YT_API_KEY;
  res.json({
    status: 'ok',
    aiKeyLoaded: hasKey,
    youtubeKeyLoaded: hasYT,
    selectedModel: getSelectedModel && getSelectedModel(),
  });
});

// List models available to this key
app.get('/debug/models', async (_req, res) => {
  try {
    const models = await listAvailableModelsRest();
    res.json({ count: models.length, models });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Try a specific model name quickly
app.get('/debug/try-model', async (req, res) => {
  const name = req.query.name;
  if (!name) return res.status(400).json({ error: 'name query param required' });
  try {
    const result = await testModelName(name, 'Return the word OK');
    const text = (await result.response).text().slice(0, 200);
    res.json({ ok: true, model: name, sample: text });
  } catch (e) {
    res.status(200).json({ ok: false, model: name, error: String(e) });
  }
});

// Show env (masked) for debugging
app.get('/debug/env', (_req, res) => {
  const mask = (v) => (v ? `${v.slice(0, 6)}...${v.slice(-4)}` : null);
  res.json({
    GEMINI_API_KEY_present: !!process.env.GEMINI_API_KEY,
    GEMINI_API_KEY_sample: mask(process.env.GEMINI_API_KEY || ''),
    GEMINI_MODEL: process.env.GEMINI_MODEL || null,
    YT_API_KEY_present: !!process.env.YT_API_KEY,
    YT_API_KEY_sample: mask(process.env.YT_API_KEY || ''),
  });
});

// Shared handler for course generation
async function generateCourseHandler(req, res) {
  const topic = (req.body && req.body.topic) || '';
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Topic is required' });
  }
  try {
    const course = await generateCourseWithAI(topic);
    if (!course) return res.status(500).json({ error: 'Failed to generate course from AI.' });
    return res.json(course);
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
}

// Generate course via AI service (support both paths used by frontend)
app.post('/generate-course', generateCourseHandler);
app.post('/api/generate-course', generateCourseHandler);

// Start server
app.listen(port, () => {
  console.log(`IntelliCourse server listening at http://localhost:${port}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('Warning: GEMINI_API_KEY is not set. The app will use fallback data. Add it to your .env to enable real AI.');
  }
  // Optional: quick model discovery summary on startup
  (async () => {
    try {
      if (process.env.GEMINI_API_KEY) {
        const models = await listAvailableModelsRest();
        const usable = models.filter(
          (m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent')
        );
        console.log(`[Gemini] Discovered ${models.length} models; usable for generateContent: ${usable.length}`);
        if (usable.length) console.log('[Gemini] Example usable models:', usable.slice(0, 5).map((m) => m.name).join(', '));
      }
    } catch (e) {
      console.warn('Model discovery at startup failed:', String(e));
    }
  })();
});
