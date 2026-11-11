import { STADIUMS, fetchWeather, getStadiumConstants } from '@/lib/weather-api'

describe('getStadiumConstants', () => {
  it('returns Fenway Park constants for venueId 3', () => {
    const stadium = getStadiumConstants(3)
    expect(stadium).not.toBeNull()
    expect(stadium!.name).toContain('Fenway')
    expect(stadium!.outfieldFacingDegrees).toBeDefined()
  })

  it('returns null for unknown venueId', () => {
    expect(getStadiumConstants(99999)).toBeNull()
  })

  it('has all 30 stadiums defined', () => {
    expect(Object.keys(STADIUMS).length).toBe(30)
  })

  it('marks roofed parks as weather controlled', () => {
    expect(getStadiumConstants(12)?.weatherControlled).toBe(true)
    expect(getStadiumConstants(15)?.weatherControlled).toBe(true)
  })
})

describe('fetchWeather', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('asks for UTC hours and reads the one nearest first pitch', async () => {
    // A 7:10 PM Eastern first pitch at Fenway is 23:10 UTC. The temperature
    // in each slot is its own UTC hour, so the right answer is 23.
    const time = Array.from({ length: 24 }, (_, h) => `2020-07-06T${String(h).padStart(2, '0')}:00`)
    const hourly = {
      time,
      temperature_2m: time.map((_, h) => h),
      wind_speed_10m: time.map(() => 5),
      wind_direction_10m: time.map(() => 180),
    }
    let requested = ''
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      requested = String(input)
      return { ok: true, json: async () => ({ hourly }) } as Response
    }) as unknown as typeof fetch

    const weather = await fetchWeather(3, '2020-07-06T23:10:00Z')

    expect(new URL(requested).searchParams.get('timezone')).toBe('GMT')
    expect(weather.failure).toBe(false)
    expect(weather.tempF).toBe(23)
  })
})
