import type { TranscriptSegment } from "./api-types";
import { matchingCharacters } from "./speech-text";
import { isUncertainTiming } from "./transcript-quality";

export type SearchTiming = "word" | "estimated" | "segment";

export interface TranscriptSearchHit {
  segmentIds: number[];
  startSec: number;
  endSec: number;
  timing: SearchTiming;
  ranges: Array<{ segmentId: number; start: number; end: number }>;
}
interface SearchRef { segmentId: number; start: number; end: number; startSec: number; endSec: number; timing: SearchTiming }
export interface TranscriptSearchIndex { text: string; refs: SearchRef[] }

/** 只有全文与词序一致、时间合法时才采用词级定位；纠错后的旧词序不可复用。 */
function timedCharacters(segment: TranscriptSegment): Array<{ startSec: number; endSec: number; timing: SearchTiming }> | null {
  const refs: Array<{ startSec: number; endSec: number; timing: SearchTiming }> = [];
  let text = "";
  let previousEnd = segment.startSec;
  for (const word of segment.words) {
    if (!Number.isFinite(word.startSec) || !Number.isFinite(word.endSec) ||
        word.startSec < previousEnd || word.endSec <= word.startSec || word.endSec > segment.endSec) return null;
    previousEnd = word.endSec;
    const normalized = matchingCharacters(word.text).join("");
    text += normalized;
    for (let i = 0; i < normalized.length; i++) refs.push({
      startSec: word.startSec, endSec: word.endSec,
      timing: isUncertainTiming(word) ? "estimated" : "word",
    });
  }
  return text === matchingCharacters(segment.text).join("") ? refs : null;
}

/** Normalize punctuation, spacing, case and compatibility forms for cross-cue
 * matching while retaining original UTF-16 positions for safe React marks. */
export function indexTranscript(segments: readonly TranscriptSegment[]): TranscriptSearchIndex {
  const text: string[] = [];
  const refs: SearchRef[] = [];
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segments) {
    const times = timedCharacters(segment);
    let offset = 0;
    for (const part of graphemes.segment(segment.text)) {
      for (const ch of matchingCharacters(part.segment)) {
        text.push(ch);
        // String#indexOf uses UTF-16 offsets, including astral CJK characters.
        for (let j = 0; j < ch.length; j++) refs.push({
          segmentId: segment.id, start: part.index, end: part.index + part.segment.length,
          ...(times?.[offset++] ?? { startSec: segment.startSec, endSec: segment.endSec, timing: "segment" as const }),
        });
      }
    }
  }
  return { text: text.join(""), refs };
}

export function searchTranscript(index: TranscriptSearchIndex, query: string, limit = 2000): TranscriptSearchHit[] {
  const needle = matchingCharacters(query.slice(0, 500)).join("");
  if (!needle) return [];
  const hits: TranscriptSearchHit[] = [];
  let from = 0;
  while (hits.length < limit) {
    const at = index.text.indexOf(needle, from);
    if (at < 0) break;
    const ranges: TranscriptSearchHit["ranges"] = [];
    for (let i = at; i < at + needle.length; i++) {
      const ref = index.refs[i];
      const last = ranges[ranges.length - 1];
      if (last?.segmentId === ref.segmentId) last.end = ref.end;
      else ranges.push({ segmentId: ref.segmentId, start: ref.start, end: ref.end });
    }
    const matched = index.refs.slice(at, at + needle.length);
    const timing: SearchTiming = matched.some((ref) => ref.timing === "segment") ? "segment"
      : matched.some((ref) => ref.timing === "estimated") ? "estimated" : "word";
    hits.push({ ranges, segmentIds: ranges.map((r) => r.segmentId), startSec: matched[0].startSec, endSec: matched[matched.length - 1].endSec, timing });
    from = at + Math.max(1, needle.length);
  }
  return hits;
}
