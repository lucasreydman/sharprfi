import { NextRequest, NextResponse } from 'next/server'
import { kvGet, kvSet } from '@/lib/kv'
import { fetchSchedule } from '@/lib/mlb-api'
import { fetchGameLineupStats, fetchPitcherModelStats, fetchTeamOffenseStats, fetchLinescore, fetchHandedness, fetchTeamWinStreaks, type SimLineupBatter } from '@/lib/mlb-api'
import { simulateGame, streakFactorForWinStreak, type SimBatter, type SimPitcher } from '@/lib/sim'
import { HEADLINE_MODEL, SIM_USE_STREAKS } from '@/lib/model-config'
import { loadSavantStore, getSavantStats } from '@/lib/savant-api'
import { fetchWeather, getOutfieldFacingDegrees } from '@/lib/weather-api'
import { getParkFactor } from '@/lib/park-factors'
import { getGameStatus, computeFirstInningResult } from '@/lib/game-status'
import {
  computeLambda,
  computeYrfiProbability,
  breakEvenOdds,
  LEAGUE_AVG_FIP,
  LEAGUE_AVG_K_PCT,
  LEAGUE_AVG_BARREL_PCT,
  LEAGUE_AVG_OBP,
  LEAGUE_AVG_HARD_HIT_PCT,
} from '@/lib/poisson'
import type { GameResult, GamesResponse, PitcherStats } from '@/lib/types'

const RESPONSE_TTL_SECONDS = 300 // 5 minutes
const RESPONSE_CACHE_VERSION = 'v4'

function getPacificDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date())
}

function seasonForDate(date: string): number {
  const parsedYear = parseInt(date.slice(0, 4), 10)
  if (!Number.isNaN(parsedYear)) return parsedYear

  const pacificDate = getPacificDate()
  return parseInt(pacificDate.split('-')[0], 10)
}

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date') ?? getPacificDate()
  const forceRefresh = req.nextUrl.searchParams.get('force') === '1'

  // KV cache check
  const cacheKey = `games-response:${RESPONSE_CACHE_VERSION}:${date}`
  if (!forceRefresh) {
    const cached = await kvGet<GamesResponse>(cacheKey)
    if (cached) return NextResponse.json(cached)
  }

  try {
    const season = seasonForDate(date)
    const games = await fetchSchedule(date)

    if (games.length === 0) {
      const response: GamesResponse = { date, games: [], generatedAt: new Date().toISOString() }
      await kvSet(cacheKey, response, RESPONSE_TTL_SECONDS)
      return NextResponse.json(response)
    }

    // Load Savant store once for all pitchers
    const savantStore = await loadSavantStore(season)

    // Fetch weather for all venues in parallel
    const venueIds = [...new Set(games.map(g => g.venue.id))]
    const weatherByVenue = new Map<number, Awaited<ReturnType<typeof fetchWeather>>>()
    await Promise.all(
      venueIds.map(async venueId => {
        const game = games.find(g => g.venue.id === venueId)!
        const weather = await fetchWeather(venueId, game.gameDate)
        weatherByVenue.set(venueId, weather)
      })
    )

    // Fetch pitcher stats and team OBP in parallel (batch)
    const pitcherIds = [
      ...new Set(
        games.flatMap(g => {
          const ids = [g.teams.home.probablePitcher?.id, g.teams.away.probablePitcher?.id]
          return ids.filter((id): id is number => id !== undefined)
        })
      )
    ]
    const teamIds = [...new Set(games.flatMap(g => [g.teams.home.team.id, g.teams.away.team.id]))]

    const [pitcherStats, teamOBPs, lineupStats] = await Promise.all([
      Promise.all(pitcherIds.map(async id => ({ id, stats: await fetchPitcherModelStats(id, season, date) }))),
      Promise.all(teamIds.map(async id => ({ id, stats: await fetchTeamOffenseStats(id, season, date) }))),
      Promise.all(games.map(async game => ({ gamePk: game.gamePk, stats: await fetchGameLineupStats(game.gamePk, date) }))),
    ])

    const pitcherStatsMap = new Map(pitcherStats.map(p => [p.id, p.stats]))
    const teamOBPMap = new Map(teamOBPs.map(t => [t.id, t.stats]))
    const lineupStatsMap = new Map(lineupStats.map(entry => [entry.gamePk, entry.stats]))

    // Sim engine inputs: one batched handedness lookup for every batter and
    // pitcher on the slate, plus (optionally) team win streaks
    const slatePersonIds = [
      ...pitcherIds,
      ...lineupStats.flatMap(entry =>
        [...entry.stats.home.simBatters, ...entry.stats.away.simBatters].map(b => b.personId)
      ),
    ]
    const [handednessMap, winStreaks] = await Promise.all([
      fetchHandedness(slatePersonIds),
      SIM_USE_STREAKS ? fetchTeamWinStreaks(season) : Promise.resolve({} as Record<number, number>),
    ])

    // Build results
    const results: GameResult[] = await Promise.all(
      games.map(async (game): Promise<GameResult> => {
        const gameStatus = getGameStatus(game.status.detailedState)
        const venueId = game.venue.id
        const weather = weatherByVenue.get(venueId) ?? {
          tempF: 72,
          windSpeedMph: 0,
          windFromDegrees: 0,
          failure: false,
          controlled: false,
        }
        const parkFactor = getParkFactor(venueId)
        const outfieldFacing = getOutfieldFacingDegrees(venueId)

        function buildPitcherStats(
          pitcher: { id: number; fullName: string } | undefined,
        ): PitcherStats {
          if (!pitcher) {
            return {
              playerId: 0, name: 'TBD',
              fip: LEAGUE_AVG_FIP, kPct: LEAGUE_AVG_K_PCT,
              barrelRate: LEAGUE_AVG_BARREL_PCT, hardHitRate: LEAGUE_AVG_HARD_HIT_PCT,
              confirmed: false,
              estimated: true,
            }
          }
          const stats = pitcherStatsMap.get(pitcher.id) ?? {
            fip: LEAGUE_AVG_FIP,
            kPct: LEAGUE_AVG_K_PCT,
            inningsPitched: 0,
            battersFaced: 0,
            usedFallback: true,
          }
          const savant = getSavantStats(pitcher.id, savantStore, date)
          return {
            playerId: pitcher.id, name: pitcher.fullName,
            fip: stats.fip, kPct: stats.kPct,
            barrelRate: savant.barrelRate, hardHitRate: savant.hardHitRate,
            confirmed: true,
            estimated: stats.usedFallback || savant.usedFallback,
          }
        }

        const homePitcher = buildPitcherStats(game.teams.home.probablePitcher)
        const awayPitcher = buildPitcherStats(game.teams.away.probablePitcher)
        const homeOffense = teamOBPMap.get(game.teams.home.team.id) ?? {
          obp: LEAGUE_AVG_OBP,
          plateAppearances: 0,
          usedFallback: true,
        }
        const awayOffense = teamOBPMap.get(game.teams.away.team.id) ?? {
          obp: LEAGUE_AVG_OBP,
          plateAppearances: 0,
          usedFallback: true,
        }
        const homeOBP = homeOffense.obp
        const awayOBP = awayOffense.obp
        const lineupStats = lineupStatsMap.get(game.gamePk)
        const homeTopOfOrderOBP = lineupStats?.home.topOfOrderOBP ?? null
        const awayTopOfOrderOBP = lineupStats?.away.topOfOrderOBP ?? null
        const lineupConfirmed = (lineupStats?.home.confirmed ?? false) && (lineupStats?.away.confirmed ?? false)

        const sharedEnv = {
          parkFactor,
          tempF: weather.failure || weather.controlled ? 72 : weather.tempF,
          windSpeedMph: weather.failure || weather.controlled ? 0 : weather.windSpeedMph,
          windFromDegrees: weather.failure || weather.controlled ? 0 : weather.windFromDegrees,
          outfieldFacingDegrees: outfieldFacing,
        }

        // Home team bats against away pitcher
        const lambdaHome = computeLambda({
          pitcherFip: awayPitcher.fip,
          pitcherKPct: awayPitcher.kPct,
          pitcherBarrelRate: awayPitcher.barrelRate,
          teamOBP: homeOBP,
          topOfOrderOBP: homeTopOfOrderOBP ?? undefined,
          ...sharedEnv,
        })

        // Away team bats against home pitcher
        const lambdaAway = computeLambda({
          pitcherFip: homePitcher.fip,
          pitcherKPct: homePitcher.kPct,
          pitcherBarrelRate: homePitcher.barrelRate,
          teamOBP: awayOBP,
          topOfOrderOBP: awayTopOfOrderOBP ?? undefined,
          ...sharedEnv,
        })

        const poissonYrfiProbability = computeYrfiProbability(lambdaHome, lambdaAway)

        // Monte Carlo sim engine (Francisco's model, fixed) — same matchup
        function toSimBatters(batters: SimLineupBatter[]): SimBatter[] {
          return batters.map(b => ({
            singles: b.singles,
            doubles: b.doubles,
            triples: b.triples,
            homeRuns: b.homeRuns,
            walks: b.walks,
            hitByPitch: b.hitByPitch,
            plateAppearances: b.plateAppearances,
            batSide: handednessMap[b.personId]?.batSide ?? null,
          }))
        }
        function toSimPitcher(pitcher: { id: number } | undefined): SimPitcher {
          const stats = pitcher ? pitcherStatsMap.get(pitcher.id) : undefined
          return {
            obpAllowed: stats?.obpAllowed ?? null,
            battersFaced: stats?.battersFaced ?? 0,
            pitchHand: pitcher ? handednessMap[pitcher.id]?.pitchHand ?? null : null,
          }
        }

        const sim = simulateGame({
          gamePk: game.gamePk,
          parkFactor,
          homeBatters: toSimBatters(lineupStats?.home.simBatters ?? []),
          awayBatters: toSimBatters(lineupStats?.away.simBatters ?? []),
          homePitcher: toSimPitcher(game.teams.home.probablePitcher),
          awayPitcher: toSimPitcher(game.teams.away.probablePitcher),
          homeStreakFactor: SIM_USE_STREAKS ? streakFactorForWinStreak(winStreaks[game.teams.home.team.id] ?? 0) : 1.0,
          awayStreakFactor: SIM_USE_STREAKS ? streakFactorForWinStreak(winStreaks[game.teams.away.team.id] ?? 0) : 1.0,
        })

        const yrfiProbability =
          HEADLINE_MODEL === 'sim' ? sim.simYrfiProbability :
          HEADLINE_MODEL === 'blend' ? (poissonYrfiProbability + sim.simYrfiProbability) / 2 :
          poissonYrfiProbability
        const odds = breakEvenOdds(yrfiProbability)

        let firstInningResult: GameResult['firstInningResult'] = 'pending'
        if (gameStatus === 'inProgress' || gameStatus === 'settled') {
          const linescore = await fetchLinescore(game.gamePk)
          firstInningResult = computeFirstInningResult(linescore)
        }

        return {
          gamePk: game.gamePk,
          gameTime: game.gameDate,
          gameStatus,
          venue: game.venue.name,
          venueId,
          homePitcher,
          awayPitcher,
          homeTeam: game.teams.home.team.name,
          awayTeam: game.teams.away.team.name,
          homeTeamId: game.teams.home.team.id,
          awayTeamId: game.teams.away.team.id,
          homeOBP,
          awayOBP,
          topOfOrderOBP: { home: homeTopOfOrderOBP, away: awayTopOfOrderOBP },
          parkFactor,
          lambda: { home: lambdaHome, away: lambdaAway },
          yrfiProbability,
          poissonYrfiProbability,
          simYrfiProbability: sim.simYrfiProbability,
          modelUsed: HEADLINE_MODEL,
          simDetails: { home: sim.home, away: sim.away },
          breakEvenOdds: odds,
          lineupConfirmed,
          lineupDetails: {
            home: lineupStats?.home.batters ?? [],
            away: lineupStats?.away.batters ?? [],
          },
          weather,
          firstInningResult,
        }
      })
    )

    // Sort by YRFI probability descending
    results.sort((a, b) => b.yrfiProbability - a.yrfiProbability)

    const response: GamesResponse = {
      date,
      games: results,
      generatedAt: new Date().toISOString(),
    }

    await kvSet(cacheKey, response, RESPONSE_TTL_SECONDS)
    return NextResponse.json(response)
  } catch (err) {
    console.error('[/api/games] error:', err)
    return NextResponse.json({ error: 'Failed to load games', status: 500 }, { status: 500 })
  }
}
