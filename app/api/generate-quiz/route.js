// Next.js style route handler (for future migration). Not currently used by Express server.
// If this project is migrated into a Next.js app directory structure, this file will work.
// Expects OPENAI_API_KEY in the environment. Uses the same JSON contract as the Express route.

import { NextResponse } from 'next/server';
import OpenAI from 'openai';

const SYSTEM_PROMPT = `You are an expert quiz creator. Based on the following content, generate a 3-question multiple-choice quiz. Your response MUST be a valid JSON array of objects. Each object must have three keys: "question" (string), "options" (an array of 4 strings), and "correctAnswer" (a string that exactly matches one of the options).`;

function fallbackQuiz(lessonContent = '') {
  const topic = (lessonContent.split(/\n|\. /)[0] || 'the topic').slice(0,80);
  return [
    {
      question: `Which statement best summarizes ${topic}?`,
      options: [
        'It is unrelated to this lesson',
        `It is central to understanding ${topic}`,
        'It is only about user interface styling',
        'It refers exclusively to database indexing'
      ],
      correctAnswer: `It is central to understanding ${topic}`
    },
    {
      question: `What is a common mistake when learning ${topic}?`,
      options: [
        'Focusing only on surface examples',
        'Practicing with varied problems',
        'Reviewing core principles',
        'Building incremental projects'
      ],
      correctAnswer: 'Focusing only on surface examples'
    },
    {
      question: `Which action helps reinforce ${topic}?`,
      options: [
        'Avoiding practical application',
        'Ignoring feedback',
        'Applying concepts in small projects',
        'Memorizing without context'
      ],
      correctAnswer: 'Applying concepts in small projects'
    }
  ];
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { lessonContent } = body || {};
    if (!lessonContent || typeof lessonContent !== 'string') {
      return NextResponse.json({ error: 'lessonContent must be a non-empty string' }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ quiz: fallbackQuiz(lessonContent), source: 'fallback', reason: 'Missing OPENAI_API_KEY' }, { status: 200 });
    }

    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: lessonContent }
      ],
      temperature: 0.3
    });

    const raw = completion.choices?.[0]?.message?.content?.trim();
    if (!raw) throw new Error('Empty response from model');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) parsed = JSON.parse(match[0]); else throw new Error('Invalid JSON from model');
    }
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('Quiz array invalid length');
    for (const q of parsed) {
      if (typeof q.question !== 'string') throw new Error('Question missing');
      if (!Array.isArray(q.options) || q.options.length !== 4) throw new Error('Options invalid');
      if (typeof q.correctAnswer !== 'string' || !q.options.includes(q.correctAnswer)) throw new Error('Correct answer mismatch');
    }
    return NextResponse.json({ quiz: parsed, source: 'openai' });
  } catch (e) {
    return NextResponse.json({ quiz: fallbackQuiz(), source: 'fallback', reason: e.message }, { status: 200 });
  }
}
