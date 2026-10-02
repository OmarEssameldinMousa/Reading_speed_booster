# Reading Speed Booster

Read faster without losing understanding. You move a highlight through the **real pages** of a PDF book as you read.
An AI tutor checks your comprehension after every section, notices where you get stuck, and helps you find the
fastest speed you can still understand at.

## Run

```bash
npm install
npm run dev        # open the printed URL, then drop a PDF on the Library page
npm test           # unit tests (+ a pipeline test against a sample PDF if one is in this folder)
npm run build      # production build in dist/
```

There is no backend and no account. Books and reading history stay in your browser (IndexedDB).

### Free AI keys (2 minutes)

Questions, grading and explanations use a free AI API. Paste the keys on the **Settings** page:

| Provider | Get a key | Role |
|---|---|---|
| Google Gemini (Flash) | https://aistudio.google.com/apikey | Primary. Big context, so it can see a whole section. |
| Groq (Llama / Qwen) | https://console.groq.com/keys | Automatic fallback when Gemini fails or runs out of quota. |

Click **Test connection** on each one. Without a key the app still works: the section checks become free recall graded by key words.

> Free tiers change often, and on free tiers the provider may use what you send to improve its models.
> Only the book's body text is sent, never figures or tables.

## How a session works

1. **Library → book → pick where the real content starts** (e.g. Chapter 1). Front matter is skipped.
2. **Read on the real page.** Figures, tables and code are shown exactly as printed but are never highlighted.
   - <kbd>Shift</kbd>+<kbd>→</kbd> next word, <kbd>Shift</kbd>+<kbd>↓</kbd> rest of the line
   - <kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>↑</kbd> go back a word / line, or **click any word** to reread from there
   - each pass paints the text, and the color gets darker every time you reread it (yellow → amber → orange → red)
3. **End of a section → comprehension check.** The AI asks 2 questions about it: recall, why/how, or apply-it.
   Sometimes it adds one about an **earlier section** from this session. You answer in your own words, the AI
   grades the meaning and tells you what you missed, and **↩ Reread this part** jumps to the sentence that has the answer.
   Questions are prepared in the background while you read the last 30% of the section, so there's no waiting.
4. **Stuck?** After you've read the same sentence 3 times, or slowed down a lot on a paragraph, a chip offers an explanation:
   plain words, an example, and a check question, with follow-ups. <kbd>?</kbd> asks for one at any time.
5. **Focus checks.** Every 5–10 minutes: *where was your mind just now?* (on the text / somewhere else / zoned out).
6. **Pacer** (<kbd>Space</kbd>). It moves the highlight at a set wpm and adapts: +5% after a check scored ≥ 80%, −5% under 60%.

## What it measures (Progress page)

- **Effective reading rate** = words per minute × comprehension. This is the number to grow.
- Speed vs. understanding per section (the scatter shows where you start losing the plot)
- Reading speed, regressions (going back) per 100 words, and reading days
- Score by question type, and by what your focus check said (on-task vs. autopilot)
- **Hard spots**: paragraphs you reread, slowed down on, or asked about (click to reopen at that spot)
- Export: answers as CSV, everything as JSON

## The science, honestly

| Feature | Basis |
|---|---|
| Questions after each section | Retrieval practice (testing effect): recalling strengthens understanding and memory more than rereading |
| Why/how and apply-it questions | Elaborative interrogation; transfer-appropriate processing |
| Questions about earlier sections | Spaced and interleaved retrieval |
| Explanations at reread hotspots | Targeted feedback where comprehension breaks down |
| Focus checks | Thought probes, the standard way to measure mind-wandering during reading |
| Pacer + effective rate | Speed–accuracy trade-off: reading faster than you can follow lowers comprehension (Rayner et al., 2016) |
| Regressions are tracked, not punished | Going back is often how readers repair understanding (Schotter et al., 2014) |

"Speed reading" claims of 1000+ wpm with full comprehension aren't supported by the research. What does work is
practice, vocabulary and background knowledge, and skimming strategically when it fits the goal. The app doesn't promise
a number. It measures your speed and understanding together, so you can see whether you're actually improving.

## Code map

- `src/pdf/`: outline → chapters, text extraction, classification (body vs. figure, caption, table, code, header), word stream, word layout and boxes
- `src/reader/`: `cursor.ts` (pure reading model), `metrics.ts`, `marks.ts` (highlight layer), `controller.ts` (moves, sessions, quizzes, detection, pacer), `Read.tsx`, `panels.tsx`
- `src/ai/`: `providers.ts` (Gemini, Groq), `router.ts` (fallback + usage), `prompts.ts` (quiz, grading, clarify, offline grader)
- `src/stats/`, `src/pages/`, `src/db/` (Dexie schema + settings)
