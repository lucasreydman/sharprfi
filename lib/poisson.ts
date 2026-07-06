export const LEAGUE_AVG_FIP = 3.80
export const LEAGUE_AVG_K_PCT = 0.23
export const LEAGUE_AVG_BARREL_PCT = 8.0
export const LEAGUE_AVG_OBP = 0.310
export const BASE_LAMBDA = 0.3371
export const FIP_CONSTANT = 3.10
export const LEAGUE_AVG_HARD_HIT_PCT = 38.0
export const PITCHER_FIP_STABILIZATION_IP = 45
export const PITCHER_K_STABILIZATION_BF = 150
export const TEAM_OBP_STABILIZATION_PA = 600
export const SAVANT_STABILIZATION_IP = 50
export const TOP_OF_ORDER_OBP_STABILIZATION_PA = 180

const FIP_FACTOR_WEIGHT = 0.55
const BARREL_FACTOR_WEIGHT = 0.35
const OBP_FACTOR_WEIGHT = 0.70
const TOP_OF_ORDER_FACTOR_WEIGHT = 0.45
const PARK_FACTOR_WEIGHT = 0.50
const WEATHER_FACTOR_WEIGHT = 0.50
const MIN_ADJUSTMENT_FACTOR = 0.55
const MAX_ADJUSTMENT_FACTOR = 1.55

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function shrinkTowardAverage(
  value: number,
  average: number,
  sampleSize: number,
  stabilizationSample: number,
): number {
  if (!Number.isFinite(value)) return average
  if (sampleSize <= 0 || stabilizationSample <= 0) return average

  const weight = sampleSize / (sampleSize + stabilizationSample)
  return average + (value - average) * weight
}

export function stabilizationMultiplierForDate(date: string): number {
  const parsed = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return 1

  const year = parsed.getUTCFullYear()
  const openingWindowStart = Date.UTC(year, 2, 15)
  const stabilizationFloorDate = Date.UTC(year, 6, 1)
  const progress = clamp(
    (parsed.getTime() - openingWindowStart) / (stabilizationFloorDate - openingWindowStart),
    0,
    1,
  )

  return 1.75 - 0.75 * progress
}

export function dateAdjustedStabilizationSample(baseSample: number, date?: string): number {
  if (!date) return baseSample
  return baseSample * stabilizationMultiplierForDate(date)
}

export function tempFactor(tempF: number): number {
  if (tempF < 55) return 0.92
  if (tempF > 80) return 1.06
  return 1.00
}

export function windFactor(
  windSpeedMph: number,
  windFromDegrees: number,
  outfieldFacingDegrees: number,
): number {
  if (windSpeedMph < 10) return 1.00

  let delta = Math.abs(windFromDegrees - outfieldFacingDegrees) % 360
  if (delta > 180) delta = 360 - delta

  if (delta <= 45) return 0.93   // blowing in
  if (delta >= 135) return 1.08  // blowing out
  return 1.00                    // crosswind
}

export interface LambdaParams {
  pitcherFip: number
  pitcherKPct: number        // 0–1 scale
  pitcherBarrelRate: number  // 0–100 scale
  teamOBP: number
  topOfOrderOBP?: number
  parkFactor: number
  tempF: number
  windSpeedMph: number
  windFromDegrees: number
  outfieldFacingDegrees: number
}

export function computeLambda(params: LambdaParams): number {
  const {
    pitcherFip,
    pitcherKPct,
    pitcherBarrelRate,
    teamOBP,
    topOfOrderOBP,
    parkFactor,
    tempF,
    windSpeedMph,
    windFromDegrees,
    outfieldFacingDegrees,
  } = params

  const fipFactor = Math.pow(pitcherFip / LEAGUE_AVG_FIP, FIP_FACTOR_WEIGHT)

  const rawKFactor = 1 + 0.3 * (LEAGUE_AVG_K_PCT - pitcherKPct) / LEAGUE_AVG_K_PCT
  const kFactor = Math.max(0.85, Math.min(1.15, rawKFactor))

  const barrelFactor = Math.pow(pitcherBarrelRate / LEAGUE_AVG_BARREL_PCT, BARREL_FACTOR_WEIGHT)

  const obpFactor = Math.pow(teamOBP / LEAGUE_AVG_OBP, OBP_FACTOR_WEIGHT)
  const topOfOrderRatio = topOfOrderOBP && teamOBP > 0
    ? clamp(topOfOrderOBP / teamOBP, 0.90, 1.12)
    : 1
  const topOfOrderFactor = Math.pow(topOfOrderRatio, TOP_OF_ORDER_FACTOR_WEIGHT)

  const tf = tempFactor(tempF)
  const wf = windFactor(windSpeedMph, windFromDegrees, outfieldFacingDegrees)
  const parkAdjustment = Math.pow(parkFactor, PARK_FACTOR_WEIGHT)
  const weatherAdjustment = Math.pow(tf * wf, WEATHER_FACTOR_WEIGHT)
  const combinedAdjustment = clamp(
    fipFactor * kFactor * barrelFactor * obpFactor * topOfOrderFactor * parkAdjustment * weatherAdjustment,
    MIN_ADJUSTMENT_FACTOR,
    MAX_ADJUSTMENT_FACTOR,
  )

  return BASE_LAMBDA * combinedAdjustment
}

export function computeYrfiProbability(lambdaHome: number, lambdaAway: number): number {
  const pHomeScores0 = Math.exp(-lambdaHome)
  const pAwayScores0 = Math.exp(-lambdaAway)
  return 1 - pHomeScores0 * pAwayScores0
}

export function computeNrfiProbability(lambdaHome: number, lambdaAway: number): number {
  // P(NRFI) = P(home scores 0) × P(away scores 0) = e^(-λH) × e^(-λA)
  return Math.exp(-lambdaHome) * Math.exp(-lambdaAway)
}

export function breakEvenOdds(p: number): number {
  if (p >= 0.5) return -Math.ceil((100 * p) / (1 - p))
  return Math.ceil((100 * (1 - p)) / p)
}

export function formatOdds(odds: number, estimated: boolean): string {
  // -100 is even money — display as +100
  const display = odds === -100 ? '+100' : odds > 0 ? `+${odds}` : `${odds}`
  const prefix = estimated ? '~' : ''
  return `${prefix}${display} or better`
}
