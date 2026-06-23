import React, { useState, useRef, useEffect } from 'react';
import { Upload, Languages, Download, Play, CheckCircle2, AlertCircle, FileText, KeyRound } from 'lucide-react';
import { motion } from 'motion/react';
import { SRTBlock, TranslationLanguage, LANGUAGES } from './types';
import { parseSRT, stringifySRT, chunkArray } from './utils';

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [blocks, setBlocks] = useState<SRTBlock[]>([]);
  const [language, setLanguage] = useState<TranslationLanguage>('کوردی - بادینی (Kurdish Badini - Arabic Script)');
  
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('geminiApiKey') || '');
  const [isKeySaved, setIsKeySaved] = useState(false);

  const [isTranslating, setIsTranslating] = useState(false);
  const [translatingStatus, setTranslatingStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0];
    if (!uploadedFile) return;

    setFile(uploadedFile);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setBlocks(parseSRT(content));
        setError(null);
        setProgress(0);
        setTranslatingStatus(null);
      }
    };
    reader.readAsText(uploadedFile);
  };

  const handleSaveKey = () => {
    localStorage.setItem('geminiApiKey', apiKey);
    setIsKeySaved(true);
    setTimeout(() => setIsKeySaved(false), 2000);
  };

  const translateSubtitles = async () => {
    if (blocks.length === 0) return;
    setIsTranslating(true);
    setProgress(0);
    setError(null);
    setTranslatingStatus('دەستپێکرنا کردارا وەرگێڕانێ...');

    try {
      // Larger chunk size (e.g. 80 lines per chunk) to reduce total requests significantly
      const CHUNK_SIZE = 80;
      const chunks = chunkArray<SRTBlock>(blocks, CHUNK_SIZE);
      const newBlocks = [...blocks];
      let translatedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const textsToTranslate = chunk.map((b: SRTBlock) => b.text);
        
        setTranslatingStatus(`وەرگێڕانا پشکا ${i + 1} ژ ${chunks.length}... (قەبارێ وەجبەیێ: ${chunk.length} دێر)`);

        let translatedTexts: string[] = [];

        if (apiKey && apiKey.trim() !== "") {
          // Direct client-side call to Gemini API (highly robust, 100% compatible with static hosts like Netlify/GitHub)
          try {
            const prompt = `Translate the following array of subtitle texts into ${language}.
If the target language is Badini or Sorani Kurdish, YOU MUST USE THE ARABIC/KURDISH ALPHABET (پ ی ت ج چ ...), NOT Latin letters.
You MUST maintain the exact same number of items in the array (exactly ${textsToTranslate.length} items).
Do not translate the formatting, only the meaning. Keep any HTML-like tags (e.g., <i>, <b>) intact.
Only return the JSON array of translated strings.

Texts:
${JSON.stringify(textsToTranslate)}`;

            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey.trim()}`, {
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
              const errData = await response.json();
              const apiErrorMsg = errData?.error?.message || response.statusText;
              
              if (response.status === 429) {
                throw new Error("قۆتا تەمام بوویە یان لودا سەر سێرڤەری زۆرە (Rate limit/Quota exceeded). هیڤیە چەند چرکەیەکا ڕاوەستە پاشان تاقی بکەوە.");
              }
              throw new Error(`خەتایەک د کلیلا API دا هەیە یان ژی ل دەڤەرا تە هاتیە بەربەستکرن: ${apiErrorMsg}`);
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
                throw new Error("سیستەمێ وەرگێڕانێ بەرسڤەکا کەتوار نەزڤڕاند");
              }
            }
            
            if (Array.isArray(parsed)) {
              translatedTexts = parsed;
            } else {
              throw new Error("ئەنجامێ وەرگێڕانێ لیستەکا دروست نەبوو");
            }
          } catch (directErr: any) {
            console.error("Direct client-side call failed", directErr);
            throw new Error(directErr.message || "هەلەیەک د وەرگێڕانا ڕاستەوخۆ دا چێبوو");
          }
        } else {
          // Fallback to Express backend if no API Key is provided
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

            if (response.status === 404) {
              throw new Error("مێوانداریا تە (مینا Netlify یان GitHub) پشتەڤانیا سێرڤەری ناکەت. پێدڤیە کلیلا خۆ یا Gemini API ل سەر لایێ چەپێ بنڤیسی داکو ڕاستەوخۆ کاربکەت!");
            }

            let data;
            try {
              data = await response.json();
            } catch (e) {
              throw new Error(`سێرڤەر بەرسڤەکا نەدروست زڤڕاند (${response.status})`);
            }

            if (!response.ok) {
              throw new Error(data.error || 'هەلەیەک د وەرگێڕانێ دا چێبوو (Translation failed)');
            }

            translatedTexts = data.translatedTexts;
          } catch (fallbackErr: any) {
            throw new Error(fallbackErr.message || 'هەلەیەک د وەرگێڕانێ دا چێبوو');
          }
        }

        // Apply translations back
        chunk.forEach((block, index) => {
          const globalIndex = i * CHUNK_SIZE + index;
          newBlocks[globalIndex] = {
            ...newBlocks[globalIndex],
            translatedText: translatedTexts[index] || newBlocks[globalIndex].text
          };
        });

        translatedCount += chunk.length;
        setProgress(Math.round((translatedCount / blocks.length) * 100));
        setBlocks([...newBlocks]); // Update UI progressively

        // If there are more chunks, wait for 4 seconds to respect the Gemini API rate limit (RPM 15)
        if (i < chunks.length - 1) {
          for (let s = 4; s > 0; s--) {
            setTranslatingStatus(`خێرایی ل بەرچاو هاتیە وەرگرتن: ڕاوەستان بۆ ${s} چرکەیان داکو کێشە دروست نەبیت...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      setTranslatingStatus('پرۆسە ب سەرکەفتیانە تەمام بوو! ✓');
      setTimeout(() => setTranslatingStatus(null), 3000);
    } catch (err: any) {
      setError(err.message || 'هەلەیەک د وەرگێڕانێ دا چێبوو');
      setTranslatingStatus(null);
    } finally {
      setIsTranslating(false);
    }
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

              <section className="mt-auto">
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
                    <div key={block.id} className="grid grid-cols-12 gap-4 p-4 bg-white rounded-lg border border-slate-200 shadow-sm items-start transition-colors">
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

