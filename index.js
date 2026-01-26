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
  
  const prompt = `You are a sophisticated book recommendation assistant. Analyze the conversation to determine the next step.

STEP 1 - Check if you have BASIC INFO (Genre + Mood + Topic):
- GENRE: romance, mystery, fantasy, thriller, sci-fi, horror, literary fiction, etc.
- MOOD: sad, happy, dark, uplifting, emotional, suspenseful, cozy, etc.
- TOPIC/THEME: relationships, coming of age, war, family, adventure, grief, etc.

STEP 2 - If you have all 3 basics BUT the request is still BROAD, ask ONE clarifying question from:
1. PACING: "Do you prefer a fast-paced, action-driven story or a slow burn that develops gradually?"
2. ENDING: "How do you feel about endings? Would you prefer bittersweet/hopeful or tragic/devastating?"
3. COMPLEXITY: "Are you looking for an easy, light read or something more literary and thought-provoking?"
4. DEALBREAKERS: "Are there any content warnings or topics you'd like to avoid? (e.g., violence, explicit scenes, death of pets)"

WHEN TO INVESTIGATE (ask clarifying questions):
- Request is too broad: "sad romance" → ASK about pacing, ending, or complexity
- Generic genre: "mystery book" → ASK what makes them want mystery (suspense, puzzle-solving, etc.)
- Common combinations: "fantasy adventure" → ASK about tone (dark vs. lighthearted)
- Only adjectives given: "dark and emotional" → ASK about genre first

WHEN TO RECOMMEND (skip investigation):
- Very specific request: "dark slow-burn thriller about serial killers with a bittersweet ending"
- Niche combination: "cozy mystery set in a bakery"
- User has answered investigation questions
- Clear preferences: "I want X but not Y"

Conversation history:
${conversationHistory}

Respond with ONLY a JSON object (no markdown, no backticks):
{
  "hasBasicInfo": true/false,
  "genre": "identified genre or null",
  "mood": "identified mood or null", 
  "topic": "identified topic or null",
  "needsInvestigation": true/false,
  "investigationCategory": "pacing/ending/complexity/dealbreakers or null",
  "investigationQuestion": "specific natural question or null",
  "preferences": {
    "pacing": "fast/slow/null",
    "ending": "bittersweet/tragic/hopeful/null",
    "complexity": "easy/literary/null",
    "dealbreakers": ["array of things to avoid or empty"]
  },
  "readyToRecommend": true/false,
  "missingBasicInfo": ["list of missing basic pieces"],
  "question": "question to ask user or null",
  "searchQuery": "optimized Google Books query or null"
}

EXAMPLES:

Example 1 - Missing basic info:
User: "I want a book"
{
  "hasBasicInfo": false,
  "genre": null,
  "mood": null,
  "topic": null,
  "needsInvestigation": false,
  "investigationCategory": null,
  "investigationQuestion": null,
  "preferences": {"pacing": null, "ending": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": false,
  "missingBasicInfo": ["genre", "mood", "topic"],
  "question": "I'd love to help! What kind of story are you in the mood for? For example, mystery, romance, fantasy, or thriller?",
  "searchQuery": null
}

Example 2 - Has basic info but BROAD (needs investigation):
User: "I want a sad romance about relationships"
{
  "hasBasicInfo": true,
  "genre": "romance",
  "mood": "sad",
  "topic": "relationships",
  "needsInvestigation": true,
  "investigationCategory": "pacing",
  "investigationQuestion": "Do you prefer a fast-paced romance with quick developments, or a slow burn where the relationship builds gradually over time?",
  "preferences": {"pacing": null, "ending": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": false,
  "missingBasicInfo": [],
  "question": "Do you prefer a fast-paced romance with quick developments, or a slow burn where the relationship builds gradually over time?",
  "searchQuery": null
}

Example 3 - Investigation answered (ready to recommend):
User: "Slow burn please"
Previous context shows: sad romance, relationships, slow burn
{
  "hasBasicInfo": true,
  "genre": "romance",
  "mood": "sad",
  "topic": "relationships",
  "needsInvestigation": false,
  "investigationCategory": null,
  "investigationQuestion": null,
  "preferences": {"pacing": "slow", "ending": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": true,
  "missingBasicInfo": [],
  "question": null,
  "searchQuery": "sad romance relationships heartbreak slow burn emotional"
}

Example 4 - Very specific from start (skip investigation):
User: "I want a fast-paced dark thriller about serial killers with a bittersweet ending, nothing too graphic"
{
  "hasBasicInfo": true,
  "genre": "thriller",
  "mood": "dark",
  "topic": "serial killers",
  "needsInvestigation": false,
  "investigationCategory": null,
  "investigationQuestion": null,
  "preferences": {"pacing": "fast", "ending": "bittersweet", "complexity": null, "dealbreakers": ["graphic violence"]},
  "readyToRecommend": true,
  "missingBasicInfo": [],
  "question": null,
  "searchQuery": "dark thriller serial killer suspenseful bittersweet"
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

    const generatedText = response.data.candidates[0].content.parts[0].text.trim();
    const cleanText = generatedText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(cleanText);
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
// FUNCTION: Filter Novels Only
// ========================================
function filterNovelsOnly(books) {
  return books.filter(book => {
    const info = book.volumeInfo;
    const categories = info.categories || [];
    const categoriesString = categories.join(' ').toLowerCase();
    
    const fictionKeywords = ['fiction', 'novel', 'romance', 'mystery', 'thriller', 'fantasy', 'science fiction', 'horror', 'adventure'];
    const nonFictionKeywords = ['non-fiction', 'biography', 'self-help', 'textbook', 'history'];
    
    const hasFiction = fictionKeywords.some(k => categoriesString.includes(k));
    const hasNonFiction = nonFictionKeywords.some(k => categoriesString.includes(k));
    
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
Description: ${info.description?.substring(0, 500) || 'No description'}
Categories: ${info.categories?.join(', ') || 'Not specified'}
Page Count: ${info.pageCount || 'Not specified'}
Average Rating: ${info.averageRating || 'Not rated'}
Published: ${info.publishedDate || 'Unknown'}`;
  }).join('\n\n');
}

// ========================================
// FUNCTION: Get Book Recommendation
// ========================================
async function getGeminiRecommendation(analysis, booksData) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const preferencesText = `
- Genre: ${analysis.genre}
- Mood: ${analysis.mood}
- Topic/Theme: ${analysis.topic}
- Pacing: ${analysis.preferences.pacing || 'not specified'}
- Ending preference: ${analysis.preferences.ending || 'not specified'}
- Complexity: ${analysis.preferences.complexity || 'not specified'}
- Content to avoid: ${analysis.preferences.dealbreakers.length > 0 ? analysis.preferences.dealbreakers.join(', ') : 'none specified'}`;

  const prompt = `You are a book recommendation assistant. Based on the user's detailed preferences and available novels, recommend the SINGLE BEST novel that matches ALL their criteria.

User's preferences:
${preferencesText}

Available novels:
${booksData}

IMPORTANT: Choose a book that matches their pacing preference (${analysis.preferences.pacing || 'any'}), ending preference (${analysis.preferences.ending || 'any'}), and complexity level (${analysis.preferences.complexity || 'any'}). Avoid books with: ${analysis.preferences.dealbreakers.join(', ') || 'none'}.

Respond ONLY with a JSON object (no markdown, no backticks):
{
  "title": "novel title",
  "author": "author name",
  "description": "novel description",
  "reasoning": "2-3 sentences explaining why this novel perfectly matches their ${analysis.genre} genre, ${analysis.mood} mood, ${analysis.topic} theme, and their preferences for pacing, ending, and complexity",
  "pageCount": page_count_number_or_null,
  "publishedDate": "publication date or null",
  "rating": rating_number_or_null
}`;

  try {
    const response = await axios.post(url, {
      contents: [{
        parts: [{ text: prompt }]
      }]
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    const generatedText = response.data.candidates[0].content.parts[0].text.trim();
    const cleanText = generatedText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(cleanText);
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

    console.log('💬 Received message:', message);

    // Build conversation context
    const history = conversationHistory || [];
    const fullConversation = [
      ...history.map(msg => `${msg.isUser ? 'User' : 'Assistant'}: ${msg.text}`),
      `User: ${message}`
    ].join('\n');

    // Step 1: Analyze conversation
    console.log('🔍 Analyzing conversation...');
    const analysis = await analyzeConversation(fullConversation);
    
    console.log('📊 Analysis result:', {
      hasBasicInfo: analysis.hasBasicInfo,
      needsInvestigation: analysis.needsInvestigation,
      readyToRecommend: analysis.readyToRecommend,
      genre: analysis.genre,
      mood: analysis.mood,
      topic: analysis.topic,
      preferences: analysis.preferences
    });

    // Step 2: Check if ready to recommend
    if (!analysis.readyToRecommend) {
      console.log('❓ Asking question:', analysis.question);
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

    // Step 3: Search for books
    console.log('📚 Searching for books with query:', analysis.searchQuery);
    const allBooks = await searchGoogleBooks(analysis.searchQuery);
    const books = filterNovelsOnly(allBooks);

    if (books.length === 0) {
      return res.json({
        type: 'question',
        message: `I couldn't find any ${analysis.genre || ''} novels matching your preferences. Could you try adjusting your criteria or choosing a different genre?`,
        analysis: {
          genre: analysis.genre,
          mood: analysis.mood,
          topic: analysis.topic,
          preferences: analysis.preferences
        }
      });
    }

    console.log(`✅ Found ${books.length} novels`);

    // Step 4: Get recommendation
    const booksData = formatBooksForGemini(books);
    console.log('🤖 Getting personalized recommendation...');
    const recommendation = await getGeminiRecommendation(analysis, booksData);

    // Step 5: Add book metadata
    const recommendedBook = books.find(book =>
      book.volumeInfo.title.toLowerCase().includes(recommendation.title.toLowerCase())
    );

    if (recommendedBook) {
      recommendation.imageUrl = recommendedBook.volumeInfo.imageLinks?.thumbnail;
      recommendation.previewLink = recommendedBook.volumeInfo.previewLink;
      
      if (!recommendation.pageCount) {
        recommendation.pageCount = recommendedBook.volumeInfo.pageCount;
      }
      if (!recommendation.publishedDate) {
        recommendation.publishedDate = recommendedBook.volumeInfo.publishedDate;
      }
      if (!recommendation.rating) {
        recommendation.rating = recommendedBook.volumeInfo.averageRating;
      }
    }

    console.log('✨ Recommendation sent');
    res.json({
      type: 'recommendation',
      recommendation: recommendation,
      analysis: {
        genre: analysis.genre,
        mood: analysis.mood,
        topic: analysis.topic,
        preferences: analysis.preferences
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      error: 'An error occurred while processing your request',
      details: error.message
    });
  }
});

// ========================================
// HEALTH CHECK
// ========================================
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Investigative chatbot backend running - asks clarifying questions',
    timestamp: new Date().toISOString()
  });
});

// ========================================
// START SERVER
// ========================================
app.listen(port, () => {
  console.log('🚀 Server running on port', port);
  console.log('🔍 Investigative mode: Asks clarifying questions for better recommendations');
  console.log('📖 Specializing in novel recommendations');
  console.log('✨ Ready to investigate!\n');
});