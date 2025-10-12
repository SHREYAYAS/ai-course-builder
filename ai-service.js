// --- PHASE 4: AI SERVICE MODULE (Gemini API with free trial) ---

// Load environment variables from .env (GEMINI_API_KEY)
require('dotenv').config();

// Google Generative AI SDK (guarded import for environments where ESM-only packages break require)
let GoogleGenerativeAI;
try {
    ({ GoogleGenerativeAI } = require('@google/generative-ai'));
} catch (e) {
    console.warn('[GenAI] SDK load failed (non-fatal). Falling back to sample data. Details:', e?.message || e);
}

// Instantiate client with API key
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_OVERRIDE = process.env.GEMINI_MODEL; // optional manual override
const genAI = (API_KEY && GoogleGenerativeAI) ? new GoogleGenerativeAI(API_KEY) : null;
// YouTube Data API key (optional but recommended) - support both env names
const YT_API_KEY = process.env.YT_API_KEY || process.env.YOUTUBE_API_KEY;
// Allow disabling enrichment in production if quota is tight
const YT_ENRICH = String(process.env.YT_ENRICH || 'true').toLowerCase() !== 'false';

// Simple in-memory cache and quota backoff flag
const ytCache = new Map(); // key: query -> videoId|null
let ytQuotaBackoffUntil = 0; // epoch ms until which we skip calls

// --- YouTube helpers ---
function isValidVideoId(id) {
    return typeof id === 'string' && /^[\w-]{11}$/.test(id);
}

async function fetchYouTubeVideoId(searchQuery) {
    if (!YT_API_KEY) return null;
    if (Date.now() < ytQuotaBackoffUntil) return null;
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
        let msgText = res.statusText;
        try {
            const j = await res.json();
            msgText = JSON.stringify(j);
            // Detect quota exceeded and back off for 1 hour
            const reason = j?.error?.errors?.[0]?.reason || j?.error?.errors?.[0]?.message || '';
            if (res.status === 403 && /quota/i.test(JSON.stringify(j))) {
                ytQuotaBackoffUntil = Date.now() + 60 * 60 * 1000; // 1 hour backoff
                console.warn('YouTube quota exceeded. Disabling enrichment for 1 hour.');
            }
        } catch (_) {
            try { msgText = await res.text(); } catch(_) {}
        }
        console.warn('YouTube API error:', res.status, msgText);
        return null;
    }
    const data = await res.json();
    const item = data.items?.[0];
    return item?.id?.videoId || null;
}

async function enrichCourseWithYouTube(course, topic) {
    if (!YT_ENRICH || !YT_API_KEY) return course; // disabled or no key
    if (Date.now() < ytQuotaBackoffUntil) return course; // backoff in effect
    // Sequential (low-concurrency) to avoid quota spikes
    for (const module of course.modules || []) {
        for (const lesson of module.lessons || []) {
            // Skip if AI already provided a valid videoId
            if (isValidVideoId(lesson.videoId)) continue;
            const q = `${topic} ${lesson.title} tutorial`;
            if (ytCache.has(q)) {
                const cached = ytCache.get(q);
                if (cached) lesson.videoId = cached;
                continue;
            }
            try {
                const vid = await fetchYouTubeVideoId(q);
                ytCache.set(q, vid);
                if (vid) lesson.videoId = vid;
                if (Date.now() < ytQuotaBackoffUntil) return course; // stop early if quota hit
            } catch (e) {
                console.warn('YT fetch failed for', q, e?.message || e);
            }
        }
    }
    return course;
}

// Ensure each lesson has some playable videoId even if enrichment or AI didn't provide one
function ensureLessonVideos(course) {
    try {
        const defaults = ['kqtD5dpn9C8', 'PkZNo7MFNFg', 'sBws8MSXN7A'];
        let i = 0;
        for (const module of course.modules || []) {
            for (const lesson of module.lessons || []) {
                if (!isValidVideoId(lesson.videoId)) {
                    lesson.videoId = defaults[i % defaults.length];
                    i++;
                }
            }
        }
    } catch (_) {}
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
    if (!genAI) throw new Error('GenAI client unavailable');
    const name = normalizeModelName(modelName);
    const model = genAI.getGenerativeModel({ model: name });
    const result = await model.generateContent(prompt);
    lastWorkingModel = name;
    console.log('Using Gemini model:', name);
    return result;
}

// Helper: try a list of models until one works, or throw last error
async function generateWithFirstAvailableModel(prompt) {
    if (!genAI) {
        // No client available (SDK missing or API key absent) -> let caller hit fallback path
        throw new Error('GenAI client unavailable');
    }
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
async function generateCourseWithAI(topic, options = {}) {
    const difficulty = (options?.difficulty || 'beginner').toLowerCase();
    const length = (options?.length || 'short').toLowerCase();

    // Map length to module/lesson targets
    const lengthMap = {
        short: { modules: '2', lessonsPerModule: '2' },
        medium: { modules: '3', lessonsPerModule: '3' },
        long: { modules: '4', lessonsPerModule: '3-4' },
    };
    const lm = lengthMap[length] || lengthMap.short;

    // Difficulty guidance
    const difficultyGuidance = {
        beginner: 'Use very approachable explanations, avoid jargon unless defined, include analogies and gentle progression.',
        intermediate: 'Assume the learner knows fundamentals; focus on practical patterns, trade-offs, and building real mini features.',
        advanced: 'Assume strong foundation; emphasize performance, architecture decisions, edge cases, and expert tips.',
    }[difficulty] || difficultyGuidance?.beginner;

    // This is the "prompt" - the detailed instructions we give to the AI
    const prompt = `
        You are an expert course creator. Your task is to generate a complete, JSON-formatted course curriculum about a given topic.
        Topic: "${topic}".

        Target learner difficulty level: ${difficulty.toUpperCase()}.
        Guidance for tone & depth: ${difficultyGuidance}

        Course sizing preference: ${length.toUpperCase()} (aim for about ${lm.modules} modules, each with ${lm.lessonsPerModule} lessons).
        If 'long', you may add an optional capstone module at the end.

        Respect these sizing targets as closely as possible.

        For EACH lesson provide:
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
    courseData.meta = { difficulty, length };
        // Post-process to enforce sizing targets more strictly
        try {
            const targetMap = {
                short: { modules: 2, lessonsMin: 2, lessonsMax: 2 },
                medium: { modules: 3, lessonsMin: 3, lessonsMax: 3 },
                long: { modules: 4, lessonsMin: 3, lessonsMax: 4 },
            };
            const target = targetMap[length] || targetMap.short;
            if (Array.isArray(courseData.modules)) {
                // Trim or pad modules
                if (courseData.modules.length > target.modules) {
                    courseData.modules = courseData.modules.slice(0, target.modules);
                } else if (courseData.modules.length < target.modules) {
                    // If fewer modules, duplicate last with adjusted title placeholder
                    const last = courseData.modules[courseData.modules.length - 1];
                    while (courseData.modules.length < target.modules) {
                        courseData.modules.push({
                            title: `${last?.title || 'Module'} (Extended ${courseData.modules.length + 1})`,
                            lessons: []
                        });
                    }
                }
                // Normalize lessons per module
                courseData.modules = courseData.modules.map((m, idx) => {
                    if (!Array.isArray(m.lessons)) m.lessons = [];
                    // Desired count for this module
                    const desired = Math.min(target.lessonsMax, Math.max(target.lessonsMin, m.lessons.length || target.lessonsMin));
                    if (m.lessons.length > desired) {
                        m.lessons = m.lessons.slice(0, desired);
                    } else if (m.lessons.length < desired) {
                        while (m.lessons.length < desired) {
                            m.lessons.push({
                                title: `Placeholder Lesson ${m.lessons.length + 1}`,
                                videoId: 'null',
                                type: idx === 0 && m.lessons.length < 2 ? 'free' : 'paid',
                                completed: false,
                                notes: `<p>Additional autogenerated content placeholder for ${topic}. Expand this lesson manually.</p>`
                            });
                        }
                    }
                    return m;
                });
            }
        } catch (ppErr) {
            console.warn('Post-process sizing enforcement failed (non-fatal):', ppErr?.message || ppErr);
        }
        // Guarantee an id so the frontend can reference this course
        if (!courseData.id) {
            courseData.id = `course-${Date.now()}`;
        }
    // Optionally replace/verify videoIds with real YouTube results
    const enriched = await enrichCourseWithYouTube(courseData, topic);
    return ensureLessonVideos(enriched);

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
    const enriched = await enrichCourseWithYouTube(course, topic);
    return ensureLessonVideos(enriched);
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

// Premium course suggestion generator
async function generatePremiumSuggestions(topic) {
    const prompt = `Suggest 6 paid, high-quality advanced learning resources or premium structured courses related to "${topic}".
Return JSON array. Each item must have: title, provider, format (video series | interactive | cohort | bootcamp | ebook), difficulty (intermediate|advanced|mixed), url (plausible if unknown), value (short selling point), and estHours (approx hours or range).
Keep titles concise (max 60 chars). No markdown, only JSON.`;
    try {
        if (!API_KEY) throw new Error('Missing GEMINI_API_KEY');
        const result = await generateWithFirstAvailableModel(prompt);
        const txt = (await result.response).text().replace(/```json|```/g,'').trim();
        const data = JSON.parse(txt);
        if (Array.isArray(data)) return data.slice(0,6);
    } catch (e) {
        console.warn('Premium suggestions AI failed, using fallback:', e?.message || e);
    }
    return [
        { title:`${topic} Mastery Bootcamp`, provider:'SkillPro Labs', format:'cohort', difficulty:'advanced', url:'#', value:'Intensive mentor-led deep dive', estHours:'40+' },
        { title:`${topic} Architecture Patterns`, provider:'EduForge', format:'video series', difficulty:'advanced', url:'#', value:'Real-world scaling strategies', estHours:'12' },
        { title:`Hands-on ${topic} Projects`, provider:'BuildX', format:'interactive', difficulty:'intermediate', url:'#', value:'Five guided portfolio builds', estHours:'18' },
        { title:`${topic} Performance Optimization`, provider:'OptiLearn', format:'video series', difficulty:'advanced', url:'#', value:'Profiling & tuning toolkit', estHours:'9' },
        { title:`${topic} Design Systems`, provider:'CraftSchool', format:'ebook', difficulty:'intermediate', url:'#', value:'Patterns & reusable components', estHours:'6' },
        { title:`Elite ${topic} Interview Prep`, provider:'PrepCamp', format:'cohort', difficulty:'advanced', url:'#', value:'Scenario-based expert sessions', estHours:'25+' }
    ];
}

// Gemini-based quiz generator (3 MCQs)
async function generateQuizFromLessonGemini(lessonContent) {
    if (!lessonContent || typeof lessonContent !== 'string') {
        throw new Error('lessonContent must be a non-empty string');
    }
    const quizPrompt = `You are an expert quiz creator. Based on the following content, generate a 3-question multiple-choice quiz. Your response MUST be a valid JSON array of exactly 3 objects. Each object must have keys: "question" (string), "options" (array of 4 concise unique strings), and "correctAnswer" (a string that exactly matches one of the options). Do not include any explanation or commentary outside the JSON. Content:\n\n${lessonContent.slice(0,4000)}`;
    try {
        if (!API_KEY) throw new Error('Missing GEMINI_API_KEY');
        const result = await generateWithFirstAvailableModel(quizPrompt);
        const txt = (await result.response).text().replace(/```json|```/g,'').trim();
        let data;
        try { data = JSON.parse(txt); }
        catch(_) {
            const match = txt.match(/\[[\s\S]*\]/);
            if (match) data = JSON.parse(match[0]); else throw new Error('Invalid JSON');
        }
        if (!Array.isArray(data) || data.length !== 3) throw new Error('Quiz must be array length 3');
        for (const q of data) {
            if (typeof q.question !== 'string') throw new Error('Invalid question');
            if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error('Options must length 4');
            if (typeof q.correctAnswer !== 'string' || !q.options.includes(q.correctAnswer)) throw new Error('correctAnswer mismatch');
        }
        return { quiz: data, source: 'gemini' };
    } catch (e) {
        const topicLine = (lessonContent.split(/\n|\. /)[0] || 'the topic').slice(0,80);
        return { quiz: [
            { question:`Which statement best summarizes ${topicLine}?`, options:[`It is central to understanding ${topicLine}`,'It is unrelated','It is only UI styling','It is only about databases'], correctAnswer:`It is central to understanding ${topicLine}` },
            { question:`What helps reinforce ${topicLine}?`, options:['Ignoring practice','Memorizing only','Applying concepts in small projects','Avoiding feedback'], correctAnswer:'Applying concepts in small projects' },
            { question:`Common mistake when learning ${topicLine}?`, options:['Building projects','Reviewing basics periodically','Focusing only on surface examples','Seeking feedback'], correctAnswer:'Focusing only on surface examples' }
        ], source:'fallback', reason: e.message };
    }
}

// Export for server.js
module.exports = { generateCourseWithAI, listAvailableModelsRest, testModelName, generatePremiumSuggestions, generateQuizFromLessonGemini };

// Helper for diagnostics
module.exports.getSelectedModel = function getSelectedModel() {
    return (MODEL_OVERRIDE && MODEL_OVERRIDE.trim()) || lastWorkingModel || null;
};

// Expose YouTube enrichment status for diagnostics/clients
module.exports.getYouTubeStatus = function getYouTubeStatus() {
    return {
        hasApiKey: !!YT_API_KEY,
        enrichEnabled: !!YT_ENRICH,
        backoffUntil: ytQuotaBackoffUntil || 0,
    };
};

