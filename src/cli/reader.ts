import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { ingestUpload } from "../pipeline/ingestUpload.js";
import { BufferEngine } from "../pipeline/bufferEngine.js";
import { GeminiProvider } from "../generate/geminiProvider.js";
import { LocalDraftProvider } from "../generate/localProvider.js";
import { GeminiQualityJudge, LocalQualityJudge } from "../generate/qualityJudge.js";
import { EditionStorage } from "../storage/cache.js";
import { fitWordsToLineBox } from "../reader/readWindow.js";

async function main() {
  const args = process.argv.slice(2);
  const epubPath = args[0] || "blood meridian.epub";
  const useGemini = args.includes("--gemini") || Boolean(process.env.GEMINI_API_KEY?.trim());

  console.log(`\n📖 Progressive Reading — Terminal Widget Reader`);
  console.log(`Loading book: ${epubPath}`);

  const edition = await ingestUpload(resolve(process.cwd(), epubPath));
  const storage = new EditionStorage();
  const provider = useGemini ? new GeminiProvider() : new LocalDraftProvider();
  const judge = useGemini ? new GeminiQualityJudge() : new LocalQualityJudge();

  const engine = new BufferEngine({
    storage,
    provider,
    judge,
    defaultBufferSize: 3,
  });

  const session = await engine.initializeSession(edition);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const card = await engine.getCurrentCard(edition);
      const currentSession = (await storage.getSession(session.editionId)) ?? session;
      const display = card.isTitleCard ? { text: card.text, wordCount: card.wordCount } : fitWordsToLineBox(card.text, 60, 12);

      console.clear();
      printCardBox(
        currentSession.title,
        currentSession.currentFragmentIndex,
        currentSession.totalFragments,
        card.cardIndex + 1,
        card.totalCards,
        display.text,
        display.wordCount,
        card.estimatedReadSeconds,
      );

      const promptMsg = card.isTitleCard
        ? "\n[Enter] Next Fragment  |  [q] Quit  > "
        : "\n[Enter] Next Card  |  [q] Quit  > ";

      const answer = await rl.question(promptMsg);
      if (answer.trim().toLowerCase() === "q") {
        console.log("\nSession saved. See you next time!\n");
        break;
      }

      const { currentCard } = await engine.confirmAndAdvanceCard(edition, {
        consumedWordCount: card.isTitleCard ? undefined : display.wordCount,
      });
      if (!currentCard) {
        console.log("\n🎉 Congratulations! You have completed the book!\n");
        break;
      }
    }
  } finally {
    rl.close();
  }
}

function printCardBox(
  title: string,
  fragIndex: number,
  totalFrags: number,
  cardIndex: number,
  totalCards: number,
  text: string,
  words: number,
  seconds: number,
) {
  const width = 64;
  const line = "─".repeat(width);
  const header = ` ${title}  •  Fragment ${fragIndex + 1}/${totalFrags}  •  Card ${cardIndex}/${totalCards} `;
  const footer = ` ${words} words  •  ~${seconds}s glance `;

  console.log(`┌${line}┐`);
  console.log(`│${padCenter(header, width)}│`);
  console.log(`├${line}┤`);

  // Wrap text nicely to width - 4
  const wrapped = wrapText(text, width - 4);
  console.log(`│${" ".repeat(width)}│`);
  for (const l of wrapped) {
    console.log(`│  ${l.padEnd(width - 4, " ")}  │`);
  }
  console.log(`│${" ".repeat(width)}│`);

  console.log(`├${line}┤`);
  console.log(`│${padCenter(footer, width)}│`);
  console.log(`└${line}┘`);
}

function padCenter(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width);
  const left = Math.floor((width - str.length) / 2);
  const right = width - str.length - left;
  return " ".repeat(left) + str + " ".repeat(right);
}

function wrapText(text: string, maxLen: number): string[] {
  const paragraphs = text.split("\n\n");
  const result: string[] = [];

  for (let pIndex = 0; pIndex < paragraphs.length; pIndex++) {
    const words = paragraphs[pIndex].split(/\s+/u);
    let cur = "";

    for (const w of words) {
      if (cur.length === 0) {
        cur = w;
      } else if (cur.length + 1 + w.length <= maxLen) {
        cur += " " + w;
      } else {
        result.push(cur);
        cur = w;
      }
    }
    if (cur.length > 0) {
      result.push(cur);
    }
    if (pIndex < paragraphs.length - 1) {
      result.push(""); // blank line between paragraphs
    }
  }

  return result;
}

main().catch(console.error);
