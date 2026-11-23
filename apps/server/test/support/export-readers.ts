import { strFromU8, unzipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfText(buffer: Buffer): Promise<string> {
  const task = getDocument({ data: Uint8Array.from(buffer), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    const pages = await Promise.all(
      Array.from({ length: pdf.numPages }, async (_, index) => {
        const page = await pdf.getPage(index + 1);
        const content = await page.getTextContent();
        return content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' ');
      }),
    );
    return pages.join('\n');
  } finally {
    await task.destroy();
  }
}

export function docxXml(buffer: Buffer): string {
  return strFromU8(unzipSync(buffer)['word/document.xml']!);
}
