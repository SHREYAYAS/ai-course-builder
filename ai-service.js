// --- PHASE 4: AI INTEGRATION ---

// This file contains all the logic for communicating with the AI model.

// Import the Google Generative AI package and configure it
const { GoogleGenerativeAI } = require("@google/generative-ai");

// The 'dotenv' package loads our secret API key from the .env file
require('dotenv').config();

// Initialize the Generative AI client with the API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest"});


// This is the core function that generates a course
async function generateCourseWithAI(topic) {
  console.log(`Sending topic to AI: ${topic}`);

  // --- PROMPT ENGINEERING ---
  // This is the detailed instruction we give to the AI.
  // We tell it what its role is, what task to perform, and EXACTLY what format the output should be in.
  // This is the most important part of making the AI reliable.
  const prompt = `
    You are an expert instructional designer tasked with creating a mini-course from YouTube videos.
    The user wants to learn about: "${topic}".

    Your task is to generate a JSON object representing a course with two modules. Each module should contain three lessons.
    For each lesson, you must find a relevant, real, and embeddable YouTube video.
    For each lesson, also generate brief, helpful, introductory notes in HTML format. Use headings, paragraphs, lists, and bold tags.

    The final output MUST be a single, valid JSON object. Do not include any text or formatting before or after the JSON object.
    The JSON object must follow this exact structure:
    {
      "id": "ai-generated-course",
      "title": "Course Title About the Topic",
      "modules": [
        {
          "title": "Module 1: Descriptive Title",
          "lessons": [
            { "id": "l1", "title": "Lesson 1 Title", "videoId": "YOUTUBE_VIDEO_ID_1", "type": "free", "notes": "HTML notes for lesson 1..." },
            { "id": "l2", "title": "Lesson 2 Title", "videoId": "YOUTUBE_VIDEO_ID_2", "type": "free", "notes": "HTML notes for lesson 2..." },
            { "id": "l3", "title": "Lesson 3 Title", "videoId": "YOUTUBE_VIDEO_ID_3", "type": "paid", "notes": "HTML notes for lesson 3..." }
          ]
        },
        {
          "title": "Module 2: Descriptive Title",
          "lessons": [
            { "id": "l4", "title": "Lesson 4 Title", "videoId": "YOUTUBE_VIDEO_ID_4", "type": "free", "notes": "HTML notes for lesson 4..." },
            { "id": "l5", "title": "Lesson 5 Title", "videoId": "YOUTUBE_VIDEO_ID_5", "type": "paid", "notes": "HTML notes for lesson 5..." },
            { "id": "l6", "title": "Lesson 6 Title", "videoId": "YOUTUBE_VIDEO_ID_6", "type": "paid", "notes": "HTML notes for lesson 6..." }
          ]
        }
      ],
      "projectIdeas": "<h3>Project Idea Title</h3><p>A paragraph describing a project idea relevant to the topic.</p>"
    }
  `;

  try {
    // Send the prompt to the AI model
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // The AI might return the JSON wrapped in markdown backticks, so we clean it up.
    const cleanedText = text.replace('```json', '').replace('```', '').trim();
    
    // Convert the cleaned text string into a real JSON object
    const courseJson = JSON.parse(cleanedText);
    
    console.log("Successfully received and parsed course from AI.");
    return courseJson;

  } catch (error) {
    console.error("Error communicating with AI:", error);
    // If the AI fails, we can return null or a default error object
    return null;
  }
}

// Make the function available to be used in other files (like server.js)
module.exports = { generateCourseWithAI };
