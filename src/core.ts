// Pure core for snow-depth-snowpack-snotel-mcp. The only I/O is keyless GET reads done through an injected fetchText.
//
// Sources (public, no key):
//   USDA NRCS AWDB REST API (SNOTEL network):  https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/
//     stations?stationTriplets=*:*:SNTL&activeOnly=true   every active SNOTEL station (about 920): name, state, county, elevation (ft), lat/lon
//     data?stationTriplets=<t1,t2 | *:CO:SNTL>&elements=SNWD,WTEQ&duration=DAILY&beginDate&endDate&centralTendencyType=MEDIAN
//       SNWD = snow depth (inches), WTEQ = snow water equivalent (inches). WTEQ values carry the 30-year median for the day and
//       timingCentralTendencies (median peak date and value, median onset and melt-out dates). Snow depth has no median.
//       A missing day comes back as {"date": ...} with no value; stations without data in the window are left out.
//   Open-Meteo geocoding (place names):       https://geocoding-api.open-meteo.com/v1/search?name=<place>
//   ZIP code centroid (phzmapi.org):           https://phzmapi.org/<zip>.json   (coordinates.lat / coordinates.lon)
//
// SNOTEL data are provisional, measured automatically at remote mountain sites. They are not ski resort snow reports.
import type { FetchText } from './types.js';

export const REPO = 'snow-depth-snowpack-snotel-mcp';
export const SITE = 'https://www.mcpstamp.com';
export const UTM = `utm_source=mcp&utm_medium=${REPO}`;
export const more = () => `${SITE}/servers/?${UTM}`;

export const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
export const STATIONS_URL = `${AWDB}/stations?stationTriplets=*:*:SNTL&activeOnly=true`;
export const SOURCE = 'USDA NRCS SNOTEL network, AWDB REST API (wcc.sc.egov.usda.gov): daily snow depth and snow water equivalent, with the NRCS 30-year median of snow water equivalent. Provisional data from automated mountain sites, not ski resort reports.';
export const STATION_PAGE = (t: Station) => `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=${t.id}`;

export const STATIONS_TTL = 86400 * 7;
export const DATA_TTL = 3600;
export const PAST_TTL = 86400 * 30;
export const STATE_CHUNK = 30;

export class InputError extends Error {}
export class UpstreamError extends Error {}

const DAY = 86400000;
const r1 = (n: number) => Math.round(n * 10) / 10;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
export const inToCm = (n: number) => Math.round(n * 2.54);
const ftToM = (n: number) => Math.round(n * 0.3048);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY);
export const monthDay = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
const md = (m: number, d: number) => `${MONTHS[m - 1]} ${d}`;

/** SNOTEL reports on Pacific Standard Time (dataTimeZone -8, Alaska -9). "Today" is the PST calendar date. */
export const todayPST = (now: Date) => new Date(now.getTime() - 8 * 3600000).toISOString().slice(0, 10);

/** Water year (snow season) that contains a date: Oct 1 of the year before to Sep 30. 2026-11-17 is in water year 2027, the 2026-27 season. */
export const waterYearOf = (date: string) => (Number(date.slice(5, 7)) >= 10 ? Number(date.slice(0, 4)) + 1 : Number(date.slice(0, 4)));
export const seasonLabel = (wy: number) => `${wy - 1}-${String(wy).slice(2)}`;

// ---------- states ----------

export const STATES: Record<string, string> = {
  AK: 'Alaska', AZ: 'Arizona', CA: 'California', CO: 'Colorado', ID: 'Idaho', MT: 'Montana', NV: 'Nevada', NM: 'New Mexico',
  OR: 'Oregon', SD: 'South Dakota', UT: 'Utah', WA: 'Washington', WY: 'Wyoming',
};
const US_STATES: Record<string, string> = {
  ...STATES, AL: 'Alabama', AR: 'Arkansas', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', NE: 'Nebraska', NH: 'New Hampshire',
  NJ: 'New Jersey', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', TN: 'Tennessee', TX: 'Texas', VT: 'Vermont', VA: 'Virginia', WV: 'West Virginia', WI: 'Wisconsin',
};

export function stateCode(s: unknown): string {
  const q = String(s ?? '').trim();
  if (!q) throw new InputError('give a state, for example "CO" or "Colorado".');
  const up = q.toUpperCase();
  const code = US_STATES[up] ? up : Object.keys(US_STATES).find((k) => US_STATES[k].toLowerCase() === q.toLowerCase());
  if (!code) throw new InputError(`"${q}" is not a US state. SNOTEL states: ${Object.entries(STATES).map(([k, v]) => `${v} (${k})`).join(', ')}.`);
  if (!STATES[code]) throw new InputError(`${US_STATES[code]} has no SNOTEL stations. SNOTEL covers ${Object.values(STATES).join(', ')}.`);
  return code;
}

// ---------- stations ----------

export interface Station {
  triplet: string; id: string; state: string; name: string; county: string | null; elevation_ft: number; elevation_m: number;
  latitude: number; longitude: number; huc: string | null; since: string | null;
}

export function parseStations(body: string): Station[] {
  let d: any;
  try { d = JSON.parse(body); } catch { throw new UpstreamError('the NRCS AWDB station list is not JSON'); }
  if (!Array.isArray(d)) throw new UpstreamError('the NRCS AWDB station list has an unexpected shape');
  const out: Station[] = [];
  for (const s of d) {
    if (s?.networkCode !== 'SNTL') continue;
    const lat = Number(s.latitude), lon = Number(s.longitude), el = Number(s.elevation);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({
      triplet: String(s.stationTriplet), id: String(s.stationId), state: String(s.stateCode), name: String(s.name ?? '').trim(),
      county: s.countyName ?? null, elevation_ft: Math.round(el), elevation_m: ftToM(el), latitude: lat, longitude: lon,
      huc: s.huc ?? null, since: typeof s.beginDate === 'string' ? s.beginDate.slice(0, 10) : null,
    });
  }
  if (!out.length) throw new UpstreamError('the NRCS AWDB station list came back empty');
  return out;
}

export async function loadStations(f: FetchText): Promise<Station[]> {
  return parseStations(await f(STATIONS_URL, { cacheTtl: STATIONS_TTL, timeoutMs: 25000 }));
}

export function milesBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** A station by triplet ("335:CO:SNTL"), station id ("335") or name ("Berthoud Summit", optionally ", CO"). */
export function findStation(all: Station[], q: unknown): Station {
  let s = String(q ?? '').trim();
  if (!s) throw new InputError('give a station name, id or triplet, for example "Berthoud Summit" or "335:CO:SNTL".');
  const t = /^(\d+)(?::([A-Za-z]{2}))?(?::SNTL)?$/i.exec(s);
  if (t) {
    const hits = all.filter((x) => x.id === t[1] && (!t[2] || x.state === t[2].toUpperCase()));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new InputError(`no active SNOTEL station has id ${s}. Use snotel_stations to look one up.`);
    throw new InputError(`station id ${t[1]} exists in ${hits.map((x) => x.triplet).join(', ')}. Give the full triplet.`);
  }
  let state: string | null = null;
  const m = /^(.*?),\s*([A-Za-z .]+)$/.exec(s);
  if (m) {
    try { state = stateCode(m[2]); s = m[1]; } catch { /* not a state qualifier: keep the whole name */ }
  }
  const pool = state ? all.filter((x) => x.state === state) : all;
  const n = norm(s);
  const exact = pool.filter((x) => norm(x.name) === n);
  if (exact.length === 1) return exact[0];
  const partial = exact.length ? exact : pool.filter((x) => norm(x.name).includes(n));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new InputError(`no active SNOTEL station is named "${s}"${state ? ` in ${STATES[state]}` : ''}. Use snotel_stations to search by name, state or place.`);
  const list = partial.slice(0, 12).map((x) => `${x.name} (${x.triplet}, ${fmtInt(x.elevation_ft)} ft)`).join('; ');
  throw new InputError(`"${s}" matches ${partial.length} SNOTEL stations: ${list}${partial.length > 12 ? '; ...' : ''}. Give the triplet or add the state.`);
}

// ---------- places ----------

export interface Place { name: string; latitude: number; longitude: number; alternatives?: string[]; matched_qualifier?: boolean | null }
export interface PlaceInput { location?: unknown; latitude?: unknown; longitude?: unknown }

function checkLatLon(lat: number, lon: number) {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new InputError(`latitude ${lat} is out of range (-90 to 90).`);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) throw new InputError(`longitude ${lon} is out of range (-180 to 180).`);
}

export const hasPlace = (a: PlaceInput) =>
  (a.location !== undefined && a.location !== null && String(a.location).trim() !== '') ||
  (a.latitude !== undefined && a.latitude !== null && a.longitude !== undefined && a.longitude !== null);

/**
 * Resolve a place. Without a state or country qualifier the geocoder's first candidate is often the wrong town
 * ("Breckenridge" is Breckenridge, Texas first; "Alta" is Alta, Iowa), so a place close to a SNOTEL station wins.
 */
/** US places only: SNOTEL is a US network, and the country filter keeps foreign namesakes out of the 30 candidates. */
export const geocodeUrl = (name: string) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=30&language=en&format=json&countryCode=US`;

export async function resolvePlace(f: FetchText, a: PlaceInput, stations: Station[], maxMiles: number): Promise<Place> {
  if (a.latitude !== undefined && a.latitude !== null && a.longitude !== undefined && a.longitude !== null) {
    const lat = Number(a.latitude), lon = Number(a.longitude);
    checkLatLon(lat, lon);
    return { name: `${r4(lat)}, ${r4(lon)}`, latitude: lat, longitude: lon };
  }
  const loc = String(a.location ?? '').trim();
  if (!loc) throw new InputError('give a place ("Breckenridge, CO"), a US ZIP code, latitude and longitude, or a SNOTEL station.');
  const ll = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(loc);
  if (ll) {
    const lat = Number(ll[1]), lon = Number(ll[2]);
    checkLatLon(lat, lon);
    return { name: `${r4(lat)}, ${r4(lon)}`, latitude: lat, longitude: lon };
  }
  const zip = /^(\d{5})(-\d{4})?$/.exec(loc);
  if (zip) {
    let body: string;
    try { body = await f(`https://phzmapi.org/${zip[1]}.json`, { cacheTtl: 86400 * 30, timeoutMs: 15000 }); } catch (e) {
      if (/HTTP 404/.test((e as Error).message)) throw new InputError(`ZIP ${zip[1]} was not found. Try a nearby town name or latitude and longitude.`);
      throw e;
    }
    let d: any;
    try { d = JSON.parse(body); } catch { throw new UpstreamError('the ZIP lookup returned something that is not JSON'); }
    const lat = Number(d?.coordinates?.lat), lon = Number(d?.coordinates?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new UpstreamError(`no coordinates for ZIP ${zip[1]}`);
    return { name: `ZIP ${zip[1]}`, latitude: lat, longitude: lon };
  }
  const parts = loc.split(',').map((s) => s.trim()).filter(Boolean);
  const name = parts[0];
  const quals = parts.slice(1).map((q) => q.toLowerCase());
  const body = await f(geocodeUrl(name), { cacheTtl: 86400 * 30, timeoutMs: 15000 });
  let d: any;
  try { d = JSON.parse(body); } catch { throw new UpstreamError('the Open-Meteo geocoder returned something that is not JSON'); }
  const results: any[] = Array.isArray(d?.results) ? d.results : [];
  if (!results.length) throw new InputError(`no US place called "${name}" was found (SNOTEL is a US network). Try "Town, State", a US ZIP code, latitude and longitude, or a SNOTEL station name.`);
  const matches = (r: any, q: string): boolean => {
    const admin = String(r.admin1 ?? '').toLowerCase();
    const country = String(r.country ?? '').toLowerCase();
    const cc = String(r.country_code ?? '').toLowerCase();
    const st = US_STATES[q.toUpperCase()];
    if (st && cc === 'us' && admin === st.toLowerCase()) return true;
    return q === admin || q === country || q === cc || (q === 'usa' && cc === 'us') || (q.length > 3 && (admin.startsWith(q) || country.startsWith(q)));
  };
  let pool = results;
  let matched: boolean | null = null;
  if (quals.length) {
    const hit = results.filter((r) => quals.every((q) => matches(r, q)));
    matched = hit.length > 0;
    if (hit.length) pool = hit;
  }
  // Among candidates with a SNOTEL station within maxMiles, an exact name match wins over a longer name (the town over
  // "Breckenridge Airport", the peak over "Mount Hood Parkdale"), then the one closest to a station (mountain places over namesakes).
  const gap = (r: any) => Math.min(...stations.map((s) => milesBetween(Number(r.latitude), Number(r.longitude), s.latitude, s.longitude)));
  const exact = (r: any) => (norm(String(r.name ?? '')) === norm(name) ? 0 : 1);
  const scored = pool.map((r) => ({ r, d: gap(r) })).filter((x) => x.d <= maxMiles).sort((x, y) => exact(x.r) - exact(y.r) || x.d - y.d);
  const pick = scored.length ? scored[0].r : pool[0];
  const lat = Number(pick.latitude), lon = Number(pick.longitude);
  checkLatLon(lat, lon);
  const labelOf = (r: any) => [r.name, r.admin1, r.country_code].filter((x: unknown) => x).join(', ');
  const alternatives = quals.length ? [] : results.filter((r) => r !== pick).slice(0, 5).map(labelOf);
  return { name: labelOf(pick), latitude: lat, longitude: lon, matched_qualifier: matched, ...(alternatives.length ? { alternatives } : {}) };
}

export interface NearStation extends Station { distance_mi: number }

export function nearest(stations: Station[], lat: number, lon: number, count: number, maxMiles: number): { within: NearStation[]; closest: NearStation | null } {
  const all = stations.map((s) => ({ ...s, distance_mi: r1(milesBetween(lat, lon, s.latitude, s.longitude)) })).sort((a, b) => a.distance_mi - b.distance_mi);
  return { within: all.filter((s) => s.distance_mi <= maxMiles).slice(0, count), closest: all[0] ?? null };
}

// ---------- data ----------

export interface Point { date: string; value: number | null; median: number | null }
export interface Timing { median_peak_date: string | null; median_peak_swe_in: number | null; median_onset_date: string | null; median_meltout_date: string | null }
export interface StationData { snwd: Point[]; wteq: Point[]; timing: Timing | null }

export const dataUrl = (triplets: string[], begin: string, end: string) =>
  `${AWDB}/data?stationTriplets=${triplets.join(',')}&elements=SNWD,WTEQ&duration=DAILY&beginDate=${begin}&endDate=${end}&centralTendencyType=MEDIAN`;

export function parseData(body: string): Map<string, StationData> {
  let d: any;
  try { d = JSON.parse(body); } catch { throw new UpstreamError('the NRCS AWDB data answer is not JSON'); }
  if (!Array.isArray(d)) throw new UpstreamError('the NRCS AWDB data answer has an unexpected shape');
  const out = new Map<string, StationData>();
  for (const s of d) {
    const sd: StationData = { snwd: [], wteq: [], timing: null };
    for (const e of Array.isArray(s?.data) ? s.data : []) {
      const code = e?.stationElement?.elementCode;
      const pts: Point[] = (Array.isArray(e?.values) ? e.values : []).map((v: any) => ({
        date: String(v?.date ?? '').slice(0, 10),
        value: typeof v?.value === 'number' && Number.isFinite(v.value) ? v.value : null,
        median: typeof v?.median === 'number' && Number.isFinite(v.median) ? v.median : null,
      })).filter((p: Point) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
      if (code === 'SNWD') sd.snwd = pts;
      if (code === 'WTEQ') {
        sd.wteq = pts;
        const t = e?.timingCentralTendencies;
        if (t) {
          const mdOf = (x: any) => (x && x.month ? md(Number(x.month), Number(x.day)) : null);
          sd.timing = {
            median_peak_date: mdOf(t.medianPeak), median_peak_swe_in: typeof t.medianPeak?.value === 'number' ? r1(t.medianPeak.value) : null,
            median_onset_date: mdOf(t.medianOnset), median_meltout_date: mdOf(t.medianMeltout),
          };
        }
      }
    }
    out.set(String(s?.stationTriplet), sd);
  }
  return out;
}

const lastValued = (pts: Point[]) => { for (let i = pts.length - 1; i >= 0; i--) if (pts[i].value !== null) return pts[i]; return null; };
const valueOn = (pts: Point[], date: string) => pts.find((p) => p.date === date && p.value !== null)?.value ?? null;

export interface Snapshot {
  date: string | null; days_old: number | null;
  snow_depth_in: number | null; snow_depth_cm: number | null; snow_depth_date: string | null;
  depth_change_24h_in: number | null; depth_change_7d_in: number | null;
  swe_in: number | null; swe_date: string | null; median_swe_in: number | null; pct_of_median: number | null; swe_change_7d_in: number | null;
  median: Timing | null;
}

export function snapshot(sd: StationData | undefined, today: string): Snapshot {
  const d = lastValued(sd?.snwd ?? []);
  const w = lastValued(sd?.wteq ?? []);
  const date = [d?.date, w?.date].filter(Boolean).sort().pop() ?? null;
  const diff = (pts: Point[], p: Point | null, n: number) => {
    if (!p || p.value === null) return null;
    const prev = valueOn(pts, addDays(p.date, -n));
    return prev === null ? null : r1(p.value - prev);
  };
  const med = w && w.median !== null ? w.median : null;
  return {
    date, days_old: date ? dayDiff(today, date) : null,
    snow_depth_in: d ? d.value : null, snow_depth_cm: d && d.value !== null ? inToCm(d.value) : null, snow_depth_date: d?.date ?? null,
    depth_change_24h_in: diff(sd?.snwd ?? [], d, 1), depth_change_7d_in: diff(sd?.snwd ?? [], d, 7),
    swe_in: w ? w.value : null, swe_date: w?.date ?? null, median_swe_in: med,
    pct_of_median: w && w.value !== null && med !== null && med > 0 ? Math.round((w.value / med) * 100) : null,
    swe_change_7d_in: diff(sd?.wteq ?? [], w, 7),
    median: sd?.timing ?? null,
  };
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function describe(s: Snapshot): string {
  if (!s.date) return 'no snow depth or snow water equivalent reported in the last week';
  const bits: string[] = [];
  if (s.snow_depth_in !== null) {
    let t = s.snow_depth_in > 0 ? `snow depth ${s.snow_depth_in} in (${s.snow_depth_cm} cm)` : 'no snow on the ground (depth 0 in)';
    const ch: string[] = [];
    if (s.depth_change_24h_in !== null) ch.push(`${signed(s.depth_change_24h_in)} in in 24 h`);
    if (s.depth_change_7d_in !== null) ch.push(`${signed(s.depth_change_7d_in)} in in 7 days`);
    if (ch.length) t += ` (${ch.join(', ')})`;
    bits.push(t);
  }
  if (s.swe_in !== null) {
    let t = `snow water equivalent ${s.swe_in} in`;
    if (s.pct_of_median !== null) t += `, ${s.pct_of_median}% of the 30-year median (${s.median_swe_in} in) for the date`;
    else if (s.median_swe_in === 0) t += ' (the 30-year median for the date is 0, so there is no percent)';
    bits.push(t);
  }
  return `${bits.join('; ')}, on ${s.date}${s.days_old !== null && s.days_old > 2 ? ` (no newer report; ${s.days_old} days old)` : ''}`;
}

async function readData(f: FetchText, triplets: string[], begin: string, end: string, ttl: number) {
  return parseData(await f(dataUrl(triplets, begin, end), { cacheTtl: ttl, timeoutMs: 25000 }));
}

const stationLabel = (s: Station) => `${s.name}, ${STATES[s.state] ?? s.state} (${s.triplet}, ${fmtInt(s.elevation_ft)} ft)`;
const stationRow = (s: Station) => ({
  name: s.name, triplet: s.triplet, state: s.state, county: s.county, elevation_ft: s.elevation_ft, elevation_m: s.elevation_m,
  latitude: s.latitude, longitude: s.longitude, ...('distance_mi' in s ? { distance_mi: (s as NearStation).distance_mi } : {}),
  station_page: STATION_PAGE(s),
});

// ---------- tools ----------

export interface SnowDepthArgs extends PlaceInput { station?: unknown; count?: number; max_miles?: number }

export async function snowDepth(f: FetchText, a: SnowDepthArgs, now = new Date()) {
  const today = todayPST(now);
  const count = Math.min(Math.max(Math.trunc(Number(a.count ?? 3)) || 3, 1), 8);
  const maxMiles = Math.min(Math.max(Number(a.max_miles ?? 60) || 60, 1), 250);
  const stations = await loadStations(f);
  let place: Place | null = null;
  let picked: Station[];
  if (a.station !== undefined && a.station !== null && String(a.station).trim()) {
    picked = [findStation(stations, a.station)];
  } else {
    if (!hasPlace(a)) throw new InputError('give a place ("Breckenridge, CO"), a US ZIP code, latitude and longitude, or a SNOTEL station.');
    place = await resolvePlace(f, a, stations, maxMiles);
    const { within, closest } = nearest(stations, place.latitude, place.longitude, count, maxMiles);
    if (!within.length) {
      throw new InputError(`no SNOTEL station within ${maxMiles} miles of ${place.name}${closest ? `; the nearest is ${stationLabel(closest)}, ${closest.distance_mi} miles away (raise max_miles)` : ''}. ` +
        `SNOTEL measures mountain snow in ${Object.values(STATES).join(', ')}.`);
    }
    picked = within;
  }
  const data = await readData(f, picked.map((s) => s.triplet), addDays(today, -10), today, DATA_TTL);
  const rows = picked.map((s) => ({ ...stationRow(s), ...snapshot(data.get(s.triplet), today) }));
  const head = place ? `Nearest SNOTEL ${rows.length === 1 ? 'station' : 'stations'} to ${place.name}: ` : '';
  const lines = rows.map((r) => `${r.name}, ${r.state} (${fmtInt(r.elevation_ft)} ft${'distance_mi' in r ? `, ${r.distance_mi} mi` : ''}): ${describe(r)}`);
  const latest = rows.map((r) => r.date).filter(Boolean).sort().pop() ?? today;
  return {
    summary: `${head}${lines.join('. ')}.`,
    ...(place ? { place } : {}),
    stations: rows,
    note: 'SNOTEL sites are automated mountain weather stations (often near passes and ski areas, but not at them). Values are provisional daily readings; the 30-year median exists for snow water equivalent only.',
    as_of: latest,
    source: SOURCE,
    more: more(),
  };
}

export interface StateArgs { state?: unknown; sort?: 'depth' | 'pct_of_median' | 'swe' | 'elevation' | 'name'; top?: number }

export async function snowpackByState(f: FetchText, a: StateArgs, now = new Date()) {
  const today = todayPST(now);
  const st = stateCode(a.state);
  const top = Math.min(Math.max(Math.trunc(Number(a.top ?? 10)) || 10, 1), 200);
  const sort = a.sort ?? 'depth';
  const stations = (await loadStations(f)).filter((s) => s.state === st);
  // A statewide wildcard read (*:UT:SNTL) with medians took 18 to 22 s at AWDB (measured 2026-11-17); 36 named stations took about 5 s.
  // So the state is read as parallel chunks of STATE_CHUNK named stations (at most 5 reads for the largest state, Utah, 141).
  const chunks: string[][] = [];
  for (let i = 0; i < stations.length; i += STATE_CHUNK) chunks.push(stations.slice(i, i + STATE_CHUNK).map((s) => s.triplet));
  const parts = await Promise.all(chunks.map((c) => readData(f, c, addDays(today, -10), today, DATA_TTL)));
  const data = new Map<string, StationData>();
  for (const m of parts) for (const [k, v] of m) data.set(k, v);
  const rows = stations.map((s) => ({ ...stationRow(s), ...snapshot(data.get(s.triplet), today) }));
  const recent = rows.filter((r) => r.date !== null && (r.days_old ?? 99) <= 3);
  const withSnow = recent.filter((r) => (r.snow_depth_in ?? 0) > 0);
  const withMed = recent.filter((r) => r.swe_in !== null && r.median_swe_in !== null && r.median_swe_in > 0);
  const sumSwe = withMed.reduce((t, r) => t + (r.swe_in as number), 0);
  const sumMed = withMed.reduce((t, r) => t + (r.median_swe_in as number), 0);
  const index = withMed.length && sumMed > 0 ? Math.round((sumSwe / sumMed) * 100) : null;
  const pcts = withMed.map((r) => r.pct_of_median as number).sort((x, y) => x - y);
  const medianPct = pcts.length ? (pcts.length % 2 ? pcts[(pcts.length - 1) / 2] : Math.round((pcts[pcts.length / 2 - 1] + pcts[pcts.length / 2]) / 2)) : null;
  const zeroMedian = recent.filter((r) => r.median_swe_in === 0).length;
  const meds = withMed.map((r) => r.median_swe_in as number).sort((x, y) => x - y);
  const typicalMedian = meds.length ? meds[Math.floor(meds.length / 2)] : null;
  const smallMedians = typicalMedian !== null && typicalMedian < 3;
  const key: Record<string, (r: any) => number | string> = {
    depth: (r) => r.snow_depth_in ?? -1, swe: (r) => r.swe_in ?? -1, pct_of_median: (r) => r.pct_of_median ?? -1,
    elevation: (r) => r.elevation_ft, name: (r) => r.name,
  };
  const k = key[sort] ?? key.depth;
  const sorted = [...rows].sort((x, y) => (sort === 'name' ? String(k(x)).localeCompare(String(k(y))) : (k(y) as number) - (k(x) as number)));
  const deepest = [...recent].sort((x, y) => (y.snow_depth_in ?? -1) - (x.snow_depth_in ?? -1))[0];
  const latest = recent.map((r) => r.date as string).sort().pop() ?? today;
  const listed = sorted.slice(0, top).map((r) => `${r.name} ${r.snow_depth_in ?? 'n/a'} in${r.pct_of_median !== null ? ` (SWE ${r.pct_of_median}% of median)` : ''}`).join('; ');
  const summary =
    `${STATES[st]} SNOTEL snowpack as of ${latest}: ${recent.length} of ${stations.length} active stations reported in the last 3 days, ${withSnow.length} with snow on the ground. ` +
    (index !== null ? `Snow water equivalent is ${index}% of the 30-year median, summed over ${withMed.length} stations with a median above 0 (station median ${medianPct}%). ` : 'No station has a 30-year median above 0 for the date, so there is no percent of median yet. ') +
    (deepest && (deepest.snow_depth_in ?? 0) > 0 ? `Deepest: ${deepest.name} ${deepest.snow_depth_in} in. ` : '') +
    (zeroMedian ? `${zeroMedian} stations have a median of 0 for the date. ` : '') +
    (smallMedians ? `The typical median is only ${typicalMedian} in of SWE for the date (early or late season), so station percents swing widely; the summed percent is steadier. ` : '') +
    `By ${sort === 'pct_of_median' ? 'percent of median' : sort}: ${listed}.`;
  return {
    summary,
    state: st, state_name: STATES[st],
    active_stations: stations.length, reporting_last_3_days: recent.length, with_snow: withSnow.length,
    swe_pct_of_median: index, swe_pct_of_median_method: 'sum of current snow water equivalent / sum of the 30-year median for the date, over reporting stations whose median is above 0',
    stations_in_percent: withMed.length, station_median_pct_of_median: medianPct, stations_with_zero_median: zeroMedian, typical_median_swe_in: typicalMedian,
    sort, stations: sorted,
    as_of: latest,
    source: SOURCE,
    more: more(),
  };
}

export interface HistoryArgs extends PlaceInput { station?: unknown; season?: unknown }

export function parseSeason(s: unknown, today: string): number {
  const cur = waterYearOf(today);
  if (s === undefined || s === null || String(s).trim() === '' || String(s).trim().toLowerCase() === 'current') return cur;
  const q = String(s).trim().toLowerCase();
  if (q === 'last' || q === 'previous') return cur - 1;
  const m = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(q);
  if (!m) throw new InputError(`season "${s}" is not like "2025-26", "current" or "last".`);
  const start = Number(m[1]);
  const end = m[2].length === 2 ? Math.floor(start / 100) * 100 + Number(m[2]) + (Number(m[2]) < start % 100 ? 100 : 0) : Number(m[2]);
  if (end !== start + 1) throw new InputError(`season "${s}" must span two consecutive years, like "2025-26".`);
  if (end > cur) throw new InputError(`the ${seasonLabel(end)} season has not started; the current season is ${seasonLabel(cur)}.`);
  if (end < 1980) throw new InputError('SNOTEL daily records start around 1980.');
  return end;
}

function seasonStats(snwd: Point[], wteq: Point[]) {
  const d = snwd.filter((p) => p.value !== null) as { date: string; value: number }[];
  const w = wteq.filter((p) => p.value !== null) as { date: string; value: number; median: number | null }[];
  const peakD = d.reduce<{ date: string; value: number } | null>((b, p) => (!b || p.value > b.value ? p : b), null);
  const peakW = w.reduce<{ date: string; value: number } | null>((b, p) => (!b || p.value > b.value ? p : b), null);
  const first = d.find((p) => p.value > 0) ?? null;
  let meltout: string | null = null;
  if (peakW && peakW.value > 0) {
    const after = w.filter((p) => p.date > peakW.date);
    const z = after.find((p) => p.value === 0);
    meltout = z ? z.date : null;
  }
  return {
    peak_depth_in: peakD && peakD.value > 0 ? peakD.value : null, peak_depth_date: peakD && peakD.value > 0 ? peakD.date : null,
    peak_swe_in: peakW && peakW.value > 0 ? peakW.value : null, peak_swe_date: peakW && peakW.value > 0 ? peakW.date : null,
    first_snow_depth_date: first?.date ?? null, swe_meltout_date: meltout,
    days_with_snow: d.filter((p) => p.value > 0).length, days_reported: d.length,
  };
}

export async function snowDepthHistory(f: FetchText, a: HistoryArgs, now = new Date()) {
  const today = todayPST(now);
  const wy = parseSeason(a.season, today);
  const stations = await loadStations(f);
  let station: Station;
  let place: Place | null = null;
  if (a.station !== undefined && a.station !== null && String(a.station).trim()) station = findStation(stations, a.station);
  else {
    if (!hasPlace(a)) throw new InputError('give a SNOTEL station ("Berthoud Summit"), or a place to use its nearest station.');
    place = await resolvePlace(f, a, stations, 60);
    const { within, closest } = nearest(stations, place.latitude, place.longitude, 1, 60);
    if (!within.length) throw new InputError(`no SNOTEL station within 60 miles of ${place.name}${closest ? `; the nearest is ${stationLabel(closest)}, ${closest.distance_mi} miles away (pass it as station)` : ''}.`);
    station = within[0];
  }
  const begin = `${wy - 2}-10-01`;
  const seasonEnd = `${wy}-09-30`;
  const end = seasonEnd < today ? seasonEnd : today;
  const current = wy === waterYearOf(today);
  const data = (await readData(f, [station.triplet], begin, end, current ? DATA_TTL : PAST_TTL)).get(station.triplet);
  if (!data || (!data.snwd.length && !data.wteq.length)) throw new UpstreamError(`NRCS returned no daily data for ${station.name} (${station.triplet}) in ${seasonLabel(wy)} or the season before.`);
  const inSeason = (y: number) => (p: Point) => p.date >= `${y - 1}-10-01` && p.date <= `${y}-09-30`;
  const cur = { snwd: data.snwd.filter(inSeason(wy)), wteq: data.wteq.filter(inSeason(wy)) };
  const prev = { snwd: data.snwd.filter(inSeason(wy - 1)), wteq: data.wteq.filter(inSeason(wy - 1)) };
  const snap = snapshot({ snwd: cur.snwd, wteq: cur.wteq, timing: data.timing }, today);
  const s = seasonStats(cur.snwd, cur.wteq);
  const p = seasonStats(prev.snwd, prev.wteq);
  // Last season on the same calendar day as the latest reading.
  const ref = snap.date ?? end;
  const lastYearDate = `${Number(ref.slice(0, 4)) - 1}${ref.slice(4)}`;
  const lastYear = { date: lastYearDate, snow_depth_in: valueOn(prev.snwd, lastYearDate), swe_in: valueOn(prev.wteq, lastYearDate) };
  const byDate = new Map<string, { date: string; snow_depth_in: number | null; swe_in: number | null; median_swe_in: number | null }>();
  for (const x of cur.snwd) byDate.set(x.date, { date: x.date, snow_depth_in: x.value, swe_in: null, median_swe_in: null });
  for (const x of cur.wteq) {
    const r = byDate.get(x.date) ?? { date: x.date, snow_depth_in: null, swe_in: null, median_swe_in: null };
    r.swe_in = x.value; r.median_swe_in = x.median; byDate.set(x.date, r);
  }
  const daily = [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
  const weekly = daily.filter((_, i) => (daily.length - 1 - i) % 7 === 0).slice(-12);
  const tl = data.timing;
  const summary =
    `${stationLabel(station)}${place ? `, nearest SNOTEL station to ${place.name}` : ''}, ${seasonLabel(wy)} season${current ? ' so far' : ''}: ` +
    (current ? `${describe(snap)}. ` : '') +
    (s.peak_depth_in !== null ? `Deepest ${s.peak_depth_in} in on ${s.peak_depth_date}; ` : 'No snow depth above 0 yet; ') +
    (s.peak_swe_in !== null ? `peak snow water equivalent ${s.peak_swe_in} in on ${s.peak_swe_date}${s.swe_meltout_date ? `, melted out ${s.swe_meltout_date}` : ''}. ` : 'no snow water equivalent above 0. ') +
    (current && lastYear.snow_depth_in !== null ? `A year earlier (${lastYear.date}): depth ${lastYear.snow_depth_in} in, SWE ${lastYear.swe_in ?? 'n/a'} in. ` : '') +
    `${seasonLabel(wy - 1)}: deepest ${p.peak_depth_in ?? 0} in${p.peak_depth_date ? ` on ${p.peak_depth_date}` : ''}, peak SWE ${p.peak_swe_in ?? 0} in${p.peak_swe_date ? ` on ${p.peak_swe_date}` : ''}. ` +
    (tl ? `30-year median: snow starts ${tl.median_onset_date}, peaks at ${tl.median_peak_swe_in} in SWE on ${tl.median_peak_date}, melts out ${tl.median_meltout_date}.` : 'This station has no 30-year median (too short a record).');
  return {
    summary,
    station: stationRow(station), ...(place ? { place } : {}),
    season: seasonLabel(wy), water_year: wy, season_start: `${wy - 1}-10-01`, season_end: seasonEnd,
    latest: current ? snap : null,
    this_season: s, last_season: { season: seasonLabel(wy - 1), ...p }, same_day_last_year: current ? lastYear : null,
    median_timing: tl,
    weekly, daily,
    as_of: daily.length ? daily[daily.length - 1].date : end,
    source: SOURCE,
    more: more(),
  };
}

export interface StationsArgs extends PlaceInput { state?: unknown; name?: unknown; county?: unknown; max_miles?: number; min_elevation_ft?: number; limit?: number }

export async function snotelStations(f: FetchText, a: StationsArgs) {
  const limit = Math.min(Math.max(Math.trunc(Number(a.limit ?? 20)) || 20, 1), 200);
  const maxMiles = Math.min(Math.max(Number(a.max_miles ?? 50) || 50, 1), 250);
  let list: (Station | NearStation)[] = await loadStations(f);
  const all = list as Station[];
  const filters: string[] = [];
  let place: Place | null = null;
  if (a.state !== undefined && a.state !== null && String(a.state).trim()) {
    const st = stateCode(a.state); list = list.filter((s) => s.state === st); filters.push(`in ${STATES[st]}`);
  }
  if (a.county !== undefined && a.county !== null && String(a.county).trim()) {
    const c = norm(String(a.county).replace(/\bcounty\b/i, '')); list = list.filter((s) => norm(s.county ?? '').includes(c)); filters.push(`in ${String(a.county).trim()} County`);
  }
  if (a.name !== undefined && a.name !== null && String(a.name).trim()) {
    const n = norm(String(a.name)); list = list.filter((s) => norm(s.name).includes(n)); filters.push(`named like "${String(a.name).trim()}"`);
  }
  if (a.min_elevation_ft !== undefined && a.min_elevation_ft !== null) {
    const m = Number(a.min_elevation_ft); list = list.filter((s) => s.elevation_ft >= m); filters.push(`at or above ${fmtInt(m)} ft`);
  }
  if (hasPlace(a)) {
    place = await resolvePlace(f, a, all, maxMiles);
    const p = place;
    list = list.map((s) => ({ ...s, distance_mi: r1(milesBetween(p.latitude, p.longitude, s.latitude, s.longitude)) }))
      .filter((s) => s.distance_mi <= maxMiles).sort((x, y) => x.distance_mi - y.distance_mi);
    filters.push(`within ${maxMiles} miles of ${p.name}`);
  } else list = [...list].sort((x, y) => x.state.localeCompare(y.state) || x.name.localeCompare(y.name));
  if (!filters.length) throw new InputError('give at least one of state, name, county, min_elevation_ft or a place.');
  const rows = list.slice(0, limit).map(stationRow);
  const shown = rows.slice(0, 15).map((r) => `${r.name} (${r.triplet}, ${fmtInt(r.elevation_ft)} ft${'distance_mi' in r ? `, ${r.distance_mi} mi` : ''})`).join('; ');
  return {
    summary: list.length
      ? `${list.length} active SNOTEL ${list.length === 1 ? 'station' : 'stations'} ${filters.join(', ')}${list.length > rows.length ? ` (first ${rows.length} listed)` : ''}: ${shown}${rows.length > 15 ? '; ...' : ''}.`
      : `No active SNOTEL station ${filters.join(', ')}. SNOTEL covers ${Object.values(STATES).join(', ')}.`,
    ...(place ? { place } : {}),
    count: list.length, stations: rows,
    as_of: 'active station list (NRCS AWDB)',
    source: SOURCE,
    more: more(),
  };
}
