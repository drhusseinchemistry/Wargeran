import React, { useState, useRef, useEffect } from 'react';
import { Upload, Languages, Download, Play, CheckCircle2, AlertCircle, FileText, KeyRound, Copy, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { SRTBlock, TranslationLanguage, LANGUAGES } from './types';
import { parseSRT, stringifySRT, chunkArray } from './utils';

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [blocks, setBlocks] = useState<SRTBlock[]>([]);
  const [language, setLanguage] = useState<TranslationLanguage>('کوردی - بادینی (Kurdish Badini - Arabic Script)');
  
  const [apiKey, setApiKey] = useState(() => {
    const saved = localStorage.getItem('geminiApiKey');
    if (saved && saved.trim() !== '') {
      return saved;
    }
    return 'AIzaSyAon_g8qGdICSReM3v01-HaLTF7CYDwW7k';
  });
  const [isKeySaved, setIsKeySaved] = useState(false);

  const [isTranslating, setIsTranslating] = useState(false);
  const [translatingStatus, setTranslatingStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [chunkStatuses, setChunkStatuses] = useState<{ [key: number]: 'idle' | 'translating' | 'completed' | 'failed' }>({});
  const [chunkErrors, setChunkErrors] = useState<{ [key: number]: string }>({});

  const [activeTab, setActiveTab] = useState<'auto' | 'manual'>('auto');
  const [manualFormat, setManualFormat] = useState<'line' | 'separator'>('line');
  const [manualDelimiter, setManualDelimiter] = useState('|||');
  const [manualPasteText, setManualPasteText] = useState('');
  const [manualSuccessMsg, setManualSuccessMsg] = useState<string | null>(null);
  const [copiedEffect, setCopiedEffect] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const CHUNK_SIZE = 80;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        const parsed = parseSRT(content);
        setBlocks(parsed);
        setError(null);
        setProgress(0);
        setTranslatingStatus(null);

        // Initialize statuses
        const numChunks = Math.ceil(parsed.length / CHUNK_SIZE);
        const initialStatuses: { [key: number]: 'idle' | 'translating' | 'completed' | 'failed' } = {};
        for (let i = 0; i < numChunks; i++) {
          const chunk = parsed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
          const allTranslated = chunk.every(b => b.translatedText && b.translatedText.trim() !== "");
          if (allTranslated) {
            initialStatuses[i] = 'completed';
          } else {
            initialStatuses[i] = 'idle';
          }
        }
        setChunkStatuses(initialStatuses);
        setChunkErrors({});
      }
    };
    reader.readAsText(uploadedFile);
  };

  const handleSaveKey = () => {
    localStorage.setItem('geminiApiKey', apiKey);
    setIsKeySaved(true);
    setTimeout(() => setIsKeySaved(false), 2000);
  };

  const scrollToBlock = (blockId: string) => {
    const element = document.getElementById(`cue-row-${blockId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.classList.add('bg-indigo-50/80', 'ring-2', 'ring-indigo-500');
      setTimeout(() => {
        element.classList.remove('bg-indigo-50/80', 'ring-2', 'ring-indigo-500');
      }, 2000);
    }
  };

  const performChunkTranslationWithRetry = async (textsToTranslate: string[], chunkLabel: string): Promise<string[]> => {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
      try {
        let translatedTexts: string[] = [];
        let callSucceeded = false;

        // 1. First, always try Express backend
        try {
          const response = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              texts: textsToTranslate,
              targetLanguage: language,
              apiKey: apiKey
            })
          });

          if (response.ok) {
            const data = await response.json();
            if (data.translatedTexts && Array.isArray(data.translatedTexts)) {
              translatedTexts = data.translatedTexts;
              callSucceeded = true;
            }
          } else {
            let serverErrorMsg = "Server error";
            try {
              const errData = await response.json();
              serverErrorMsg = errData?.error || response.statusText;
            } catch (_) {}
            console.warn("Backend translation failed:", serverErrorMsg);
            
            const isQuota = serverErrorMsg.toLowerCase().includes("quota") || serverErrorMsg.toLowerCase().includes("429") || serverErrorMsg.toLowerCase().includes("limit") || serverErrorMsg.toLowerCase().includes("rate");
            if (isQuota) {
              throw new Error(`QUOTA_LIMIT: ${serverErrorMsg}`);
            }

            if (!apiKey || apiKey.trim() === "") {
              throw new Error(serverErrorMsg);
            }
          }
        } catch (serverErr: any) {
          console.warn("Server-side call failed:", serverErr);
          if (serverErr.message?.startsWith("QUOTA_LIMIT")) {
            throw serverErr;
          }
          if (!apiKey || apiKey.trim() === "") {
            throw new Error(serverErr.message || "پەیوەندی دگەل سێرڤەری سەرنەکەفت");
          }
        }

        // 2. Direct client-side if needed
        if (!callSucceeded && apiKey && apiKey.trim() !== "") {
          try {
            const prompt = `Translate the following array of subtitle texts into ${language}.
If the target language is Badini or Sorani Kurdish, YOU MUST USE THE ARABIC/KURDISH ALPHABET (پ ی ت ج چ ...), NOT Latin letters.
You MUST maintain the exact same number of items in the array (exactly ${textsToTranslate.length} items).
Do not translate the formatting, only the meaning. Keep any HTML-like tags (e.g., <i>, <b>) intact.
Only return the JSON array of translated strings.

Texts:
${JSON.stringify(textsToTranslate)}`;

            let fetchSuccess = false;
            let lastApiErrorMsg = "";
            const modelsToTry = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-2.5-flash'];

            for (const modelName of modelsToTry) {
              try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey.trim()}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [{
                      parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                      responseMimeType: 'application/json',
                      responseSchema: {
                        type: 'ARRAY',
                        items: {
                          type: 'STRING'
                        }
                      }
                    }
                  })
                });

                if (!response.ok) {
                  let apiErrorMsg = response.statusText;
                  try {
                    const errData = await response.json();
                    apiErrorMsg = errData?.error?.message || response.statusText;
                  } catch (_) {}
                  lastApiErrorMsg = apiErrorMsg;
                  
                  const isQuota = apiErrorMsg.toLowerCase().includes("quota") || apiErrorMsg.toLowerCase().includes("429") || apiErrorMsg.toLowerCase().includes("limit") || apiErrorMsg.toLowerCase().includes("rate");
                  if (isQuota) {
                    throw new Error(`QUOTA_LIMIT: ${apiErrorMsg}`);
                  }
                  continue;
                }

                const data = await response.json();
                const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
                
                let parsed: any = [];
                try {
                  parsed = JSON.parse(rawText.trim());
                } catch (jsonErr) {
                  const match = rawText.match(/\[[\s\S]*\]/);
                  if (match) {
                    parsed = JSON.parse(match[0]);
                  } else {
                    continue;
                  }
                }
                
                if (Array.isArray(parsed)) {
                  translatedTexts = parsed;
                  fetchSuccess = true;
                  callSucceeded = true;
                  break;
                }
              } catch (modelErr: any) {
                if (modelErr.message?.startsWith("QUOTA_LIMIT")) {
                  throw modelErr;
                }
                lastApiErrorMsg = modelErr.message || "Unknown error";
                continue;
              }
            }

            if (!fetchSuccess) {
              throw new Error(`خەتایەک د کلیلا API دا هەیە یان ژی ل دەڤەرا تە هاتیە بەربەستکرن: ${lastApiErrorMsg}`);
            }
          } catch (directErr: any) {
            if (directErr.message?.startsWith("QUOTA_LIMIT")) {
              throw directErr;
            }
            throw new Error(directErr.message || "هەلەیەک د وەرگێڕانا ڕاستەوخۆ دا چێبوو");
          }
        }

        if (!callSucceeded) {
          throw new Error("کردارا وەرگێڕانێ شکەست خوارن.");
        }

        return translatedTexts;

      } catch (err: any) {
        attempts++;
        const isQuota = err.message?.includes("QUOTA_LIMIT") || err.message?.toLowerCase().includes("quota") || err.message?.toLowerCase().includes("429") || err.message?.toLowerCase().includes("limit") || err.message?.toLowerCase().includes("rate");
        
        if (isQuota && attempts < maxAttempts) {
          const waitTime = 20;
          for (let s = waitTime; s > 0; s--) {
            setTranslatingStatus(`⚠️ خێرایی یا گەهشتیە رادێ خۆ (Quota limit). دێ هێتە دووبارەکرن ل سەر ${chunkLabel} پشتی: ${s} چرکەیان...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else {
          throw err;
        }
      }
    }
    throw new Error("سەرنەکەفت پشتی چەند جاران تاقی کرن ژبەر کێشەیا خێراییێ.");
  };

  const translateChunk = async (chunkIndex: number) => {
    if (isTranslating || blocks.length === 0) return;
    
    setIsTranslating(true);
    setError(null);
    setChunkStatuses(prev => ({ ...prev, [chunkIndex]: 'translating' }));
    setChunkErrors(prev => {
      const copy = { ...prev };
      delete copy[chunkIndex];
      return copy;
    });

    try {
      const startIdx = chunkIndex * CHUNK_SIZE;
      const endIdx = Math.min(startIdx + CHUNK_SIZE, blocks.length);
      const chunk = blocks.slice(startIdx, endIdx);
      const textsToTranslate = chunk.map(b => b.text);
      
      setTranslatingStatus(`وەرگێڕانا پشکا ${chunkIndex + 1}... (قەبارێ پشکێ: ${chunk.length} دێر)`);

      const translatedTexts = await performChunkTranslationWithRetry(textsToTranslate, `پشکا ${chunkIndex + 1}`);

      // Apply translations back
      const newBlocks = [...blocks];
      chunk.forEach((block, index) => {
        const globalIndex = startIdx + index;
        newBlocks[globalIndex] = {
          ...newBlocks[globalIndex],
          translatedText: translatedTexts[index] || newBlocks[globalIndex].text
        };
      });

      setBlocks(newBlocks);
      setChunkStatuses(prev => ({ ...prev, [chunkIndex]: 'completed' }));
      setTranslatingStatus(`پشکا ${chunkIndex + 1} ب سەرکەفتیانە وەرگێڕا! ✓`);
      
      // Calculate overall progress
      const numChunks = Math.ceil(blocks.length / CHUNK_SIZE);
      const doneChunks = Object.values({ ...chunkStatuses, [chunkIndex]: 'completed' }).filter(s => s === 'completed').length;
      setProgress(Math.round((doneChunks / numChunks) * 100));

      setTimeout(() => setTranslatingStatus(null), 3000);
    } catch (err: any) {
      console.error(`Error translating chunk ${chunkIndex}:`, err);
      setChunkStatuses(prev => ({ ...prev, [chunkIndex]: 'failed' }));
      setChunkErrors(prev => ({ ...prev, [chunkIndex]: err.message || 'Error' }));
      setError(`خەتا د وەرگێڕانا پشکا ${chunkIndex + 1} دا چێبوو: ${err.message}`);
    } finally {
      setIsTranslating(false);
    }
  };

  const translateSubtitles = async () => {
    if (blocks.length === 0) return;
    setIsTranslating(true);
    setError(null);
    setTranslatingStatus('دەستپێکرنا کردارا وەرگێڕانێ...');

    const numChunks = Math.ceil(blocks.length / CHUNK_SIZE);

    try {
      for (let i = 0; i < numChunks; i++) {
        // Skip already completed chunks!
        const chunkBlocks = blocks.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const isAlreadyDone = chunkStatuses[i] === 'completed' || chunkBlocks.every(b => b.translatedText && b.translatedText.trim() !== "");
        if (isAlreadyDone) {
          continue;
        }

        setChunkStatuses(prev => ({ ...prev, [i]: 'translating' }));
        setChunkErrors(prev => {
          const copy = { ...prev };
          delete copy[i];
          return copy;
        });

        const startIdx = i * CHUNK_SIZE;
        const endIdx = Math.min(startIdx + CHUNK_SIZE, blocks.length);
        const chunk = blocks.slice(startIdx, endIdx);
        const textsToTranslate = chunk.map(b => b.text);
        
        setTranslatingStatus(`وەرگێڕانا پشکا ${i + 1} ژ ${numChunks}... (قەبارێ پشکێ: ${chunk.length} دێر)`);

        const translatedTexts = await performChunkTranslationWithRetry(textsToTranslate, `پشکا ${i + 1} ژ ${numChunks}`);

        // Apply translations back
        setBlocks(currentBlocks => {
          const newBlocks = [...currentBlocks];
          chunk.forEach((block, index) => {
            const globalIndex = startIdx + index;
            newBlocks[globalIndex] = {
              ...newBlocks[globalIndex],
              translatedText: translatedTexts[index] || newBlocks[globalIndex].text
            };
          });
          return newBlocks;
        });

        setChunkStatuses(prev => ({ ...prev, [i]: 'completed' }));

        // Update global progress
        const doneChunks = Object.values({ ...chunkStatuses, [i]: 'completed' }).filter(s => s === 'completed').length;
        setProgress(Math.round((doneChunks / numChunks) * 100));

        // Wait with backoff before continuing to prevent 429 rate limit
        const hasMoreUncompleted = Array.from({ length: numChunks }, (_, idx) => idx)
          .slice(i + 1)
          .some(idx => {
            const subChunkBlocks = blocks.slice(idx * CHUNK_SIZE, (idx + 1) * CHUNK_SIZE);
            return chunkStatuses[idx] !== 'completed' && !subChunkBlocks.every(b => b.translatedText && b.translatedText.trim() !== "");
          });

        if (hasMoreUncompleted && i < numChunks - 1) {
          for (let s = 4; s > 0; s--) {
            setTranslatingStatus(`خێرایی ل بەرچاو هاتیە وەرگرتن: ڕاوەستان بۆ ${s} چرکەیان داکو کێشە دروست نەبیت...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      setTranslatingStatus('پرۆسە ب سەرکەفتیانە تەمام بوو! ✓');
      setTimeout(() => setTranslatingStatus(null), 3000);
    } catch (err: any) {
      console.error("Translation all error:", err);
      const activeChunk = Array.from({ length: numChunks }, (_, idx) => idx).find(idx => chunkStatuses[idx] === 'translating');
      if (activeChunk !== undefined) {
        setChunkStatuses(prev => ({ ...prev, [activeChunk]: 'failed' }));
        setChunkErrors(prev => ({ ...prev, [activeChunk]: err.message || 'Error' }));
      }
      setError(err.message || 'هەلەیەک د وەرگێڕانێ دا چێبوو');
      setTranslatingStatus(null);
    } finally {
      setIsTranslating(false);
    }
  };

  const getManualFormatText = (format: 'line' | 'separator', sepSymbol: string = '|||') => {
    if (format === 'line') {
      return blocks.map((block, idx) => {
        const cleanedText = block.text.replace(/\r?\n/g, ' / ');
        return `[${idx + 1}] ${cleanedText}`;
      }).join('\n');
    } else {
      return blocks.map(block => block.text.replace(/\r?\n/g, ' ')).join(` ${sepSymbol.trim()} `);
    }
  };

  const applyManualTranslation = (pastedText: string, format: 'line' | 'separator', sepSymbol: string = '|||') => {
    const newBlocks = [...blocks];
    let matchedCount = 0;

    if (format === 'line') {
      const lines = pastedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const idPattern = /^\[(\d+)\]\s*(.*)$/;
      let hasBracketMatches = false;

      lines.forEach(line => {
        const match = line.match(idPattern);
        if (match) {
          const id = parseInt(match[1], 10);
          const text = match[2];
          const blockIndex = id - 1;
          if (blockIndex >= 0 && blockIndex < newBlocks.length) {
            let restoredText = text;
            if (newBlocks[blockIndex].text.includes('\n')) {
              restoredText = text.replace(/\s*\/\s*/g, '\n');
            }
            newBlocks[blockIndex] = {
              ...newBlocks[blockIndex],
              translatedText: restoredText
            };
            matchedCount++;
            hasBracketMatches = true;
          }
        }
      });

      if (!hasBracketMatches) {
        let blockIdx = 0;
        lines.forEach(line => {
          if (blockIdx < newBlocks.length) {
            let restoredText = line;
            if (newBlocks[blockIdx].text.includes('\n')) {
              restoredText = line.replace(/\s*\/\s*/g, '\n');
            }
            newBlocks[blockIdx] = {
              ...newBlocks[blockIdx],
              translatedText: restoredText
            };
            matchedCount++;
            blockIdx++;
          }
        });
      }
    } else {
      const escapedSep = sepSymbol.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const parts = pastedText.split(new RegExp(`\\s*${escapedSep}\\s*`)).map(p => p.trim()).filter(p => p.length > 0);
      
      parts.forEach((part, idx) => {
        if (idx < newBlocks.length) {
          newBlocks[idx] = {
            ...newBlocks[idx],
            translatedText: part
          };
          matchedCount++;
        }
      });
    }

    setBlocks(newBlocks);
    
    const updatedStatuses = { ...chunkStatuses };
    const numChunks = Math.ceil(newBlocks.length / CHUNK_SIZE);
    for (let i = 0; i < numChunks; i++) {
      const startIdx = i * CHUNK_SIZE;
      const endIdx = Math.min(startIdx + CHUNK_SIZE, newBlocks.length);
      const chunk = newBlocks.slice(startIdx, endIdx);
      if (chunk.every(b => b.translatedText && b.translatedText.trim() !== "")) {
        updatedStatuses[i] = 'completed';
      } else {
        updatedStatuses[i] = 'idle';
      }
    }
    setChunkStatuses(updatedStatuses);
    
    const doneChunks = Object.values(updatedStatuses).filter(s => s === 'completed').length;
    setProgress(Math.round((doneChunks / numChunks) * 100));

    return matchedCount;
  };

  const handleTextChange = (id: string, newText: string) => {
    setBlocks(blocks.map(b => b.id === id ? { ...b, translatedText: newText } : b));
  };

  const downloadSRT = () => {
    const srtContent = stringifySRT(blocks);
    const blob = new Blob([srtContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file ? `وەرگێڕی_${file.name}` : 'وەرگێڕی_ژێرنڤیس.srt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const numChunks = Math.ceil(blocks.length / CHUNK_SIZE);

  return (
    <div className="h-screen bg-slate-50 text-slate-900 flex flex-col font-sans overflow-hidden border-8 border-indigo-600" dir="rtl">
      {/* Header */}
      <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-8 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center text-white font-bold">
            <Languages className="w-5 h-5" />
          </div>
          <h1 className="text-lg md:text-xl font-bold tracking-tight uppercase">وەرگێڕێ <span className="text-indigo-600">ژێرنڤیسان</span></h1>
        </div>
        <div className="flex items-center gap-4 md:gap-6">
          {file && (
            <div className="flex items-center gap-2 text-sm font-medium text-slate-500 hidden sm:flex">
              <span className="w-2 h-2 bg-green-500 rounded-full"></span>
              {file.name} هاتە بارکرن
            </div>
          )}
          {blocks.length > 0 && (
            <button
              onClick={downloadSRT}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded shadow-sm hover:bg-indigo-700 transition-colors flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">داگرتنا SRT</span>
              <span className="sm:hidden">داگرتن</span>
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {!file ? (
          <main className="flex-1 bg-slate-100 p-6 flex flex-col items-center justify-center overflow-hidden">
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-md space-y-6"
            >
              <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm">
                <h3 className="text-sm font-bold text-slate-700 mb-4 flex items-center gap-2 uppercase">
                  <KeyRound className="w-4 h-4 text-indigo-600" />
                  کلیلا API ل ڤێرە بنڤیسە
                </h3>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder="Gemini API Key..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="flex-1 bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 outline-none transition-all text-left dir-ltr"
                    dir="ltr"
                  />
                  <button
                    onClick={handleSaveKey}
                    className="px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded hover:bg-slate-800 transition-colors whitespace-nowrap min-w-[100px]"
                  >
                    {isKeySaved ? "خەزن بوو ✓" : "خەزن بکە"}
                  </button>
                </div>
              </div>

              <div 
                className="p-12 border-2 border-dashed border-slate-300 rounded-lg text-center cursor-pointer hover:border-indigo-500 hover:bg-indigo-50/30 transition-all bg-white shadow-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  accept=".srt"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6 group-hover:scale-110 transition-transform">
                  <Upload className="w-8 h-8" />
                </div>
                <h2 className="text-xl font-bold text-slate-700 mb-2 uppercase tracking-wide">فایلا ژێرنڤیسێ بارکە</h2>
                <p className="text-sm text-slate-500">فایلا خۆ یا .srt ل ڤێرە دابنێ، یان کلیک بکە بۆ هەلبژارتنێ</p>
              </div>
            </motion.div>
          </main>
        ) : (
          <>
            {/* Sidebar Controls */}
            <aside className="w-64 md:w-72 bg-white border-l border-slate-200 p-6 flex flex-col gap-6 shrink-0 overflow-y-auto">
              <section>
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">1. فایلا سەرەکی</h2>
                <div 
                  className="p-4 border-2 border-dashed border-slate-200 rounded-lg text-center cursor-pointer hover:border-indigo-500 hover:bg-indigo-50/30 transition-all"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    type="file"
                    accept=".srt"
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <p className="text-xs text-slate-500">کلیک بکە بۆ دوبارە بارکرنێ</p>
                  <p className="text-[10px] font-mono text-indigo-500 mt-1 truncate" dir="ltr">{file.name}</p>
                </div>
              </section>

              <section>
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">2. زمانێ وەرگێڕانێ</h2>
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as TranslationLanguage)}
                  className="w-full bg-slate-50 border border-slate-200 text-slate-700 text-sm font-medium rounded focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-3 outline-none transition-all"
                  disabled={isTranslating}
                >
                  {LANGUAGES.map(lang => (
                    <option key={lang} value={lang}>{lang}</option>
                  ))}
                </select>
              </section>

              <section>
                <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">3. کلیلا API</h2>
                <div className="flex flex-col gap-2">
                  <input
                    type="password"
                    placeholder="Gemini API Key..."
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 block p-2.5 outline-none transition-all text-left dir-ltr"
                    dir="ltr"
                  />
                  <button
                    onClick={handleSaveKey}
                    className="w-full px-4 py-2 bg-slate-100 text-slate-700 border border-slate-200 text-sm font-medium rounded hover:bg-slate-200 transition-colors"
                  >
                    {isKeySaved ? "خەزن بوو ✓" : "خەزن بکە"}
                  </button>
                </div>
              </section>

              <section>
                <button
                  onClick={translateSubtitles}
                  disabled={isTranslating || progress === 100}
                  className="w-full flex items-center justify-center gap-2 bg-indigo-600 text-white py-3 rounded text-sm font-semibold shadow-sm hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isTranslating ? (
                    <span className="flex items-center gap-2">
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                      >
                        <Languages className="w-4 h-4" />
                      </motion.div>
                      د وەرگێڕانێ دایە...
                    </span>
                  ) : progress === 100 ? (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      تەمام بوو
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      دەستپێکرنا وەرگێڕانێ
                    </>
                  )}
                </button>

                {isTranslating && (
                  <div className="mt-4">
                    <div className="flex justify-between text-xs text-slate-500 mb-1 font-bold uppercase">
                      <span>پێشکەفتن</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden" dir="ltr">
                      <motion.div
                        className="bg-indigo-600 h-1.5 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.3 }}
                      />
                    </div>
                    {translatingStatus && (
                      <p className="text-[11px] text-indigo-600 mt-2 font-medium leading-relaxed">
                        {translatingStatus}
                      </p>
                    )}
                  </div>
                )}

                {error && (
                  <div className="mt-4 p-3 bg-red-50 text-red-700 rounded text-xs flex items-start gap-2 border border-red-100 font-medium">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <p>{error}</p>
                  </div>
                )}
              </section>

              {blocks.length > 0 && (
                <section className="border-t border-slate-200 pt-4 flex-1 min-h-0 flex flex-col">
                  <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-3 shrink-0">4. پشکێن وەرگێڕانێ ({numChunks})</h2>
                  <div className="space-y-2 overflow-y-auto pr-1 custom-scrollbar flex-1 min-h-0">
                    {Array.from({ length: numChunks }).map((_, idx) => {
                      const startIdx = idx * CHUNK_SIZE;
                      const endIdx = Math.min(startIdx + CHUNK_SIZE, blocks.length);
                      const status = chunkStatuses[idx] || 'idle';
                      const chunkError = chunkErrors[idx];

                      const chunkBlocks = blocks.slice(startIdx, endIdx);
                      const translatedInChunk = chunkBlocks.filter(b => b.translatedText && b.translatedText.trim() !== "").length;
                      const chunkPercent = Math.round((translatedInChunk / chunkBlocks.length) * 100);

                      return (
                        <div 
                          key={idx} 
                          onClick={() => {
                            const firstBlockId = blocks[startIdx]?.id;
                            if (firstBlockId) scrollToBlock(firstBlockId);
                          }}
                          className={`p-2.5 rounded border transition-all cursor-pointer flex flex-col gap-1 text-right ${
                            status === 'translating' ? 'border-indigo-500 bg-indigo-50/40 shadow-sm ring-1 ring-indigo-500/20' :
                            status === 'completed' || chunkPercent === 100 ? 'border-green-200 bg-green-50/10 hover:bg-green-50/20' :
                            status === 'failed' ? 'border-red-200 bg-red-50/30 hover:bg-red-50/40' :
                            'border-slate-200 bg-white hover:border-indigo-200 hover:bg-indigo-50/5'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <div className="flex flex-col items-start text-right">
                              <span className="text-xs font-bold text-slate-700">پشکا {idx + 1}</span>
                              <span className="text-[10px] text-slate-400 font-mono" dir="ltr">{startIdx + 1}-{endIdx}</span>
                            </div>
                            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                              <span className="text-[10px] font-bold text-slate-500">{chunkPercent}%</span>
                              <button
                                onClick={() => translateChunk(idx)}
                                disabled={isTranslating}
                                className={`p-1 rounded transition-colors ${
                                  status === 'translating' ? 'text-indigo-600 bg-indigo-100' :
                                  status === 'completed' || chunkPercent === 100 ? 'text-green-600 bg-green-100 hover:bg-green-200' :
                                  status === 'failed' ? 'text-red-600 bg-red-100 hover:bg-red-200' :
                                  'text-slate-500 bg-slate-100 hover:bg-indigo-600 hover:text-white'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                                title="وەرگێڕانا ڤێ پشکێ تنێ"
                              >
                                {status === 'translating' ? (
                                  <motion.div
                                    animate={{ rotate: 360 }}
                                    transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                                  >
                                    <Languages className="w-3.5 h-3.5 animate-spin" />
                                  </motion.div>
                                ) : status === 'completed' || chunkPercent === 100 ? (
                                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
                                ) : status === 'failed' ? (
                                  <AlertCircle className="w-3.5 h-3.5 text-red-600" />
                                ) : (
                                  <Play className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </div>
                          {chunkError && (
                            <span className="text-[9px] text-red-600 font-medium leading-tight truncate block" title={chunkError}>
                              {chunkError}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="mt-auto shrink-0">
                <div className="bg-slate-50 p-4 rounded border border-slate-200">
                  <p className="text-[11px] text-slate-400 uppercase font-bold mb-2">ئامار</p>
                  <div className="flex justify-between text-xs mb-1 text-slate-600">
                    <span>هەمی ڕستە</span>
                    <span className="font-bold">{blocks.length}</span>
                  </div>
                  <div className="flex justify-between text-xs text-slate-600">
                    <span>وەرگێڕی</span>
                    <span className="font-bold text-green-600">
                      {blocks.length > 0 ? Math.round((blocks.filter(b => b.translatedText).length / blocks.length) * 100) : 0}%
                    </span>
                  </div>
                </div>
              </section>
            </aside>

            {/* Main Editor */}
            <main className="flex-1 bg-slate-100 p-4 md:p-6 flex flex-col gap-4 overflow-hidden">
              {/* Tab Selector */}
              <div className="flex bg-white p-1 rounded-lg border border-slate-200 shrink-0 gap-1 shadow-sm">
                <button 
                  onClick={() => setActiveTab('auto')}
                  className={`flex-1 py-2 text-xs font-bold rounded transition-colors flex items-center justify-center gap-2 ${activeTab === 'auto' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  <Languages className="w-3.5 h-3.5" />
                  وەرگێڕانا ئۆتۆماتیکی (پشک پشک)
                </button>
                <button 
                  onClick={() => setActiveTab('manual')}
                  className={`flex-1 py-2 text-xs font-bold rounded transition-colors flex items-center justify-center gap-2 ${activeTab === 'manual' ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'}`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  وەرگێڕانا دەستی (کۆپی و پێست)
                </button>
              </div>

              {activeTab === 'manual' ? (
                <div className="flex-1 overflow-y-auto space-y-4 pr-1 custom-scrollbar pb-8">
                  <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
                    <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2 uppercase">
                      <FileText className="w-4 h-4 text-indigo-600" />
                      کردارا وەرگێڕانا ب دەست (کۆپی و پێست)
                    </h3>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      ڤێ ڕێژەیێ بەکاربینە ئەگەر تە ڤیا وەرگێڕانێ بخۆ یان ب ئامرازێن دەرەکی (مینا Google Translate یان ChatGPT) بکەی داکو کێشەیا خێراییێ چێ نەبیت.
                    </p>

                    {/* Format Selector */}
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-600 block">شێوازێ ڕێکخستنا تێکستی:</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setManualFormat('line')}
                          className={`flex-1 py-2 px-3 text-xs font-semibold rounded border transition-all ${
                            manualFormat === 'line' 
                              ? 'border-indigo-600 bg-indigo-50/50 text-indigo-700' 
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          دێڕ ب دێڕ دگەل ناسناما [ID] (پێشنیارکری)
                        </button>
                        <button
                          type="button"
                          onClick={() => setManualFormat('separator')}
                          className={`flex-1 py-2 px-3 text-xs font-semibold rounded border transition-all ${
                            manualFormat === 'separator' 
                              ? 'border-indigo-600 bg-indigo-50/50 text-indigo-700' 
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          ڕستە دگەل هێمایێ جوداکەر
                        </button>
                      </div>
                    </div>

                    {/* Delimiter Input (only for separator format) */}
                    {manualFormat === 'separator' && (
                      <div className="flex items-center gap-2 bg-slate-50 p-2.5 rounded border border-slate-200 max-w-xs" dir="rtl">
                        <span className="text-xs text-slate-500 whitespace-nowrap">هێمایێ جوداکەر:</span>
                        <input
                          type="text"
                          value={manualDelimiter}
                          onChange={(e) => setManualDelimiter(e.target.value)}
                          className="w-16 bg-white border border-slate-300 text-center text-xs p-1 font-bold rounded focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                        />
                      </div>
                    )}

                    {/* Section 1: Copy Original */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-bold text-slate-700">۱. دەقێ سەرەکی کۆپی بکە:</label>
                        <button
                          type="button"
                          onClick={() => {
                            const txt = getManualFormatText(manualFormat, manualDelimiter);
                            navigator.clipboard.writeText(txt);
                            setCopiedEffect(true);
                            setTimeout(() => setCopiedEffect(false), 2000);
                          }}
                          className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 rounded text-xs font-bold transition-all flex items-center gap-1.5"
                        >
                          {copiedEffect ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-green-600" />
                              <span className="text-green-600">کۆپی بوو! ✓</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              <span>کۆپی بکە</span>
                            </>
                          )}
                        </button>
                      </div>
                      <textarea
                        readOnly
                        value={getManualFormatText(manualFormat, manualDelimiter)}
                        className="w-full h-40 p-3 bg-slate-50 border border-slate-200 rounded text-xs font-mono text-slate-600 focus:outline-none focus:ring-0 custom-scrollbar resize-none"
                        dir="ltr"
                      />
                    </div>

                    {/* Section 2: Paste Translation */}
                    <div className="space-y-2">
                      <label className="text-xs font-bold text-slate-700 block">۲. دەقێ وەرگێڕای ل ڤێرە دابنێ (پێست بکە):</label>
                      <textarea
                        placeholder={
                          manualFormat === 'line' 
                            ? "[1] سلاڤ ل تە\n[2] تو چەوانی؟" 
                            : `وەرگێڕانا یەکێ ${manualDelimiter} وەرگێڕانا دووێ ${manualDelimiter} وەرگێڕانا سیێ`
                        }
                        value={manualPasteText}
                        onChange={(e) => setManualPasteText(e.target.value)}
                        className="w-full h-40 p-3 bg-white border border-slate-200 rounded text-xs focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none custom-scrollbar"
                        dir="rtl"
                      />
                    </div>

                    {/* Apply Button */}
                    <div className="flex items-center gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (!manualPasteText.trim()) return;
                          const count = applyManualTranslation(manualPasteText, manualFormat, manualDelimiter);
                          setManualSuccessMsg(`ب سەرکەفتیانە ${count} دێڕ هاتنە وەرگێڕان و دابەشکرن! ✓`);
                          setTimeout(() => setManualSuccessMsg(null), 5000);
                        }}
                        disabled={!manualPasteText.trim()}
                        className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm rounded shadow-sm transition-colors disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"
                      >
                        جێبەجێکرنا وەرگێڕانێ (دابەشکرن ل سەر ژێرنڤیسان)
                      </button>
                    </div>

                    {manualSuccessMsg && (
                      <div className="p-3 bg-green-50 border border-green-200 text-green-700 rounded text-xs font-bold flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-green-600" />
                        <span>{manualSuccessMsg}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-12 gap-4 px-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider shrink-0">
                    <div className="col-span-1 hidden md:block">#</div>
                    <div className="col-span-2 hidden md:block text-center">دەم</div>
                    <div className="col-span-12 md:col-span-4">دەقێ سەرەکی</div>
                    <div className="col-span-12 md:col-span-5">وەرگێڕان</div>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto pl-2 custom-scrollbar pb-8">
                    {blocks.map((block) => {
                      const isTranslated = !!block.translatedText;
                      return (
                        <div 
                          key={block.id} 
                          id={`cue-row-${block.id}`}
                          className="grid grid-cols-12 gap-4 p-4 bg-white rounded-lg border border-slate-200 shadow-sm items-start transition-all duration-300"
                        >
                          <div className="col-span-1 hidden md:block font-mono text-slate-400 text-sm" dir="ltr">
                            {block.id.padStart(3, '0')}
                          </div>
                          <div className="col-span-2 hidden md:block font-mono text-[11px] text-slate-500 bg-slate-50 p-1 rounded text-center leading-tight" dir="ltr">
                            {block.time.split(' --> ').map((t, i) => (
                              <React.Fragment key={i}>
                                {t}{i === 0 && <><br/>--&gt;<br/></>}
                              </React.Fragment>
                            ))}
                          </div>
                          <div className="col-span-12 md:col-span-4 text-sm text-slate-700 leading-relaxed" dir="ltr">
                            {block.text}
                          </div>
                          <div className="col-span-12 md:col-span-5">
                            <textarea
                              value={block.translatedText !== undefined ? block.translatedText : ''}
                              onChange={(e) => handleTextChange(block.id, e.target.value)}
                              placeholder={isTranslating ? "د وەرگێڕانێ دایە..." : "وەرگێڕان دێ ل ڤێرە دیار بیت..."}
                              className={`w-full p-2 border rounded text-sm min-h-[5rem] resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all ${
                                isTranslated ? 'border-indigo-200 bg-indigo-50/30' : 'border-slate-200 bg-slate-50/50 focus:bg-white'
                              }`}
                              rows={Math.max(2, block.text.split('\n').length)}
                              dir="rtl"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </main>
          </>
        )}
      </div>

      {/* Bottom Status Bar */}
      <footer className="h-10 md:h-12 bg-slate-900 text-white flex items-center px-4 md:px-8 text-[10px] md:text-[11px] shrink-0 justify-between">
        <div className="flex gap-4 md:gap-6">
          <span className="opacity-70 hidden sm:inline" dir="ltr">UTF-8 Encoding</span>
          <span className="opacity-70 hidden sm:inline" dir="ltr">Line Endings: CRLF</span>
          <span className="opacity-70" dir="ltr">RTL Support: Enabled</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-indigo-400 font-bold uppercase tracking-widest hidden sm:inline">ئامادەیە</span>
          <div className="w-px h-4 bg-slate-700 hidden sm:block"></div>
          <div className="flex gap-1 opacity-80" dir="ltr">
            {blocks.length} Cues
          </div>
        </div>
      </footer>
    </div>
  );
}

