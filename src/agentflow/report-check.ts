// The figure check of the composed report (S6-Q8, FD-29): every figure in an LLM report must exist in the purchased
// data, with a matching unit. Pure: no I/O, no environment, no clock.
// - Sources (U1): walking the JSON the composer sends the LLM (the delivered bodies and the receipts summary), a
//   JSON number is a source with its key; a string that is wholly numeric (e.g. "$0.005", "6999215711.06") is a
//   source with its key; an ISO date string contributes its year, month, day, hour and minute as plain sources;
//   every other string is ignored (addresses, signatures, mints, names). An array's items carry the array's key.
//   From the goal and the budget line, $-amounts are dollar sources and the other numbers plain sources.
// - Report scanning (U2): ISO dates and date-times, then times, are removed; each remaining number is taken with
//   its $, %, an attached K/M/B or a following whole word thousand/million/billion; a number attached to letters
//   (x402, 24h, B1) is not taken; commas are removed and absolute values compared.
// - Matching (U3, U4): a bare integer 0–10 always passes; otherwise a value r with d decimals and scale s matches a
//   source a when |a − r·s| ≤ 0.5·10^(−d)·s and the unit agrees: % only against keys ending in "Pct"; $ only against
//   keys containing "Usd" or the dollar amounts of the goal and the budget line; a plain figure against any source.
// - Time window (FD-35, S6-A1): a bare integer (no $, %, K/M/B, scale word or decimals) followed by optional
//   whitespace or one hyphen, then a whole word hour, hours, day or days (any case), is accepted without a numeric
//   match when its digits, as written, equal a maximal digit run inside the key of a source ("24" in
//   priceChange24hPct). Any other number before a time word is checked as before.
// Stated limit: it checks that each figure exists in the data with a matching unit, not that the report attributes
// it to the right quantity.

export type FigureSource = { value: number; key?: string; dollar?: boolean };
export type ReportCheckResult = { ok: true } | { ok: false; unmatched: string[] };

const WHOLLY_NUMERIC = /^\$?-?\d[\d,]*(\.\d+)?%?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const REPORT_DATE = /\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g;
const REPORT_TIME = /\b\d{1,2}:\d{2}(:\d{2})?\b/g;
const NUMBER = /(?<![A-Za-z0-9.])\$?\d[\d,]*(?:\.\d+)?%?([KMB])?(?![A-Za-z0-9])/g;
const SCALE_WORD = /^\s+(thousand|million|billion)\b/i;
const SCALES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, thousand: 1e3, million: 1e6, billion: 1e9 };
const TIME_WORD = /^(?:\s*|-)(?:hours?|days?)\b/i;
const BARE_DIGITS = /^\d+$/;

// windowDigits: the digits as written, when the figure is a bare integer followed by a time word (FD-35).
type Figure = { raw: string; value: number; decimals: number; scale: number; dollar: boolean; pct: boolean; windowDigits?: string };

// The numbers of a text (a report, the goal or the budget line), dates and times removed first.
function figuresOf(text: string): Figure[] {
  const cleaned = text.replace(REPORT_DATE, " ").replace(REPORT_TIME, " ");
  const figures: Figure[] = [];
  for (const match of cleaned.matchAll(NUMBER)) {
    const token = match[0];
    const letter = match[1];
    const rest = cleaned.slice((match.index ?? 0) + token.length);
    const after = SCALE_WORD.exec(rest);
    const word = letter === undefined ? after?.[1] : undefined;
    const timeWindow = BARE_DIGITS.test(token) && TIME_WORD.test(rest);
    const numeric = token.replace(/^\$/, "").replace(/[%KMB]+$/, "").replace(/,/g, "");
    const dot = numeric.indexOf(".");
    figures.push({
      raw: word === undefined ? token.replace(/,$/, "") : `${token} ${word}`,
      value: Math.abs(Number(numeric)),
      decimals: dot === -1 ? 0 : numeric.length - dot - 1,
      scale: letter !== undefined ? SCALES[letter] : word !== undefined ? SCALES[word.toLowerCase()] : 1,
      dollar: token.startsWith("$"),
      pct: token.includes("%"),
      ...(timeWindow ? { windowDigits: token } : {}),
    });
  }
  return figures;
}

function walk(value: unknown, key: string | undefined, sources: FigureSource[]): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) sources.push({ value: Math.abs(value), ...(key !== undefined ? { key } : {}) });
  } else if (typeof value === "string") {
    const text = value.trim();
    if (WHOLLY_NUMERIC.test(text)) {
      sources.push({ value: Math.abs(Number(text.replace(/[$%,]/g, ""))), ...(key !== undefined ? { key } : {}) });
      return;
    }
    const date = ISO_DATE.exec(text);
    if (date && !Number.isNaN(Date.parse(text))) {
      for (const part of date.slice(1)) if (part !== undefined) sources.push({ value: Number(part) });
    }
  } else if (Array.isArray(value)) {
    for (const item of value) walk(item, key, sources);
  } else if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) walk(child, childKey, sources);
  }
}

// The sources of the check: the JSON the composer sends the LLM, and the free texts (the goal, the budget line).
export function collectFigureSources(data: unknown, texts: readonly string[]): FigureSource[] {
  const sources: FigureSource[] = [];
  walk(data, undefined, sources);
  for (const text of texts) {
    for (const figure of figuresOf(text)) {
      sources.push({ value: figure.value * figure.scale, ...(figure.dollar ? { dollar: true } : {}) });
    }
  }
  return sources;
}

const unitAgrees = (figure: Figure, source: FigureSource) =>
  figure.pct
    ? source.key !== undefined && source.key.endsWith("Pct")
    : figure.dollar
      ? source.dollar === true || (source.key !== undefined && source.key.includes("Usd"))
      : true;

function matches(figure: Figure, source: FigureSource): boolean {
  const tolerance = 0.5 * 10 ** -figure.decimals * figure.scale;
  const epsilon = 8 * Number.EPSILON * Math.max(1, source.value, figure.value * figure.scale);
  return unitAgrees(figure, source) && Math.abs(source.value - figure.value * figure.scale) <= tolerance + epsilon;
}

const isBareSmallInteger = (figure: Figure) =>
  !figure.dollar && !figure.pct && figure.scale === 1 && figure.decimals === 0 && figure.value <= 10;

// The maximal digit runs inside the sources' keys ("priceChange24hPct" → "24"), for the time-window rule (S6-A2).
const keyDigitRuns = (sources: readonly FigureSource[]) =>
  new Set(sources.flatMap((source) => (source.key === undefined ? [] : (source.key.match(/\d+/g) ?? []))));

export function checkReportFigures(text: string, sources: readonly FigureSource[]): ReportCheckResult {
  const windows = keyDigitRuns(sources);
  const unmatched = figuresOf(text)
    .filter(
      (figure) =>
        !isBareSmallInteger(figure) &&
        !(figure.windowDigits !== undefined && windows.has(figure.windowDigits)) &&
        !sources.some((source) => matches(figure, source)),
    )
    .map((figure) => figure.raw);
  return unmatched.length === 0 ? { ok: true } : { ok: false, unmatched };
}
