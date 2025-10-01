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
```

3. Open http://localhost:3000 in your browser. Use the Generate Course button.

### Troubleshooting
- Do not double-click `index.html`. Open the site via http://localhost:3000 so the `/api/generate-course` call succeeds.
- Port already in use: close previous node processes or change `PORT` env var.
- Keys not loading: ensure `.env` sits next to `server.js` and the server logs show `GEMINI_API_KEY: loaded` and `YOUTUBE_API_KEY: loaded`.
- Video not found: the UI will still show notes; try a different topic.

### Notes
- The backend sanitizes and parses Gemini output and maps it to the structure expected by the UI.
- No keys are exposed to the browser; all AI calls happen on the server.