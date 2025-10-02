// --- PHASE 4: AI SERVICE MODULE (Gemini API with free trial) ---

// Load environment variables from .env (GEMINI_API_KEY)
require('dotenv').config();

// Google Generative AI SDK
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Instantiate client with API key
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_OVERRIDE = process.env.GEMINI_MODEL; // optional manual override
const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null;
// YouTube Data API key (optional but recommended) - support both env names
const YT_API_KEY = process.env.YT_API_KEY || process.env.YOUTUBE_API_KEY;

// --- YouTube helpers ---
async function fetchYouTubeVideoId(searchQuery) {
    if (!YT_API_KEY) return null;
    const params = new URLSearchParams({
        part: 'snippet',
        q: searchQuery,
        type: 'video',
        maxResults: '1',
        key: YT_API_KEY,
        videoEmbeddable: 'true',
        safeSearch: 'moderate',
        videoDuration: 'short', // try to keep lessons concise
        regionCode: 'US',
        relevanceLanguage: 'en'
    });
    const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        console.warn('YouTube API error:', res.status, msg);
        return null;
    }
    const data = await res.json();
    const item = data.items?.[0];
    return item?.id?.videoId || null;
}

async function enrichCourseWithYouTube(course, topic) {
    if (!YT_API_KEY) return course; // nothing to do
    const cache = new Map();
    const tasks = [];
    for (const module of course.modules || []) {
        for (const lesson of module.lessons || []) {
            const q = `${topic} ${lesson.title} tutorial`;
            if (cache.has(q)) {
                const cached = cache.get(q);
                if (cached) lesson.videoId = cached;
                continue;
            }
            tasks.push((async () => {
                try {
                    const vid = await fetchYouTubeVideoId(q);
                    cache.set(q, vid);
                    if (vid) lesson.videoId = vid;
                } catch (e) {
                    console.warn('YT fetch failed for', q, e?.message || e);
                }
            })());
        }
    }
    await Promise.all(tasks);
    return course;
}

// --- Gemini model discovery (REST) ---
let discoveredModelsCache = null;
let lastWorkingModel = null; // remember the last model that worked this session
async function listAvailableModelsRest() {
    if (!API_KEY) return [];
    if (discoveredModelsCache) return discoveredModelsCache;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            const msg = await res.text().catch(() => res.statusText);
            console.warn('List models failed:', res.status, msg);
            return [];
        }
        const data = await res.json();
        discoveredModelsCache = Array.isArray(data.models) ? data.models : [];
        return discoveredModelsCache;
    } catch (e) {
        console.warn('List models error:', e?.message || e);
        return [];
    }
}

function normalizeModelName(name) {
    return (name || '').replace(/^models\//, '').trim();
}

async function testModelName(modelName, prompt) {
    const name = normalizeModelName(modelName);
    const model = genAI.getGenerativeModel({ model: name });
    const result = await model.generateContent(prompt);
    lastWorkingModel = name;
    console.log('Using Gemini model:', name);
    return result;
}

// Helper: try a list of models until one works, or throw last error
async function generateWithFirstAvailableModel(prompt) {
    // Try manual override first
    if (MODEL_OVERRIDE) {
        try {
            console.log('Trying model override from .env:', normalizeModelName(MODEL_OVERRIDE));
            return await testModelName(MODEL_OVERRIDE, prompt);
        } catch (err) {
            console.warn('Model override failed:', String(err));
        }
    }

    const candidates = [
        // Prefer newer flash models first (often available on free tiers)
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash-latest',
        'gemini-1.5-flash-001',
        'gemini-1.5-flash',
        // Then pro families
        'gemini-2.5-pro',
        'gemini-2.0-pro',
        'gemini-1.5-pro-latest',
        'gemini-1.5-pro-001',
        'gemini-1.5-pro',
        'gemini-pro'
    ];

    let lastErr;
    for (const name of candidates) {
        try {
            return await testModelName(name, prompt);
        } catch (err) {
            lastErr = err;
            // Try next model if 404 (model not found/not allowed)
            if (err?.status === 404 || /Not Found/.test(String(err))) continue;
            throw err;
        }
    }
    // Try dynamically discovered models for this key
    const models = await listAvailableModelsRest();
    const usable = models
        .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .sort((a, b) => {
            const rank = (n) => {
                n = String(n || '').toLowerCase();
                if (/2\.5.*flash/.test(n)) return 0;
                if (/2\.0.*flash/.test(n)) return 1;
                if (/1\.5.*flash/.test(n)) return 2;
                if (/2\.5.*pro/.test(n)) return 3;
                if (/2\.0.*pro/.test(n)) return 4;
                if (/1\.5.*pro/.test(n)) return 5;
                if (/\bpro\b/.test(n)) return 6;
                return 7;
            };
            return rank(a.name || '') - rank(b.name || '');
        });
    if (usable.length) {
        console.log('Discovered usable Gemini models (top 5):', usable.slice(0, 5).map(m => m.name));
    }
    for (const m of usable) {
        try {
            const name = normalizeModelName(m.name || '');
            console.log('Trying discovered model:', name);
            return await testModelName(name, prompt);
        } catch (err) {
            lastErr = err;
            if (err?.status === 404 || /Not Found/.test(String(err))) continue;
            throw err;
        }
    }
    throw lastErr;
}

// The main function that will generate a course using Gemini
async function generateCourseWithAI(topic) {
    // This is the "prompt" - the detailed instructions we give to the AI
    const prompt = `
        You are an expert course creator. Your task is to generate a complete, JSON-formatted course curriculum about a given topic.
        The topic is: "${topic}".

        The course should have 2-3 modules.
        Each module should have 2-3 lessons.
        For each lesson, you must provide:
        1. A concise 'title'.
        2. A valid YouTube video ID for a relevant, high-quality tutorial video. The video should be from a reputable source and be less than 20 minutes long if possible. Provide only the 11-character video ID.
        3. A 'type' which can be either 'free' or 'paid'. Make the first 1-2 lessons in the first module 'free' and the rest 'paid'.
        4. AI-generated 'notes' in simple HTML format (using <p>, <h3>, <h4>, <ul>, <li>, <b> tags) that summarize the key points of the lesson topic. The notes should be comprehensive enough for a beginner to understand.

        You must also provide a general 'projectIdeas' section for the whole course in simple HTML format.

        The final output must be a single, valid JSON object. Do not include any text, backticks, or explanations outside of the JSON structure.
    `;

    try {
        if (!API_KEY) {
            throw new Error('Missing GEMINI_API_KEY. Create one in Google AI Studio and put it in .env');
        }

        // Call Gemini (try a few model names for broader compatibility)
        const result = await generateWithFirstAvailableModel(prompt);
        const response = await result.response;
        const text = response.text();

        // Clean to ensure valid JSON
        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '').trim();

        const courseData = JSON.parse(cleanedText);
        // Guarantee an id so the frontend can reference this course
        if (!courseData.id) {
            courseData.id = `course-${Date.now()}`;
        }
        // Optionally replace/verify videoIds with real YouTube results
        return await enrichCourseWithYouTube(courseData, topic);

    } catch (error) {
        console.error('Error communicating with Gemini:', error?.status || '', error?.statusText || '', String(error));

        // Helpful hints for common setup pitfalls
        if (String(error).includes('Not Found')) {
            console.warn('Model not available for your key. In AI Studio, ensure access to gemini-1.5 models, or try another Google account/region.');
        } else if (String(error).includes('permission') || String(error).includes('403')) {
            console.warn('Permission issue. Ensure the Generative Language API is enabled and the AI Studio key is active.');
        } else if (String(error).includes('401')) {
            console.warn('Unauthorized. Double-check GEMINI_API_KEY value and that .env is loaded.');
        }

    // Fallback sample so the app remains usable for demos
    const course = fallbackCourse(topic);
    return await enrichCourseWithYouTube(course, topic);
    }
}

function fallbackCourse(topic) {
    return {
        id: `course-${Date.now()}`,
        title: `Complete ${topic} Course`,
        modules: [
            {
                title: `${topic} Fundamentals`,
                lessons: [
                    {
                        id: 'lesson-1',
                        title: `Introduction to ${topic}`,
                        videoId: 'kqtD5dpn9C8',
                        completed: false,
                        type: 'free',
                        notes: `<h3>Introduction to ${topic}</h3><p>Start with the basics and why ${topic} matters.</p>`
                    },
                    {
                        id: 'lesson-2',
                        title: `Getting Started with ${topic}`,
                        videoId: 'PkZNo7MFNFg',
                        completed: false,
                        type: 'free',
                        notes: `<h3>Getting Started</h3><p>Setup, your first example, and common pitfalls.</p>`
                    }
                ]
            },
            {
                title: `Advanced ${topic}`,
                lessons: [
                    {
                        id: 'lesson-3',
                        title: `Advanced ${topic} Concepts`,
                        videoId: 'sBws8MSXN7A',
                        completed: false,
                        type: 'paid',
                        notes: `<h3>Advanced Concepts</h3><p>Patterns, performance, and best practices.</p>`
                    }
                ]
            }
        ],
        projectIdeas: `<h3>Project Ideas for ${topic}</h3><ul><li>Build a mini project using ${topic}</li><li>Clone a popular app feature with ${topic}</li></ul>`
    };
}

// Export for server.js
module.exports = { generateCourseWithAI, listAvailableModelsRest, testModelName };

// Helper for diagnostics
module.exports.getSelectedModel = function getSelectedModel() {
    return (MODEL_OVERRIDE && MODEL_OVERRIDE.trim()) || lastWorkingModel || null;
};

