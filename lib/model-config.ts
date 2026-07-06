// Which engine's probability ships as the site's headline number.
// Decided by `npm run backtest -- <start> <end> --compare-sim` (Brier score,
// calibration gap as tiebreak) — see README "Model" section for the numbers.
export type HeadlineModel = 'poisson' | 'sim' | 'blend'

// 2026-03-26 → 2026-07-05 backtest, 1,344 games:
//   Blend Poisson+SimFixed  Brier 0.2447  calGap +1.2%   ← winner
//   Sim fixed (no streaks)  Brier 0.2463  calGap +3.5%
//   Poisson                 Brier 0.2476  calGap −1.1%
//   Sim + streak factors    Brier 0.2538  calGap +7.8%   (streaks hurt)
//   Faithful as-coded       Brier 0.2577  calGap −10.3%
export const HEADLINE_MODEL: HeadlineModel = 'blend'

// Streak multipliers hurt calibration in the backtest — keep off.
export const SIM_USE_STREAKS = false
