const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// FUNCTION: Analyze Conversation with Investigation
// ========================================
async function analyzeConversation(conversationHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `You are a sophisticated book recommendation assistant. Analyze the conversation to decide the next step.

STEP 1 - Check for BASIC INFO (must have all 3 to proceed):
- GENRE: romance, mystery, fantasy, thriller, sci-fi, horror, literary fiction, etc.
- MOOD: sad, happy, dark, uplifting, emotional, suspenseful, cozy, etc.
- TOPIC/THEME: relationships, coming of age, war, family, adventure, grief, betrayal, etc.

STEP 2 - Investigation priorities (ask ONE question at a time, in this order):
1. If missing any basic info → ask for the missing piece(s) first
2. If basics are present but request is broad → ask about PUBLICATION ERA / BOOKTOK (highest priority)
   - Example questions: 
     "Are you looking for something recent (2020s or BookTok popular), or are you open to older classics too?"
     "Do you want a viral BookTok book that everyone is talking about right now?"
3. Then DEALBREAKERS (content warnings to avoid)
4. Then COMPLEXITY (light/easy vs literary/thought-provoking)
   → PACING and ENDING are NOT primary investigation categories anymore.
     You can usually infer them reasonably well from the book synopsis/description.

WHEN TO RECOMMEND (readyToRecommend = true):
- User gave very specific request from the start
- All 3 basic pieces present AND either:
  - Publication era / BookTok preference is clear, OR
  - User explicitly said they're open to any time period
- User has answered the most recent clarifying question

Conversation history:
${conversationHistory}

Respond with ONLY this exact JSON structure (no markdown, no backticks, no extra text):
{
  "hasBasicInfo": true/false,
  "genre": "identified genre or null",
  "mood": "identified mood or null", 
  "topic": "identified topic or null",
  "needsInvestigation": true/false,
  "investigationCategory": "publicationEra/booktok/dealbreakers/complexity or null",
  "investigationQuestion": "natural, friendly question or null",
  "preferences": {
    "publicationEra": "recent/2020s/2010s/2000s/classic/any/null",
    "booktokVibe": true/false/null,
    "complexity": "easy/literary/null",
    "dealbreakers": ["array of avoided topics or empty array"]
  },
  "readyToRecommend": true/false,
  "missingBasicInfo": ["array of missing: genre/mood/topic or empty"],
  "question": "the question to ask the user or null",
  "searchQuery": "optimized Google Books search string or null (add date range like 2020..2025 if recent)"
}

EXAMPLES:

Example 1 - Missing basics
{
  "hasBasicInfo": false,
  "genre": null,
  "mood": null,
  "topic": null,
  "needsInvestigation": false,
  "investigationCategory": null,
  "investigationQuestion": null,
  "preferences": {"publicationEra": null, "booktokVibe": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": false,
  "missingBasicInfo": ["genre", "mood", "topic"],
  "question": "What kind of book are you in the mood for today? Maybe romance, fantasy, thriller, mystery…?",
  "searchQuery": null
}

Example 2 - Has basics, ask about BookTok/recency
User said: "sad romance about heartbreak"
{
  "hasBasicInfo": true,
  "genre": "romance",
  "mood": "sad",
  "topic": "heartbreak",
  "needsInvestigation": true,
  "investigationCategory": "publicationEra",
  "investigationQuestion": "Are you looking for something recent (2020s or trending on BookTok), or are you open to older classics too?",
  "preferences": {"publicationEra": null, "booktokVibe": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": false,
  "missingBasicInfo": [],
  "question": "Are you looking for something recent (2020s or trending on BookTok), or are you open to older classics too?",
  "searchQuery": null
}

Example 3 - Ready after answering recency
{
  "hasBasicInfo": true,
  "genre": "romance",
  "mood": "sad",
  "topic": "heartbreak",
  "needsInvestigation": false,
  "investigationCategory": null,
  "investigationQuestion": null,
  "preferences": {"publicationEra": "recent", "booktokVibe": true, "complexity": null, "dealbreakers": []},
  "readyToRecommend": true,
  "missingBasicInfo": [],
  "question": null,
  "searchQuery": "sad romance heartbreak emotional 2020..2025"
}

Example 4 - Very specific from start
User: "recent BookTok fantasy with dragons and no graphic violence"
{
  "hasBasicInfo": true,
  "genre": "fantasy",
  "mood": null,
  "topic": "dragons",
  "needsInvestigation": false,
  "investigationCategory": null,
  "investigationQuestion": null,
  "preferences": {"publicationEra": "recent", "booktokVibe": true, "complexity": null, "dealbreakers": ["graphic violence"]},
  "readyToRecommend": true,
  "missingBasicInfo": [],
  "question": null,
  "searchQuery": "fantasy dragons BookTok 2020..2025 -graphic violence"
}`;

  try {
    const response = await axios.post(url, {
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    let generatedText = response.data.candidates[0].content.parts[0].text.trim();
    generatedText = generatedText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(generatedText);
  } catch (error) {
    console.error('Gemini analysis error:', error.response?.data || error.message);
    throw new Error('Failed to analyze conversation');
  }
}

// ========================================
// FUNCTION: Search Google Books
// ========================================
async function searchGoogleBooks(query) {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const searchQuery = `${query} subject:fiction`;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=20${apiKey ? '&key=' + apiKey : ''}`;
  
  try {
    const response = await axios.get(url);
    return response.data.items || [];
  } catch (error) {
    console.error('Google Books API error:', error.message);
    throw new Error('Failed to search books');
  }
}

// ========================================
// FUNCTION: Filter Novels Only (basic heuristic)
// ========================================
function filterNovelsOnly(books) {
  return books.filter(book => {
    const info = book.volumeInfo;
    const categories = (info.categories || []).join(' ').toLowerCase();
    
    const fictionKeywords = ['fiction', 'novel', 'romance', 'mystery', 'thriller', 'fantasy', 'science fiction', 'horror'];
    const nonFictionKeywords = ['non-fiction', 'biography', 'self-help', 'textbook', 'history', 'guide'];
    
    const hasFiction = fictionKeywords.some(k => categories.includes(k));
    const hasNonFiction = nonFictionKeywords.some(k => categories.includes(k));
    
    return hasFiction && !hasNonFiction;
  });
}

// ========================================
// FUNCTION: Format Books for Gemini
// ========================================
function formatBooksForGemini(books) {
  return books.map((book, index) => {
    const info = book.volumeInfo;
    return `Book ${index + 1}:
Title: ${info.title || 'Unknown'}
Author(s): ${info.authors?.join(', ') || 'Unknown'}
Description: ${info.description?.substring(0, 600) || 'No description available'}
Categories: ${info.categories?.join(', ') || 'Not specified'}
Page Count: ${info.pageCount || 'Unknown'}
Published: ${info.publishedDate || 'Unknown'}
Rating: ${info.averageRating || 'Not rated'}`;
  }).join('\n\n');
}

// ========================================
// FUNCTION: Get Book Recommendation from Gemini
// ========================================
async function getGeminiRecommendation(analysis, booksData) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const preferencesText = `
- Genre: ${analysis.genre || 'not specified'}
- Mood: ${analysis.mood || 'not specified'}
- Topic/Theme: ${analysis.topic || 'not specified'}
- Publication era / BookTok: ${analysis.preferences.publicationEra || 'any'} ${analysis.preferences.booktokVibe ? '(BookTok viral preferred)' : ''}
- Complexity: ${analysis.preferences.complexity || 'not specified'}
- Avoid: ${analysis.preferences.dealbreakers.length ? analysis.preferences.dealbreakers.join(', ') : 'none specified'}`;

  const prompt = `You are an expert book recommender. Pick the SINGLE BEST novel that matches the user's preferences from the list below.

User preferences:
${preferencesText}

Available books:
${booksData}

Rules:
- Strongly prefer books from the requested publication era if specified
- If BookTok vibe requested, favor modern, emotional, viral-style books (often 2020+)
- Infer pacing (fast/slow) and ending style (hopeful/bittersweet/tragic) from the synopsis when possible
- Avoid any content in dealbreakers
- If no perfect match, choose the closest and explain trade-offs

Respond ONLY with this JSON (no extra text):
{
  "title": "book title",
  "author": "author name(s)",
  "description": "short summary (use the provided description or improve it slightly)",
  "reasoning": "2-4 sentences explaining why this matches genre, mood, topic, era/BookTok, and avoids dealbreakers. Mention if pacing/ending was inferred.",
  "pageCount": number or null,
  "publishedDate": "YYYY-MM-DD or YYYY or null",
  "rating": number or null
}`;

  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    let text = response.data.candidates[0].content.parts[0].text.trim();
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(text);
  } catch (error) {
    console.error('Gemini recommendation error:', error.response?.data || error.message);
    throw new Error('Failed to get recommendation');
  }
}

// ========================================
// MAIN ENDPOINT: /api/chat
// ========================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log('💬 User:', message);

    const history = conversationHistory || [];
    const fullConversation = [
      ...history.map(msg => `${msg.isUser ? 'User' : 'Assistant'}: ${msg.text}`),
      `User: ${message}`
    ].join('\n');

    // Step 1: Analyze with Gemini
    const analysis = await analyzeConversation(fullConversation);
    console.log('📊 Analysis:', analysis);

    if (!analysis.readyToRecommend) {
      return res.json({
        type: 'question',
        message: analysis.question,
        analysis: {
          hasBasicInfo: analysis.hasBasicInfo,
          needsInvestigation: analysis.needsInvestigation,
          investigationCategory: analysis.investigationCategory,
          genre: analysis.genre,
          mood: analysis.mood,
          topic: analysis.topic,
          preferences: analysis.preferences,
          missingBasicInfo: analysis.missingBasicInfo
        }
      });
    }

    // Step 2: Search books
    const allBooks = await searchGoogleBooks(analysis.searchQuery);
    const novels = filterNovelsOnly(allBooks);

    if (novels.length === 0) {
      return res.json({
        type: 'question',
        message: `I couldn't find any good matches for "${analysis.searchQuery}". Would you like to try a broader time period, different mood, or change the topic a bit?`,
        analysis: analysis
      });
    }

    // Step 3: Get personalized pick
    const booksText = formatBooksForGemini(novels);
    const recommendation = await getGeminiRecommendation(analysis, booksText);

    // Step 4: Enrich with extra metadata if available
    const bestMatch = novels.find(b => 
      b.volumeInfo.title.toLowerCase().includes(recommendation.title.toLowerCase())
    );

    if (bestMatch) {
      recommendation.imageUrl = bestMatch.volumeInfo.imageLinks?.thumbnail?.replace('http://', 'https://');
      recommendation.previewLink = bestMatch.volumeInfo.previewLink;
      if (!recommendation.pageCount) recommendation.pageCount = bestMatch.volumeInfo.pageCount;
      if (!recommendation.publishedDate) recommendation.publishedDate = bestMatch.volumeInfo.publishedDate;
      if (!recommendation.rating) recommendation.rating = bestMatch.volumeInfo.averageRating;
    }

    res.json({
      type: 'recommendation',
      recommendation,
      analysis: {
        genre: analysis.genre,
        mood: analysis.mood,
        topic: analysis.topic,
        preferences: analysis.preferences
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ error: 'Something went wrong. Try again?' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Book recommendation backend running' });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});