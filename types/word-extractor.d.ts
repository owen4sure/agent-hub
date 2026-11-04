// word-extractor 沒有內建型別宣告，這裡補一個最小可用的介面(只宣告我們有用到的部分)。
declare module "word-extractor" {
  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(): string;
    getFooters(): string;
  }
  class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
  export default WordExtractor;
}
