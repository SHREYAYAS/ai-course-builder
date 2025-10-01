// --- PHASE 3 & 4: BACKEND SERVER (Updated for AI) ---

// Import required packages
const express = require('express');
const cors = require('cors');
// --- NEW: Import our AI service module ---
const { generateCourseWithAI } = require('./ai-service');

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
});

