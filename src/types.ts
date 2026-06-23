export interface SRTBlock {
  id: string;
  time: string;
  text: string;
  translatedText?: string;
}

export type TranslationLanguage = 
  | 'کوردی - بادینی (Kurdish Badini - Arabic Script)'
  | 'کوردی - سۆرانی (Kurdish Sorani)'
  | 'ئینگلیزی (English)'
  | 'عەرەبی (Arabic)'
  | 'فارسی (Persian)'
  | 'تورکی (Turkish)'
  | 'ئیسپانی (Spanish)'
  | 'فەرەنسی (French)'
  | 'ئەڵمانی (German)';

export const LANGUAGES: TranslationLanguage[] = [
  'کوردی - بادینی (Kurdish Badini - Arabic Script)',
  'کوردی - سۆرانی (Kurdish Sorani)',
  'ئینگلیزی (English)',
  'عەرەبی (Arabic)',
  'فارسی (Persian)',
  'تورکی (Turkish)',
  'ئیسپانی (Spanish)',
  'فەرەنسی (French)',
  'ئەڵمانی (German)',
];
