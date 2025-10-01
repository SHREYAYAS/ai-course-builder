// --- PHASE 3 & 4: BACKEND SERVER (Updated for AI) ---
// Load environment variables ASAP so downstream modules can read them
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Import required packages
const express = require('express');
const cors = require('cors');
// --- NEW: Import our AI service module ---
const { generateCourseWithAI, listAvailableModelsRest, testModelName, getSelectedModel } = require('./ai-service');

// Create an Express application
const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// --- API Endpoints ---

// A simple "GET" endpoint to check if the server is running
app.get('/', (req, res) => {
  res.send('Hello from the IntelliCourse AI Backend!');
});

// Health check and diagnostics
app.get('/health', (req, res) => {
    const hasKey = !!process.env.GEMINI_API_KEY;
    const hasYT = !!process.env.YT_API_KEY;
    res.json({
        status: 'ok',
        aiKeyLoaded: hasKey,
        youtubeKeyLoaded: hasYT,
        selectedModel: getSelectedModel && getSelectedModel(),
    });
});

// Diagnostics: list models available to this key
app.get('/debug/models', async (req, res) => {
    try {
        const models = await listAvailableModelsRest();
        res.json({ count: models.length, models });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Diagnostics: show which env vars are visible (masked)
app.get('/debug/env', (req, res) => {
    const mask = (v) => (v ? `${v.slice(0, 6)}...${v.slice(-4)}` : null);
    res.json({
        GEMINI_API_KEY_present: !!process.env.GEMINI_API_KEY,
        GEMINI_API_KEY_sample: mask(process.env.GEMINI_API_KEY || ''),
        GEMINI_MODEL: process.env.GEMINI_MODEL || null,
        YT_API_KEY_present: !!process.env.YT_API_KEY,
        YT_API_KEY_sample: mask(process.env.YT_API_KEY || ''),
    });
});

// Try a specific model name (query: ?name=gemini-1.5-flash)
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

// The main "POST" endpoint for generating a course
// It is now an 'async' function because it needs to 'await' the AI's response
app.post('/generate-course', async (req, res) => {
    const topic = req.body.topic;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    try {
        // --- THIS IS THE MAGIC ---
        // Instead of our old if/else logic, we now call our AI function
        const courseData = await generateCourseWithAI(topic);

        if (courseData) {
            // If we got a valid course, send it back to the front-end
            res.json(courseData);
        } else {
            // If the AI failed, send an error message
            res.status(500).json({ error: 'Failed to generate course from AI.' });
        }
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: 'An internal server error occurred.' });
    }
});


// --- Start the Server ---
app.listen(port, () => {
  console.log(`IntelliCourse server listening at http://localhost:${port}`);
    if (!process.env.GEMINI_API_KEY) {
        console.warn('Warning: GEMINI_API_KEY is not set. The app will use fallback data. Add it to your .env to enable real AI.');
    }
    // Diagnostics: log a quick summary of available models at startup
    (async () => {
        try {
            if (process.env.GEMINI_API_KEY) {
                const models = await listAvailableModelsRest();
                const usable = models.filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
                console.log(`[Gemini] Discovered ${models.length} models for this key; usable for generateContent: ${usable.length}`);
                if (usable.length) {
                    console.log('[Gemini] Example usable models:', usable.slice(0, 5).map(m => m.name).join(', '));
                } else {
                    console.warn('[Gemini] No models supporting generateContent are accessible to this key. Free trial/region may be limited.');
                }
            }
        } catch (e) {
            console.warn('Model discovery at startup failed:', String(e));
        }
    })();
});

