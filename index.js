const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// FUNCTION: Analyze Conversation
// ========================================
async function analyzeConversation(conversationHistory) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `You are a book recommendation assistant. Analyze the conversation.

STEP 1 - BASIC INFO (must have all 3):
- GENRE
- MOOD
- TOPIC/THEME

STEP 2 - Investigation order:
1. Missing basics → ask for them
2. Publication preference → ask: "Recent books (2020+), older classics (pre-2010), or popular books that are widely loved (anytime)?"
3. DEALBREAKERS
4. COMPLEXITY (easy/light vs literary/deep)

WHEN TO RECOMMEND:
- Basics present + publication preference known
- Very specific request from start

Respond ONLY with this JSON (no extra text):
{
  "hasBasicInfo": boolean,
  "genre": string|null,
  "mood": string|null,
  "topic": string|null,
  "needsInvestigation": boolean,
  "investigationCategory": "publication|dealbreakers|complexity|null",
  "investigationQuestion": string|null,
  "preferences": {
    "publication": "recent|classic|popular|any|null",
    "complexity": "easy|literary|null",
    "dealbreakers": string[]
  },
  "readyToRecommend": boolean,
  "missingBasicInfo": string[],
  "question": string|null,
  "searchQuery": string|null
}

Conversation:
${conversationHistory}`;

  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }]
    }, { headers: { 'Content-Type': 'application/json' } });

    let text = response.data.candidates[0].content.parts[0].text.trim();
    text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    return JSON.parse(text);
  } catch (error) {
    console.error('Gemini analyze error:', error?.response?.data || error.message);
    throw error;
  }
}

// ========================================
// Search Google Books
// ========================================
async function searchGoogleBooks(query, publication) {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  
  let dateFilter = '';
  if (publication === 'recent') dateFilter = '2020..2026';
  else if (publication === 'classic') dateFilter = 'before:2010';

  const fullQuery = `${query} ${dateFilter ? `+${dateFilter}` : ''} subject:fiction`.trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(fullQuery)}&maxResults=25&orderBy=relevance${apiKey ? '&key=' + apiKey : ''}`;

  const response = await axios.get(url);
  return response.data.items || [];
}

// ========================================
// Filter fiction/novels + popular boost
// ========================================
function filterNovelsOnly(books) {
  return books.filter(book => {
    const cats = (book.volumeInfo?.categories || []).join(' ').toLowerCase();
    const isFiction = ['fiction', 'novel', 'romance', 'fantasy', 'mystery', 'thriller'].some(k => cats.includes(k));
    const isNonFiction = ['non-fiction', 'biography', 'self-help'].some(k => cats.includes(k));
    const isPopular = (book.volumeInfo?.averageRating || 0) >= 4 || (book.volumeInfo?.ratingsCount || 0) > 800;
    return (isFiction && !isNonFiction) || isPopular;
  });
}

// ========================================
// Format books for Gemini
// ========================================
function formatBooksForGemini(books) {
  return books.slice(0, 15).map((b, i) => {
    const info = b.volumeInfo;
    return `Book ${i+1}:
Title: ${info.title || '?'}
Author: ${info.authors?.join(', ') || '?'}
Rating: ${info.averageRating ? `${info.averageRating} (${info.ratingsCount || 0})` : '?'}
Published: ${info.publishedDate || '?'}
Description: ${info.description?.substring(0, 550) || 'No desc'}`;
  }).join('\n\n---\n\n');
}

// ========================================
// Get single best recommendation
// ========================================
async function getGeminiRecommendation(analysis, booksText, excludedTitle = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  const pubText = analysis.preferences.publication === 'recent' ? 'recent (2020+)' :
                  analysis.preferences.publication === 'classic' ? 'classic (pre-2010)' :
                  'popular / any era';

  const prompt = `Pick the SINGLE BEST matching book.
Preferences:
- Genre: ${analysis.genre || 'any'}
- Mood: ${analysis.mood || 'any'}
- Topic: ${analysis.topic || 'any'}
- Publication: ${pubText}
- Complexity: ${analysis.preferences.complexity || 'any'}
- Avoid: ${analysis.preferences.dealbreakers?.join(', ') || 'none'}

${excludedTitle ? `IMPORTANT: Do NOT recommend "${excludedTitle}" again.` : ''}

Books:
${booksText}

Return ONLY JSON:
{
  "title": string,
  "author": string,
  "description": string,
  "reasoning": string,
  "pageCount": number|null,
  "publishedDate": string|null,
  "rating": number|null
}`;

  const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] }, {
    headers: { 'Content-Type': 'application/json' }
  });

  let text = res.data.candidates[0].content.parts[0].text.trim();
  text = text.replace(/```json|```/g, '').trim();
  return JSON.parse(text);
}

// ========================================
// MAIN ENDPOINT
// ========================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory = [] } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const lower = message.toLowerCase().trim();

    // ── Handle "another one" / "next" / "something else" ─────────────
    const wantsAnother = [
      'another', 'one more', 'next', 'different one', 'something else',
      'not this', 'not feeling it', 'another suggestion', 'more options',
      'try another', 'give me another'
    ].some(w => lower.includes(w)) || lower === 'more';

    if (wantsAnother && conversationHistory.length > 0) {
      // Find last recommendation sent by bot
      const lastBotMsg = [...conversationHistory].reverse().find(m => !m.isUser && m.type === 'recommendation');

      if (lastBotMsg?.recommendation && lastBotMsg.analysis) {
        const prevAnalysis = lastBotMsg.analysis;
        const excludedTitle = lastBotMsg.recommendation.title;

        console.log(`↪ Another request - excluding: ${excludedTitle}`);

        const books = await searchGoogleBooks(
          prevAnalysis.searchQuery || 'fiction',
          prevAnalysis.preferences?.publication
        );

        let novels = filterNovelsOnly(books);

        // Exclude previous recommendation
        if (excludedTitle) {
          novels = novels.filter(b => 
            !b.volumeInfo?.title?.toLowerCase().includes(excludedTitle.toLowerCase())
          );
        }

        if (novels.length === 0) {
          return res.json({
            type: 'message',
            message: "I've run out of strong alternatives that match what you asked for earlier. Would you like to change the genre, mood, time period, or add more details?"
          });
        }

        const booksText = formatBooksForGemini(novels);
        const newRec = await getGeminiRecommendation(prevAnalysis, booksText, excludedTitle);

        // Enrich with image & links
        const match = novels.find(b => 
          b.volumeInfo?.title?.toLowerCase().includes(newRec.title.toLowerCase())
        );

        if (match?.volumeInfo) {
          const links = match.volumeInfo.imageLinks || {};
          newRec.imageUrl = links.extraLarge || links.large || links.medium || links.thumbnail;
          if (newRec.imageUrl) newRec.imageUrl = newRec.imageUrl.replace('http://', 'https://');
          newRec.previewLink = match.volumeInfo.previewLink;
          newRec.pageCount ??= match.volumeInfo.pageCount;
          newRec.publishedDate ??= match.volumeInfo.publishedDate;
          newRec.rating ??= match.volumeInfo.averageRating;
        }

        return res.json({
          type: 'recommendation',
          recommendation: newRec,
          analysis: prevAnalysis
        });
      }
    }

    // ── Normal flow ──────────────────────────────────────────────────
    const fullConv = [
      ...conversationHistory.map(m => `${m.isUser ? 'User' : 'Assistant'}: ${m.text}`),
      `User: ${message}`
    ].join('\n');

    const analysis = await analyzeConversation(fullConv);

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

    const books = await searchGoogleBooks(analysis.searchQuery, analysis.preferences.publication);
    const novels = filterNovelsOnly(books);

    if (novels.length === 0) {
      return res.json({
        type: 'message',
        message: `Couldn't find matching ${analysis.preferences.publication || ''} books for "${analysis.searchQuery}". Want to try a different time period or mood?`
      });
    }

    const booksText = formatBooksForGemini(novels);
    const recommendation = await getGeminiRecommendation(analysis, booksText);

    const bestMatch = novels.find(b => 
      b.volumeInfo?.title?.toLowerCase().includes(recommendation.title.toLowerCase())
    );

    if (bestMatch?.volumeInfo) {
      const links = bestMatch.volumeInfo.imageLinks || {};
      recommendation.imageUrl = links.extraLarge || links.large || links.medium || links.thumbnail;
      if (recommendation.imageUrl) recommendation.imageUrl = recommendation.imageUrl.replace('http://', 'https://');
      recommendation.previewLink = bestMatch.volumeInfo.previewLink;
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
        preferences: analysis.preferences
      }
    });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong — try again?' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Book recommendation backend - supports "another" requests' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});