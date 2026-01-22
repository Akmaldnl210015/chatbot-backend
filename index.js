const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========================================
// FUNCTION 1: Search Google Books (NOVELS ONLY)
// ========================================
async function searchGoogleBooks(query) {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  
  // Add subject:fiction to only get novels
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
// FUNCTION 2: Filter to Keep Only Novels
// ========================================
function filterNovelsOnly(books) {
  return books.filter(book => {
    const info = book.volumeInfo;
    const categories = info.categories || [];
    const categoriesString = categories.join(' ').toLowerCase();
    const description = (info.description || '').toLowerCase();
    
    // Fiction indicators
    const fictionKeywords = [
      'fiction', 'novel', 'romance', 'mystery', 'thriller',
      'fantasy', 'science fiction', 'horror', 'adventure',
      'literary fiction', 'contemporary fiction', 'historical fiction',
      'young adult', 'dystopian', 'crime fiction'
    ];
    
    // Non-fiction indicators (to exclude)
    const nonFictionKeywords = [
      'non-fiction', 'nonfiction', 'biography', 'autobiography',
      'memoir', 'history', 'self-help', 'textbook', 'reference',
      'educational', 'cookbook', 'guide', 'manual', 'how to',
      'business', 'philosophy', 'psychology', 'science', 'religion'
    ];
    
    const hasFiction = fictionKeywords.some(keyword => 
      categoriesString.includes(keyword) || description.includes(keyword)
    );
    
    const hasNonFiction = nonFictionKeywords.some(keyword => 
      categoriesString.includes(keyword)
    );
    
    // Keep if it's fiction and not non-fiction
    return hasFiction && !hasNonFiction;
  });
}

// ========================================
// FUNCTION 3: Format Books for Gemini
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
// FUNCTION 4: Call Gemini API
// ========================================
async function getGeminiRecommendation(query, booksData) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const prompt = `You are a book recommendation assistant specializing in NOVELS (fiction books). Based on the user's request and the following novels from Google Books, recommend the SINGLE BEST NOVEL that matches their request.

CRITICAL RULES:
- ONLY recommend novels/fiction books
- DO NOT recommend non-fiction, biographies, memoirs, self-help, or textbooks
- Focus on storytelling, plot, and fictional narratives

User's request: "${query}"

Available novels:
${booksData}

Respond ONLY with a JSON object in this exact format (no markdown, no backticks, no additional text):
{
  "title": "novel title",
  "author": "author name",
  "description": "novel description",
  "reasoning": "2-3 sentences explaining why this NOVEL perfectly matches the user's request for fiction",
  "pageCount": page_count_number_or_null,
  "publishedDate": "publication date or null",
  "rating": rating_number_or_null
}`;

  try {
    const response = await axios.post(url, {
      contents: [{
        parts: [{
          text: prompt
        }]
      }]
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const generatedText = response.data.candidates[0].content.parts[0].text;
    return generatedText;
  } catch (error) {
    console.error('Gemini API error:', error.response?.data || error.message);
    throw new Error('Failed to get recommendation from Gemini');
  }
}

// ========================================
// MAIN ENDPOINT: /api/recommend
// ========================================
app.post('/api/recommend', async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    console.log('📚 Received query:', query);

    // Step 1: Search Google Books for fiction
    console.log('🔍 Searching for novels in Google Books...');
    const allBooks = await searchGoogleBooks(query);
    
    // Step 2: Filter to keep only novels
    const books = filterNovelsOnly(allBooks);
    
    if (books.length === 0) {
      return res.status(404).json({ 
        error: 'No novels found for your query. Try different keywords like "romance", "mystery", or "fantasy".' 
      });
    }
    console.log(`✅ Found ${books.length} novels after filtering`);

    // Step 3: Format books data
    const booksData = formatBooksForGemini(books);

    // Step 4: Ask Gemini to recommend
    console.log('🤖 Requesting novel recommendation from Gemini...');
    const geminiResponse = await getGeminiRecommendation(query, booksData);

    // Step 5: Parse Gemini's response
    let responseText = geminiResponse.trim();
    let recommendation;
    
    try {
      responseText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      recommendation = JSON.parse(responseText);
      console.log('✅ Successfully parsed Gemini response');
    } catch (e) {
      console.error('❌ Failed to parse Gemini response:', responseText);
      throw new Error('Invalid response format from AI');
    }

    // Step 6: Find the recommended book to get image & additional info
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

    console.log('✨ Novel recommendation sent successfully');
    res.json(recommendation);

  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({ 
      error: 'An error occurred while processing your request',
      details: error.message 
    });
  }
});

// ========================================
// HEALTH CHECK ENDPOINT
// ========================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Backend is running - Recommending NOVELS ONLY',
    timestamp: new Date().toISOString()
  });
});

// ========================================
// START SERVER
// ========================================
app.listen(port, () => {
  console.log('🚀 Server running on port', port);
  console.log('📖 Specializing in NOVEL recommendations (fiction only)');
  console.log('🤖 Using Gemini 1.5 Flash for AI recommendations');
  console.log('✨ Ready to recommend novels!');
  console.log(`\n💡 Test: curl -X POST http://localhost:${port}/api/recommend -H "Content-Type: application/json" -d '{"query":"mystery novel"}'\n`);
});