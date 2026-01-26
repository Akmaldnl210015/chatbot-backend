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
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `You are a sophisticated book recommendation assistant. Analyze the conversation to decide the next step.

STEP 1 - Check for BASIC INFO (must have all 3 to proceed):
- GENRE: romance, mystery, fantasy, thriller, sci-fi, horror, literary fiction, etc.
- MOOD: sad, happy, dark, uplifting, emotional, suspenseful, cozy, etc.
- TOPIC/THEME: relationships, coming of age, war, family, adventure, grief, betrayal, etc.

STEP 2 - Investigation priorities (ask ONE question at a time, in this exact order):
1. If missing any basic info → ask for the missing piece(s) first
2. PUBLICATION PREFERENCE (highest priority after basics - ALWAYS ask if not specified):
   - Ask: "Are you looking for recent books (2020+), older classics (pre-2010), or popular books that are widely loved (anytime)?"
   - User answers map to: "recent", "classic", "popular"
3. DEALBREAKERS (content warnings to avoid)
4. COMPLEXITY (light/easy vs literary/thought-provoking)

WHEN TO RECOMMEND (readyToRecommend = true):
- All 3 basic pieces present AND publication preference is clear
- User gave very specific request from the start (e.g. "2023 romance", "classic mystery")
- User answered the publication question

Conversation history:
${conversationHistory}

Respond with ONLY this exact JSON structure (no markdown, no backticks):
{
  "hasBasicInfo": true/false,
  "genre": "identified genre or null",
  "mood": "identified mood or null", 
  "topic": "identified topic or null",
  "needsInvestigation": true/false,
  "investigationCategory": "publication/dealbreakers/complexity or null",
  "investigationQuestion": "natural question or null",
  "preferences": {
    "publication": "recent/classic/popular/any/null",
    "complexity": "easy/literary/null",
    "dealbreakers": ["array of avoided topics or empty array"]
  },
  "readyToRecommend": true/false,
  "missingBasicInfo": ["array of missing: genre/mood/topic or empty"],
  "question": "the question to ask or null",
  "searchQuery": "optimized Google Books query or null (MUST include date filter for publication)"
}

EXAMPLES:

Example 1 - Missing basics:
{
  "hasBasicInfo": false,
  "genre": null, "mood": null, "topic": null,
  "needsInvestigation": false, "investigationCategory": null, "investigationQuestion": null,
  "preferences": {"publication": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": false,
  "missingBasicInfo": ["genre", "mood", "topic"],
  "question": "What kind of book are you in the mood for? For example, romance, fantasy, thriller, mystery, or something else?",
  "searchQuery": null
}

Example 2 - Has basics, ask publication (MOST COMMON):
User: "sad romance about heartbreak"
{
  "hasBasicInfo": true,
  "genre": "romance", "mood": "sad", "topic": "heartbreak",
  "needsInvestigation": true,
  "investigationCategory": "publication",
  "investigationQuestion": "Are you looking for recent books (2020+), older classics (pre-2010), or popular books that are widely loved (anytime)?",
  "preferences": {"publication": null, "complexity": null, "dealbreakers": []},
  "readyToRecommend": false,
  "missingBasicInfo": [],
  "question": "Are you looking for recent books (2020+), older classics (pre-2010), or popular books that are widely loved (anytime)?",
  "searchQuery": null
}

Example 3 - Ready after publication answer:
User then says: "recent please"
{
  "hasBasicInfo": true,
  "genre": "romance", "mood": "sad", "topic": "heartbreak",
  "needsInvestigation": false, "investigationCategory": null, "investigationQuestion": null,
  "preferences": {"publication": "recent", "complexity": null, "dealbreakers": []},
  "readyToRecommend": true,
  "missingBasicInfo": [],
  "question": null,
  "searchQuery": "sad romance heartbreak emotional 2020..2026 subject:fiction"
}

Example 4 - Specific from start:
User: "2023 BookTok romance slow burn"
{
  "hasBasicInfo": true,
  "genre": "romance", "mood": null, "topic": "slow burn",
  "needsInvestigation": false,
  "preferences": {"publication": "recent", "complexity": null, "dealbreakers": []},
  "readyToRecommend": true,
  "searchQuery": "romance slow burn 2020..2026 subject:fiction"
}`;

  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }]
    }, { headers: { 'Content-Type': 'application/json' } });

    let generatedText = response.data.candidates[0].content.parts[0].text.trim();
    generatedText = generatedText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(generatedText);
  } catch (error) {
    console.error('Gemini analysis error:', error.response?.data || error.message);
    throw new Error('Failed to analyze conversation');
  }
}

// ========================================
// FUNCTION: Search Google Books (with publication filters)
// ========================================
async function searchGoogleBooks(query, publication) {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  
  // Build date filter based on publication preference
  let dateFilter = '';
  if (publication === 'recent') {
    dateFilter = `+intitle:2020..2026`;  // Recent books (Google Books format)
  } else if (publication === 'classic') {
    dateFilter = `+inauthor:before:2010`;  // Older classics
  } else if (publication === 'popular') {
    // Popular gets more results + relevance sorting
  }
  
  const searchQuery = `${query} ${dateFilter} subject:fiction`.trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=25&orderBy=relevance${apiKey ? '&key=' + apiKey : ''}`;
  
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
    const categories = (info.categories || []).join(' ').toLowerCase();
    
    const fictionKeywords = ['fiction', 'novel', 'romance', 'mystery', 'thriller', 'fantasy', 'science fiction', 'horror'];
    const nonFictionKeywords = ['non-fiction', 'biography', 'self-help', 'textbook', 'history', 'guide'];
    
    const hasFiction = fictionKeywords.some(k => categories.includes(k));
    const hasNonFiction = nonFictionKeywords.some(k => categories.includes(k));
    
    // Extra boost for popular books (higher ratings, more reviews)
    const isPopular = (info.averageRating || 0) >= 4.0 || (info.ratingsCount || 0) > 1000;
    
    return (hasFiction && !hasNonFiction) || isPopular;
  });
}

// ========================================
// FUNCTION: Format Books for Gemini
// ========================================
function formatBooksForGemini(books) {
  return books.slice(0, 15).map((book, index) => {  // Top 15 for better quality
    const info = book.volumeInfo;
    return `Book ${index + 1}:
Title: ${info.title || 'Unknown'}
Author(s): ${info.authors?.join(', ') || 'Unknown'}
Avg Rating: ${info.averageRating ? `${info.averageRating}/5 (${info.ratingsCount || 0} reviews)` : 'Not rated'}
Published: ${info.publishedDate || 'Unknown'}
Description: ${info.description?.substring(0, 600) || 'No description'}
Categories: ${info.categories?.join(', ') || 'Fiction'}`;
  }).join('\n\n---\n\n');
}

// ========================================
// FUNCTION: Get Book Recommendation
// ========================================
async function getGeminiRecommendation(analysis, booksData) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const pubText = analysis.preferences.publication === 'recent' ? 'recent (2020+)' : 
                  analysis.preferences.publication === 'classic' ? 'older classics (pre-2010)' : 
                  analysis.preferences.publication === 'popular' ? 'popular/highly rated (any era)' : 'any era';
  
  const preferencesText = `
Genre: ${analysis.genre || 'any'}
Mood: ${analysis.mood || 'any'}
Topic: ${analysis.topic || 'any'}
Publication: ${pubText}
Complexity: ${analysis.preferences.complexity || 'any'}
Avoid: ${analysis.preferences.dealbreakers.length ? analysis.preferences.dealbreakers.join(', ') : 'none'}`;

  const prompt = `Pick the SINGLE BEST novel matching these preferences from the list:

PREFERENCES:
${preferencesText}

BOOKS:
${booksData}

RULES:
1. MUST match publication preference (recent=2020+, classic=pre-2010, popular=4+ stars/high reviews)
2. Avoid all dealbreakers completely
3. Match genre/mood/topic as closely as possible
4. For popular: prioritize 4.0+ rating OR 1000+ reviews

Return ONLY JSON:
{
  "title": "exact title",
  "author": "author(s)",
  "description": "1-2 sentence summary",
  "reasoning": "3 sentences: why genre/mood/topic match + why publication fits + why best overall",
  "pageCount": number_or_null,
  "publishedDate": "year or full date or null",
  "rating": number_or_null
}`;

  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }]
    }, { headers: { 'Content-Type': 'application/json' } });

    let text = response.data.candidates[0].content.parts[0].text.trim();
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(text);
  } catch (error) {
    console.error('Gemini rec error:', error.response?.data || error.message);
    throw new Error('Failed to get recommendation');
  }
}

// ========================================
// MAIN ENDPOINT: /api/chat
// ========================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    console.log('💬', message);

    const history = conversationHistory || [];
    const fullConversation = [
      ...history.map(msg => `${msg.isUser ? 'User' : 'Assistant'}: ${msg.text}`),
      `User: ${message}`
    ].join('\n');

    // Step 1: Analyze
    const analysis = await analyzeConversation(fullConversation);
    console.log('📊', { 
      ready: analysis.readyToRecommend, 
      genre: analysis.genre, 
      pub: analysis.preferences.publication 
    });

    // Not ready? Ask question
    if (!analysis.readyToRecommend) {
      return res.json({
        type: 'question',
        message: analysis.question,
        analysis: {
          hasBasicInfo: analysis.hasBasicInfo,
          genre: analysis.genre,
          mood: analysis.mood,
          topic: analysis.topic,
          preferences: analysis.preferences,
          missingBasicInfo: analysis.missingBasicInfo
        }
      });
    }

    // Step 2: Search with publication filter
    console.log('📚 Searching:', analysis.searchQuery, analysis.preferences.publication);
    const allBooks = await searchGoogleBooks(analysis.searchQuery, analysis.preferences.publication);
    const novels = filterNovelsOnly(allBooks);

    if (novels.length === 0) {
      return res.json({
        type: 'question',
        message: `No ${analysis.preferences.publication} ${analysis.genre} books found for "${analysis.topic}". Try "popular" books instead, or different genre/mood?`,
        analysis
      });
    }

    console.log(`✅ ${novels.length} novels found`);

    // Step 3: Get best pick
    const booksText = formatBooksForGemini(novels);
    const recommendation = await getGeminiRecommendation(analysis, booksText);

    // Step 4: Enrich with images/links (better image priority)
    const bestMatch = novels.find(b => 
      b.volumeInfo.title.toLowerCase().includes(recommendation.title.toLowerCase())
    );

    if (bestMatch?.volumeInfo) {
      const links = bestMatch.volumeInfo.imageLinks || {};
      recommendation.imageUrl = 
        links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail;
      
      if (recommendation.imageUrl) {
        recommendation.imageUrl = recommendation.imageUrl.replace('http://', 'https://');
      }
      
      recommendation.previewLink = bestMatch.volumeInfo.previewLink;
      recommendation.buyLink = bestMatch.saleInfo?.buyLink;
      
      // Fill missing fields
      recommendation.pageCount ??= bestMatch.volumeInfo.pageCount;
      recommendation.publishedDate ??= bestMatch.volumeInfo.publishedDate;
      recommendation.rating ??= bestMatch.volumeInfo.averageRating;
    }

    res.json({
      type: 'recommendation',
      recommendation,
      analysis: {
        genre: analysis.genre,
        mood: analysis.mood,
        topic: analysis.topic,
        publication: analysis.preferences.publication
      }
    });

  } catch (error) {
    console.error('❌', error);
    res.status(500).json({ error: 'Server error. Try again?' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'OK', message: 'Readive backend v2 - Publication filtering fixed' }));

app.listen(port, () => {
  console.log(`🚀 Readive backend on port ${port}`);
  console.log('✅ Fixed: Direct publication question (recent/classic/popular)');
});