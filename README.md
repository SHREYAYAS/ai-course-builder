## IntelliCourse – AI Course Builder

This project generates a mini video-based course from a topic using Google Gemini and YouTube Search. The Express backend serves the UI and provides an `/api/generate-course` endpoint.

### Prerequisites
- Node.js 18+ recommended
- Google API keys stored in `.env` in the project folder:

```
GEMINI_API_KEY=your_gemini_key_here
YOUTUBE_API_KEY=your_youtube_data_v3_key_here
```

### Install and run
1. Install dependencies
	- Windows PowerShell
```
cd "c:\Users\<you>\OneDrive\Desktop\MAJOR PROJECT\ai-course-builder"
npm install
```

2. Start the server (serves index.html and the API)
```
 npm start

### Features
- Premium course suggestions modal with AI + graceful fallback
- Quiz generation endpoint (`POST /api/generate-quiz`) producing a 3-question multiple-choice quiz (Gemini, with fallback)

3. Open http://localhost:3000 in your browser. Use the Generate Course button.

### Troubleshooting
`POST /api/generate-quiz` – Body: `{ "lessonContent": "..." }` Returns `{ quiz:[{question,options[],correctAnswer}], source:'gemini|fallback', reason? }`.
- Port already in use: close previous node processes or change `PORT` env var.
- Keys not loading: ensure `.env` sits next to `server.js` and the server logs show `GEMINI_API_KEY: loaded` and `YOUTUBE_API_KEY: loaded`.
- Video not found: the UI will still show notes; try a different topic.

### Notes
- The backend sanitizes and parses Gemini output and maps it to the structure expected by the UI.
- Quiz generation now uses the existing Gemini key; no OpenAI key required.
- No keys are exposed to the browser; all AI calls happen on the server.