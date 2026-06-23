import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  app.post('/api/translate', async (req, res) => {
    try {
      const { texts, targetLanguage, apiKey } = req.body;
      const finalApiKey = apiKey || process.env.GEMINI_API_KEY;

      if (!finalApiKey) {
        return res.status(400).json({ error: 'کلیلا API نەهاتیە دیتن (API Key missing)' });
      }

      if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return res.json({ translatedTexts: [] });
      }

      const ai = new GoogleGenAI({
        apiKey: finalApiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const prompt = `Translate the following array of subtitle texts into ${targetLanguage}.
If the target language is Badini or Sorani Kurdish, YOU MUST USE THE ARABIC/KURDISH ALPHABET (پ ی ت ج چ ...), NOT Latin letters.
You MUST maintain the exact same number of items in the array (exactly ${texts.length} items).
Do not translate the formatting, only the meaning. Keep any HTML-like tags (e.g., <i>, <b>) intact.
Only return the JSON array of translated strings.

Texts:
${JSON.stringify(texts)}`;

      let response;
      let retries = 3;
      let delay = 1000;

      while (retries > 0) {
        try {
          response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.STRING
                }
              }
            }
          });
          break; // success
        } catch (apiError: any) {
          retries--;
          console.error(`Gemini API call failed. Retries remaining: ${retries}`, apiError);
          if (retries === 0) {
            throw apiError;
          }
          // wait before retrying (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        }
      }

      if (!response) {
        throw new Error('سیستەمێ وەرگێرانێ چ بەرسڤ نەدا');
      }

      let translatedTexts = [];
      try {
        translatedTexts = JSON.parse(response.text || '[]');
      } catch (e) {
        // Fallback: If not pure JSON for some reason, maybe it's wrapped in a markdown block
        const match = response.text?.match(/\[[\s\S]*\]/);
        if (match) {
            translatedTexts = JSON.parse(match[0]);
        } else {
            throw new Error("Could not parse JSON response from AI.");
        }
      }

      // Simple alignment if the length mismatches
      if (translatedTexts.length !== texts.length) {
          console.warn(`Warning: Expected ${texts.length} translations, got ${translatedTexts.length}. Attempting to align...`);
          while(translatedTexts.length < texts.length) {
              translatedTexts.push('');
          }
          if (translatedTexts.length > texts.length) {
              translatedTexts = translatedTexts.slice(0, texts.length);
          }
      }

      res.json({ translatedTexts });
    } catch (error: any) {
      console.error('Translation error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
