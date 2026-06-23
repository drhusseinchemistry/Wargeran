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
      const finalApiKey = apiKey || process.env.GEMINI_API_KEY || 'AIzaSyAon_g8qGdICSReM3v01-HaLTF7CYDwW7k';

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
      let lastError: any = null;
      let usedFallbackKey = false;

      // Inner helper function to try all models with retries
      async function attemptTranslation(clientInstance: GoogleGenAI) {
        let resp = null;
        const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash'];
        
        for (const modelName of modelsToTry) {
          let retries = 3;
          let delay = 1000;
          let modelSuccess = false;

          while (retries > 0) {
            try {
              resp = await clientInstance.models.generateContent({
                model: modelName,
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
              modelSuccess = true;
              break; // success
            } catch (apiError: any) {
              lastError = apiError;
              // If it's a permission/not found error, don't retry this model, jump to the next one
              const errMsg = (apiError?.message || "").toLowerCase();
              const isPermissionOrNotFound = errMsg.includes('permission') || 
                                             apiError?.status === 403 || 
                                             apiError?.status === 404 ||
                                             errMsg.includes('not found') ||
                                             errMsg.includes('permission denied') ||
                                             errMsg.includes('not have permission');
              if (isPermissionOrNotFound) {
                console.warn(`Model ${modelName} returned permission/not-found error. Trying next model...`);
                break;
              }

              retries--;
              console.error(`Gemini API call failed for model ${modelName}. Retries remaining: ${retries}`, apiError);
              if (retries === 0) {
                break; // Try next model
              }
              // wait before retrying (exponential backoff)
              await new Promise(resolve => setTimeout(resolve, delay));
              delay *= 2;
            }
          }

          if (modelSuccess && resp) {
            return resp;
          }
        }
        return null;
      }

      // First attempt with the selected API Key (which can be user-supplied or default)
      response = await attemptTranslation(ai);

      // If it failed and we have a server-side backup key that is different, try the backup key!
      if (!response && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== finalApiKey) {
        console.warn("User-supplied API Key failed or had permission issues. Falling back to server-side GEMINI_API_KEY...");
        try {
          const fallbackAi = new GoogleGenAI({
            apiKey: process.env.GEMINI_API_KEY,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              }
            }
          });
          response = await attemptTranslation(fallbackAi);
          if (response) {
            usedFallbackKey = true;
            console.log("Successfully translated using server-side GEMINI_API_KEY fallback!");
          }
        } catch (fallbackErr) {
          console.error("Server-side backup key translation attempt also failed:", fallbackErr);
        }
      }

      if (!response) {
        throw new Error(`سیستەمێ وەرگێرانێ چ بەرسڤ نەدا. خەتا: ${lastError?.message || 'دەستپێگەیشتن ڕەتکرایەوە یان مۆدێل چالاک نییە'}`);
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
