import { SRTBlock } from './types';

export function parseSRT(data: string): SRTBlock[] {
  const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Some SRTs might have more than two newlines, normalize them
  const blocks = normalized.split(/\n\n+/).map(b => b.trim()).filter(b => b);
  
  return blocks.map(block => {
    const lines = block.split('\n');
    const id = lines[0] || '';
    const time = lines[1] || '';
    const text = lines.slice(2).join('\n');
    return { id, time, text, translatedText: '' };
  });
}

export function stringifySRT(blocks: SRTBlock[]): string {
  return blocks.map(b => {
    const textToUse = b.translatedText?.trim() || b.text.trim();
    return `${b.id}\n${b.time}\n${textToUse}`;
  }).join('\n\n') + '\n\n';
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}
