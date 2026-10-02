/** One pdf.js text item, in PDF user space (points, y axis pointing up). */
export interface RawItem {
  str: string;
  x: number; // baseline start
  y: number; // baseline
  w: number; // advance width
  fs: number; // font size
  font: string; // pdf.js loaded font name, e.g. g_d0_f3
  family: string; // 'serif' | 'sans-serif' | 'monospace'
  ascent: number;
  descent: number;
}

export interface RawPage {
  page: number; // 0-based page index
  width: number;
  height: number;
  items: RawItem[];
}

export type ItemKind = 'body' | 'heading' | 'skip';

export interface ItemModel extends RawItem {
  kind: ItemKind;
  line: number; // line index within the page
  vidBase: number; // global visual-char id of str[0], or -1 when not typeable
}

export interface PageModel {
  page: number;
  width: number;
  height: number;
  items: ItemModel[];
}

export interface Section {
  word: number; // first word of the section (the heading)
  heading: string;
}

export interface Stream {
  words: string[];
  wordStart: Int32Array; // word → first stream position; separator is at wordStart[w] + words[w].length
  posCount: number;
  // position → visual chars (CSR): posVids[posVidStart[p] .. posVidStart[p+1])
  posVidStart: Int32Array;
  posVids: Int32Array;
  // visual char → owning position range [vidPos, vidPosEnd]; -1 when not typeable
  vidPos: Int32Array;
  vidPosEnd: Int32Array;
  vidCount: number;
  posWord: Int32Array; // position → word
  paragraphs: number[]; // first word of each paragraph
  sections: Section[];
  sentenceEnds: Uint8Array; // 1 when the word ends a sentence
}

export interface ChapterModel {
  pages: PageModel[];
  stream: Stream;
  bodySize: number;
}
