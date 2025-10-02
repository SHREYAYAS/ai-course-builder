// --- IntelliCourse Backend (clean unified) ---
// Load env early so downstream modules can read keys
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const fs = require('fs');

// Optional: Firebase Admin for server-side Firestore writes
let admin = null;
let firestore = null;
try {
  const saPathCandidates = [
    path.join(__dirname, 'serviceAccountKey.json'),
    path.join(__dirname, 'serviceAccountKey.json.json'),
    process.env.FIREBASE_SERVICE_ACCOUNT || '',
  ].filter(Boolean);
  const saPath = saPathCandidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  if (saPath) {
    // Lazy require to avoid error if package not installed
    const adminLib = require('firebase-admin');
    const serviceAccount = require(saPath);
    admin = adminLib;
    if (!admin.apps?.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    firestore = admin.firestore();
    console.log('[Firestore] Admin initialized using', path.basename(saPath));
  } else {
    console.warn('[Firestore] Service account key not found. Server-side saves will be skipped.');
  }
} catch (e) {
  console.warn('[Firestore] Admin init failed:', e?.message || e);
}

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
const corsOptions = {
  origin: true, // reflect request origin (including file:// as 'null')
  credentials: false,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));
// Handle CORS preflight for all routes (needed for POST with JSON from file://)
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
// Serve static front-end files (index.html etc.)
app.use(express.static(path.join(__dirname)));

// Root - serve the UI
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
  const userId = (req.body && req.body.userId) || null;
  if (!topic || typeof topic !== 'string') {
    return res.status(400).json({ error: 'Topic is required' });
  }
  try {
    const course = await generateCourseWithAI(topic);
    if (!course) return res.status(500).json({ error: 'Failed to generate course from AI.' });

    // Server-side save if Firestore and userId are available
    let saved = false;
    // Normalize payload with ownerId and timestamps
    const normalizedId = String(course.id || `course-${Date.now()}`);
    const courseDoc = {
      ...course,
      id: normalizedId,
      ownerId: userId || course.ownerId || null,
      createdAt: new Date().toISOString(),
    };

    if (firestore && userId && courseDoc && courseDoc.id) {
      try {
        const ref = firestore.collection('users').doc(userId).collection('courses').doc(String(courseDoc.id));
        await ref.set(courseDoc, { merge: true });
        saved = true;
      } catch (e) {
        console.warn('[Firestore] Failed to save course server-side:', e?.message || e);
      }
    }

    return res.json({ ...courseDoc, saved });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'An internal server error occurred.' });
  }
}

// Generate course via AI service (support both paths used by frontend)
app.post('/generate-course', generateCourseHandler);
app.post('/api/generate-course', generateCourseHandler);

// Mark a lesson as complete for a user's course
app.post('/courses/:courseId/complete', async (req, res) => {
  try {
    if (!firestore) {
      return res.status(501).json({ error: 'Firestore admin not configured on server' });
    }
    const courseId = String(req.params.courseId || '');
    const { userId, moduleIndex, lessonIndex, completed } = req.body || {};
    if (!userId || !courseId || typeof moduleIndex !== 'number' || typeof lessonIndex !== 'number') {
      return res.status(400).json({ error: 'userId, courseId, moduleIndex, lessonIndex are required' });
    }

    const ref = firestore.collection('users').doc(userId).collection('courses').doc(courseId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Course not found' });
    const data = snap.data() || {};
    if (data.ownerId && data.ownerId !== userId) {
      return res.status(403).json({ error: 'Not authorized to modify this course' });
    }

    const mods = Array.isArray(data.modules) ? data.modules : [];
    if (!mods[moduleIndex] || !mods[moduleIndex].lessons || !mods[moduleIndex].lessons[lessonIndex]) {
      return res.status(400).json({ error: 'Invalid moduleIndex/lessonIndex' });
    }
    const mark = typeof completed === 'boolean' ? completed : true;
    mods[moduleIndex].lessons[lessonIndex].completed = mark;
    data.modules = mods;
    data.updatedAt = new Date().toISOString();
    await ref.set(data, { merge: true });
    return res.json({ ok: true, course: data });
  } catch (e) {
    console.error('Complete lesson error:', e);
    return res.status(500).json({ error: 'Failed to update lesson status' });
  }
});

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
