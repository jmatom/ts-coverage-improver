import { FileCoverage } from '@domain/coverage/FileCoverage';

/**
 * Parser for lcov.info — the de-facto cross-tool coverage format emitted by
 * Istanbul (Jest, Vitest, nyc, c8). The format is line-based, with per-file
 * records terminated by `end_of_record`.
 *
 * Fields we parse:
 *   SF:<path>            — source file path
 *   DA:<line>,<hits>     — line execution count
 *   LF:<found>           — total instrumented lines
 *   LH:<hit>             — lines with hits > 0
 *   BRF:<found>          — total branches
 *   BRH:<hit>            — branches taken
 *   FNF:<found>          — total functions
 *   FNH:<hit>            — functions called
 *
 * Anything else is ignored (BRDA, FN, FNDA, comments, etc).
 */
export class LcovParser {
  static parse(input: string): FileCoverage[] {
    const records: FileCoverage[] = [];
    let current: Mutable | null = null;

    for (const rawLine of input.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '') continue;
      if (line === 'end_of_record') {
        if (current !== null) {
          records.push(LcovParser.finalize(current));
          current = null;
        }
        continue;
      }
      if (line.startsWith('SF:')) {
        current = LcovParser.empty(line.slice(3));
        continue;
      }
      if (current === null) continue; // tolerate junk before first SF

      if (line.startsWith('DA:')) {
        const [lineStr, hitsStr] = line.slice(3).split(',', 2);
        const lineNum = Number(lineStr);
        const hits = Number(hitsStr);
        if (Number.isFinite(lineNum) && Number.isFinite(hits) && hits === 0) {
          current.uncoveredLines.push(lineNum);
        }
        continue;
      }
      if (line.startsWith('LF:')) current.lf = Number(line.slice(3));
      else if (line.startsWith('LH:')) current.lh = Number(line.slice(3));
      else if (line.startsWith('BRF:')) current.brf = Number(line.slice(4));
      else if (line.startsWith('BRH:')) current.brh = Number(line.slice(4));
      else if (line.startsWith('FNF:')) current.fnf = Number(line.slice(4));
      else if (line.startsWith('FNH:')) current.fnh = Number(line.slice(4));
    }

    // Tolerate trailing record without explicit end_of_record.
    if (current !== null) records.push(LcovParser.finalize(current));

    return records;
  }

  private static empty(path: string): Mutable {
    return {
      path,
      lf: 0,
      lh: 0,
      brf: 0,
      brh: 0,
      fnf: 0,
      fnh: 0,
      uncoveredLines: [],
    };
  }

  private static finalize(m: Mutable): FileCoverage {
    return FileCoverage.create({
      path: m.path,
      linesPct: pct(m.lh, m.lf),
      branchesPct: m.brf > 0 ? pct(m.brh, m.brf) : null,
      functionsPct: m.fnf > 0 ? pct(m.fnh, m.fnf) : null,
      uncoveredLines: m.uncoveredLines,
    });
  }
}

interface Mutable {
  path: string;
  lf: number;
  lh: number;
  brf: number;
  brh: number;
  fnf: number;
  fnh: number;
  uncoveredLines: number[];
}

function pct(num: number, denom: number): number {
  if (denom === 0) return 100;
  return Math.round((num / denom) * 10000) / 100; // 2dp
}
