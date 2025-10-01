// Import necessary modules
const path = require('path');
const express = require('express');
// Use node-fetch v2 (CommonJS) or fall back to global fetch if available
let fetch;
try { fetch = require('node-fetch'); } catch (e) { fetch = global.fetch; }
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file

// Initialize the Express application
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies from incoming requests
app.use(express.json({ limit: '1mb' }));
app.use(cors());

// Serve static files from the project root (where index.html lives)
app.use(express.static(path.join(__dirname)));

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Initialize Gemini AI (only if key exists)
const geminiApiKey = process.env.GEMINI_API_KEY;
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
console.log(`GEMINI_API_KEY: ${geminiApiKey ? 'loaded' : 'missing'}`);
console.log(`YOUTUBE_API_KEY: ${youtubeApiKey ? 'loaded' : 'missing'}`);
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

// Helper: safely extract JSON from LLM output (handles ```json fences etc.)
function safeParseJson(text) {
    try {
        const trimmed = text.trim();
        const fenced = trimmed.replace(/^```json\s*|\s*```$/g, '');
        return JSON.parse(fenced);
    } catch (e) {
        // Try to find the first JSON object
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            return JSON.parse(match[0]);
        }
        throw e;
    }
}

// Helper: map flat lessons list into 2 modules with 3 lessons each if needed
function toTwoModules(lessons, title) {
    const m1 = { title: 'Module 1', lessons: lessons.slice(0, 3) };
    const m2 = { title: 'Module 2', lessons: lessons.slice(3, 6) };
    return { id: 'ai-generated-course', title, modules: [m1, m2], projectIdeas: '<h3>Project Ideas</h3><ul><li>Build a mini project using what you learned.</li></ul>' };
}

// Helper: YouTube search for a videoId
async function findVideoIdFor(query) {
    if (!youtubeApiKey || !fetch) return null;
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=1&key=${youtubeApiKey}`;
    try {
        const r = await fetch(url);
        const j = await r.json();
        return j.items && j.items[0] ? j.items[0].id.videoId : null;
    } catch {
        return null;
    }
}

// --- API Endpoint to Generate a Course (matches frontend expected shape) ---
app.post('/api/generate-course', async (req, res) => {
    const { topic } = req.body || {};
    if (!topic || typeof topic !== 'string') {
        return res.status(400).json({ error: 'Topic is required in the request body.' });
    }

    if (!geminiApiKey) {
        return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }

    try {
        console.log(`Generating course for: ${topic}`);
        const prompt = `
            You are an expert instructional designer. Create a compact beginner course about "${topic}".
            Return ONLY a valid JSON with this exact shape:
            {
                "title": "Course Title",
                "lessons": [
                    { "title": "Lesson 1 Title", "type": "free", "notes": "<h3>...</h3><p>...</p>" },
                    { "title": "Lesson 2 Title", "type": "free", "notes": "<h3>...</h3><p>...</p>" },
                    { "title": "Lesson 3 Title", "type": "paid", "notes": "<h3>...</h3><p>...</p>" },
                    { "title": "Lesson 4 Title", "type": "free", "notes": "<h3>...</h3><p>...</p>" },
                    { "title": "Lesson 5 Title", "type": "paid", "notes": "<h3>...</h3><p>...</p>" },
                    { "title": "Lesson 6 Title", "type": "paid", "notes": "<h3>...</h3><p>...</p>" }
                ],
                "projectIdeas": "<h3>Project Idea</h3><p>Describe a simple project related to the topic.</p>"
            }
            Rules:
            - Populate exactly 6 lessons.
            - Notes must be short HTML (headings, lists ok). No markdown fences. No external links.
            - Do not include any text outside the JSON.
        `;

                // Try multiple model aliases in case one is not available for this SDK version/region
                    const candidateModels = [
                        // Modern aliases first
                        'gemini-1.5-flash-latest',
                        'gemini-1.5-pro-latest',
                        // Versioned variants used by some regions
                        'gemini-1.5-flash',
                        'gemini-1.5-flash-001',
                        'gemini-1.5-flash-002',
                        'gemini-1.5-flash-8b',
                        'gemini-1.5-pro',
                        'gemini-1.5-pro-001',
                        // Older stable
                        'gemini-1.0-pro',
                        'gemini-1.0-pro-latest'
                    ];

                let text;
                let lastErr;
                for (const m of candidateModels) {
                    try {
                        const model = genAI.getGenerativeModel({ model: m });
                        const result = await model.generateContent(prompt);
                        text = (await result.response).text();
                        console.log(`Model succeeded: ${m}`);
                        break;
                    } catch (e) {
                        lastErr = e;
                        console.warn(`Model failed: ${m} -> ${e?.status || ''} ${e?.statusText || e?.message || e}`);
                    }
                }

                // If all candidates failed, call ListModels and pick any that supports generateContent
                if (!text) {
                    try {
                        if (!fetch) throw lastErr;
                        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(geminiApiKey)}`;
                        const r = await fetch(url);
                    const j = await r.json();
                    const models = (j.models || []).filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'));
                    console.log('Discovered models:', models.map(m => m.name).join(', '));
                        // Prefer flash models first, then pro
                        const preferred = models.sort((a, b) => {
                            const score = (name) => (name.includes('flash') ? 0 : name.includes('pro') ? 1 : 2);
                            return score(a.name) - score(b.name);
                        });
                        if (preferred[0]) {
                            const name = preferred[0].name.replace('models/', '');
                            console.log(`Trying discovered model: ${name}`);
                            const mdl = genAI.getGenerativeModel({ model: name });
                            const result = await mdl.generateContent(prompt);
                            text = (await result.response).text();
                        }
                    } catch (e) {
                        lastErr = e;
                        console.warn('ListModels fallback failed:', e?.message || e);
                    }
                }

                if (!text) throw lastErr || new Error('No Gemini model available for generateContent');
        const raw = safeParseJson(text);

        // Convert flat lessons to modules and assign ids; fill videoIds via YouTube API
        const lessons = await Promise.all((raw.lessons || []).slice(0, 6).map(async (l, i) => {
            const query = `${l.title} ${topic} tutorial beginner`;
            const videoId = await findVideoIdFor(query);
            return { id: `l${i + 1}`, title: l.title, videoId: videoId || null, type: l.type || (i < 2 ? 'free' : 'paid'), notes: l.notes || '' };
        }));

        const structured = toTwoModules(lessons, raw.title || `${topic} Fundamentals`);
        console.log('Course generated successfully');
        return res.json(structured);
    } catch (error) {
        console.error('Error during course generation:', error);
        // Safe fallback to keep UI working
            const fallbackLessons = await Promise.all(Array.from({ length: 6 }).map(async (_, i) => ({
                id: `l${i + 1}`,
                title: `${topic} Lesson ${i + 1}`,
                videoId: await findVideoIdFor(`${topic} lesson ${i + 1} tutorial beginner`),
                type: i < 2 ? 'free' : 'paid',
                notes: `<h3>${topic} Lesson ${i + 1}</h3><p>Introductory notes generated as a fallback.</p>`
            })));
            return res.status(200).json(toTwoModules(fallbackLessons, `${topic} (Fallback Course)`));
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log('Open this URL in your browser instead of opening index.html directly.');
});
