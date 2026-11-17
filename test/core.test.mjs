// Fixtures in test/fixtures/ were downloaded on 2026-11-17 through a Cloudflare Worker (the NRCS AWDB host does not answer this
// test machine's network directly): every active SNOTEL station in Colorado and Utah (fields trimmed), the Colorado-wide daily
// SNWD/WTEQ answer for 2026-11-07..2026-11-17 with medians, Berthoud Summit (335:CO:SNTL) from 2025-10-01 to 2026-11-17,
// two Open-Meteo geocoder answers (US only) and the phzmapi.org answer for ZIP 80424. Expected values were computed separately
// in Python from the same files (~/mcp-servers-work/s1117w4/snow/expect.py):
//   Breckenridge, CO: nearest Copper Mountain 7.1 mi (depth 0 on 11-15, 24 h 0, 7 d -1, SWE 0.3 = 16% of 1.9), Michigan Creek 7.5 mi
//   (depth 1 on 11-16, +1 / 0, SWE 0.4 = 22% of 1.8), Hoosier Pass 8.4 mi (depth 6, 0 / 0, SWE 1.4 = 47% of 3.0). ZIP 80424: Copper Mountain 7.2 mi.
//   Bare "Alta" picks Alta, Utah (0.2 mi from Atwater 1308:UT:SNTL). Colorado: 118 active, 118 reporting, 81 with snow, SWE index 72%
//   over 105 stations, station median 48%, deepest Beartown 33 in, then Wolf Creek Summit 28, Black Mesa 27.
//   Berthoud Summit 2026-27: deepest 2 in on 2026-11-02, peak SWE 0.7 on 2026-11-07, first snow 2026-10-14; 2025-26: deepest 52 in on
//   2026-03-06, peak SWE 12.2 on 2026-03-16, melted out 2026-05-13; 2025-11-15 depth 0, SWE 0.4; median onset Oct 24, peak 23.2 on May 3, melt-out Jun 12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  STATIONS_URL, AWDB, geocodeUrl, dataUrl, todayPST, waterYearOf, seasonLabel, parseSeason, stateCode, inToCm, parseStations, parseData,
  findStation, snapshot, snowDepth, snowpackByState, snowDepthHistory, snotelStations, InputError, UpstreamError, UTM,
} from '../dist/core.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const STATIONS = fx('stations-co-ut.json');
const CO = JSON.parse(fx('data-co-2026-11-07_2026-11-17.json'));
const H335 = fx('data-335-2025-10-01_2026-11-17.json');
const FILES = {
  [STATIONS_URL]: STATIONS,
  [geocodeUrl('Breckenridge')]: fx('geo-breckenridge.json'),
  [geocodeUrl('Alta')]: fx('geo-alta.json'),
  'https://phzmapi.org/80424.json': fx('zip-80424.json'),
  [dataUrl(['335:CO:SNTL'], '2025-10-01', '2026-11-17')]: H335,
};
const NOW = new Date('2026-11-17T16:00:00Z');
let seen = [];
// Serves the fixtures; a data call for named Colorado triplets in the 10-day window is answered from the statewide file, as AWDB would.
const f = async (u) => {
  seen.push(u);
  if (u in FILES) return FILES[u];
  const m = /^https:\/\/wcc\.sc\.egov\.usda\.gov\/awdbRestApi\/services\/v1\/data\?stationTriplets=([^&]+)&elements=SNWD,WTEQ&duration=DAILY&beginDate=2026-11-07&endDate=2026-11-17&centralTendencyType=MEDIAN$/.exec(u);
  if (m) {
    const ts = m[1].split(',');
    if (ts.length === 1 && ts[0] === '*:CO:SNTL') return JSON.stringify(CO);
    return JSON.stringify(CO.filter((s) => ts.includes(s.stationTriplet)));
  }
  throw new Error(`HTTP 404 (no fixture for ${u})`);
};

test('dates, seasons, states, units', () => {
  assert.equal(todayPST(new Date('2026-11-18T07:59:00Z')), '2026-11-17');
  assert.equal(todayPST(new Date('2026-11-18T08:00:00Z')), '2026-11-18');
  assert.equal(waterYearOf('2026-11-17'), 2027); assert.equal(waterYearOf('2026-09-30'), 2026); assert.equal(seasonLabel(2027), '2026-27');
  assert.equal(parseSeason(undefined, '2026-11-17'), 2027); assert.equal(parseSeason('last', '2026-11-17'), 2026);
  assert.equal(parseSeason('2025-26', '2026-11-17'), 2026); assert.equal(parseSeason('1999-00', '2026-11-17'), 2000); assert.equal(parseSeason('2024-2025', '2026-11-17'), 2025);
  assert.throws(() => parseSeason('2027-28', '2026-11-17'), InputError); assert.throws(() => parseSeason('2025-27', '2026-11-17'), InputError); assert.throws(() => parseSeason('winter', '2026-11-17'), InputError);
  assert.equal(stateCode('co'), 'CO'); assert.equal(stateCode('Colorado'), 'CO'); assert.equal(stateCode('New Mexico'), 'NM');
  assert.throws(() => stateCode('TX'), /no SNOTEL stations/); assert.throws(() => stateCode('Narnia'), InputError);
  assert.equal(inToCm(33), 84);
});

test('parse: station list, missing daily values, medians and timing', () => {
  const st = parseStations(STATIONS);
  assert.equal(st.length, 259); assert.equal(st.filter((s) => s.state === 'CO').length, 118);
  const b = st.find((s) => s.triplet === '335:CO:SNTL');
  assert.equal(b.name, 'Berthoud Summit'); assert.equal(b.elevation_ft, 11300); assert.equal(b.elevation_m, 3444);
  const d = parseData(H335).get('335:CO:SNTL');
  assert.equal(d.snwd.length, 411); assert.equal(d.wteq.length, 411);
  assert.deepEqual(d.wteq[d.wteq.length - 1], { date: '2026-11-15', value: 0.4, median: 2.4 });
  assert.deepEqual(d.timing, { median_peak_date: 'May 3', median_peak_swe_in: 23.2, median_onset_date: 'Oct 24', median_meltout_date: 'Jun 12' });
  const gaps = parseData(JSON.stringify(CO));
  const nulls = [...gaps.values()].flatMap((x) => [...x.snwd, ...x.wteq]).filter((p) => p.value === null).length;
  assert.ok(nulls >= 1, 'a day with only a date parses as value null');
  assert.throws(() => parseData('<html>'), UpstreamError);
  assert.throws(() => parseStations('[]'), UpstreamError);
  assert.equal(snapshot(undefined, '2026-11-17').date, null);
});

test('stations: triplet, id, exact and partial name, state qualifier, ambiguity', () => {
  const st = parseStations(STATIONS);
  assert.equal(findStation(st, '335:CO:SNTL').name, 'Berthoud Summit');
  assert.equal(findStation(st, '335').name, 'Berthoud Summit');
  assert.equal(findStation(st, 'berthoud summit').triplet, '335:CO:SNTL');
  assert.equal(findStation(st, 'Wolf Creek Summit, CO').triplet, '874:CO:SNTL');
  assert.equal(findStation(st, 'Hoosier').triplet, '531:CO:SNTL');
  assert.throws(() => findStation(st, 'Pass'), /matches \d+ SNOTEL stations/);
  assert.throws(() => findStation(st, 'Mount Nowhere'), InputError);
  assert.throws(() => findStation(st, '999999'), InputError);
});

test('snow_depth: Breckenridge, CO -> the three nearest stations with depth, changes and percent of median', async () => {
  seen = [];
  const r = await snowDepth(f, { location: 'Breckenridge, CO' }, NOW);
  assert.equal(r.place.name, 'Breckenridge, Colorado, US');
  assert.deepEqual(r.stations.map((s) => [s.name, s.distance_mi]), [['Copper Mountain', 7.1], ['Michigan Creek', 7.5], ['Hoosier Pass', 8.4]]);
  const [c, m, h] = r.stations;
  assert.deepEqual([c.snow_depth_in, c.snow_depth_date, c.depth_change_24h_in, c.depth_change_7d_in, c.swe_in, c.median_swe_in, c.pct_of_median], [0, '2026-11-15', 0, -1, 0.3, 1.9, 16]);
  assert.deepEqual([m.snow_depth_in, m.snow_depth_date, m.depth_change_24h_in, m.depth_change_7d_in, m.swe_in, m.median_swe_in, m.pct_of_median], [1, '2026-11-16', 1, 0, 0.4, 1.8, 22]);
  assert.deepEqual([h.snow_depth_in, h.depth_change_24h_in, h.depth_change_7d_in, h.swe_in, h.median_swe_in, h.pct_of_median, h.snow_depth_cm], [6, 0, 0, 1.4, 3, 47, 15]);
  assert.match(r.summary, /Hoosier Pass, CO \(11,600 ft, 8\.4 mi\): snow depth 6 in \(15 cm\) \(0 in in 24 h, 0 in in 7 days\); snow water equivalent 1\.4 in, 47% of the 30-year median \(3 in\) for the date, on 2026-11-15/);
  assert.match(r.summary, /Copper Mountain, CO .*no snow on the ground/);
  assert.equal(r.as_of, '2026-11-16');
  assert.equal(seen.length, 3, 'stations + geocoder + one data call');
  assert.ok(seen[1].includes('countryCode=US'));
  assert.ok(seen[2].includes('stationTriplets=415:CO:SNTL,937:CO:SNTL,531:CO:SNTL'));
  assert.ok(r.more.includes(UTM));
});

test('snow_depth: bare "Alta" is Alta, Utah; a ZIP; a station; nothing within the radius', async () => {
  const a = await snowDepth(f, { location: 'Alta', count: 1 }, NOW);
  assert.equal(a.place.name, 'Alta, Utah, US');
  assert.ok(a.place.alternatives.length > 0);
  assert.deepEqual([a.stations[0].triplet, a.stations[0].distance_mi], ['1308:UT:SNTL', 0.2]);
  const z = await snowDepth(f, { location: '80424', count: 1 }, NOW);
  assert.deepEqual([z.place.name, z.stations[0].name, z.stations[0].distance_mi], ['ZIP 80424', 'Copper Mountain', 7.2]);
  const s = await snowDepth(f, { station: 'Berthoud Summit' }, NOW);
  assert.equal(s.place, undefined);
  assert.deepEqual([s.stations[0].snow_depth_in, s.stations[0].swe_in, s.stations[0].pct_of_median], [0, 0.4, 17]);
  await assert.rejects(snowDepth(f, { latitude: 40.0, longitude: -75.2 }, NOW), /no SNOTEL station within 60 miles .*the nearest is/);
  await assert.rejects(snowDepth(f, {}, NOW), InputError);
});

test('snowpack_by_state: Colorado statewide percent of median, counts and ranking', async () => {
  seen = [];
  const r = await snowpackByState(f, { state: 'Colorado', top: 3 }, NOW);
  assert.deepEqual([r.active_stations, r.reporting_last_3_days, r.with_snow, r.stations_in_percent, r.swe_pct_of_median, r.station_median_pct_of_median, r.stations_with_zero_median],
    [118, 118, 81, 105, 72, 48, 0]);
  assert.deepEqual(r.stations.slice(0, 3).map((s) => [s.name, s.snow_depth_in]), [['Beartown', 33], ['Wolf Creek Summit', 28], ['Black Mesa', 27]]);
  assert.equal(r.stations.length, 118);
  assert.match(r.summary, /^Colorado SNOTEL snowpack as of 2026-11-16: 118 of 118 active stations reported in the last 3 days, 81 with snow on the ground\. Snow water equivalent is 72% of the 30-year median/);
  assert.match(r.summary, /Deepest: Beartown 33 in\./);
  assert.equal(seen.length, 5, 'stations + 4 parallel reads of up to 30 named stations');
  const asked = seen.slice(1).flatMap((u) => /stationTriplets=([^&]+)/.exec(u)[1].split(','));
  assert.equal(asked.length, 118); assert.equal(new Set(asked).size, 118);
  assert.equal(r.typical_median_swe_in, 2);
  assert.match(r.summary, /The typical median is only 2 in of SWE for the date \(early or late season\), so station percents swing widely/);
  const byPct = await snowpackByState(f, { state: 'CO', sort: 'pct_of_median' }, NOW);
  const p = byPct.stations.map((s) => s.pct_of_median ?? -1);
  assert.deepEqual(p, [...p].sort((x, y) => y - x));
  await assert.rejects(snowpackByState(f, { state: 'TX' }, NOW), /Texas has no SNOTEL stations/);
});

test('snow_depth_history: Berthoud Summit this season and last season', async () => {
  const r = await snowDepthHistory(f, { station: '335:CO:SNTL' }, NOW);
  assert.equal(r.season, '2026-27');
  assert.deepEqual([r.this_season.peak_depth_in, r.this_season.peak_depth_date, r.this_season.peak_swe_in, r.this_season.peak_swe_date, r.this_season.first_snow_depth_date, r.this_season.swe_meltout_date],
    [2, '2026-11-02', 0.7, '2026-11-07', '2026-10-14', null]);
  assert.deepEqual([r.this_season.days_with_snow, r.this_season.days_reported], [4, 46]);
  assert.deepEqual([r.last_season.season, r.last_season.peak_depth_in, r.last_season.peak_depth_date, r.last_season.peak_swe_in, r.last_season.peak_swe_date, r.last_season.swe_meltout_date, r.last_season.first_snow_depth_date],
    ['2025-26', 52, '2026-03-06', 12.2, '2026-03-16', '2026-05-13', '2025-10-05']);
  assert.deepEqual(r.same_day_last_year, { date: '2025-11-15', snow_depth_in: 0, swe_in: 0.4 });
  assert.equal(r.latest.pct_of_median, 17);
  assert.equal(r.daily[0].date, '2026-10-01'); assert.equal(r.daily[r.daily.length - 1].date, '2026-11-15');
  assert.ok(r.weekly.length <= 12 && r.weekly[r.weekly.length - 1].date === '2026-11-15');
  assert.match(r.summary, /30-year median: snow starts Oct 24, peaks at 23\.2 in SWE on May 3, melts out Jun 12\./);
  assert.match(r.summary, /2025-26: deepest 52 in on 2026-03-06, peak SWE 12\.2 in on 2026-03-16\./);
});

test('snotel_stations: by name and state, near a place, and no filter', async () => {
  const r = await snotelStations(f, { state: 'CO', name: 'summit' });
  assert.deepEqual(r.stations.map((s) => s.name), ['Berthoud Summit', 'Summit Ranch', 'Wolf Creek Summit']);
  assert.equal(r.stations[0].station_page, 'https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=335');
  const p = await snotelStations(f, { location: 'Breckenridge, CO', max_miles: 10 });
  assert.deepEqual(p.stations.slice(0, 3).map((s) => s.name), ['Copper Mountain', 'Michigan Creek', 'Hoosier Pass']);
  const passes = await snotelStations(f, { state: 'CO', name: 'pass', limit: 5 });
  assert.equal(passes.count, 16); assert.equal(passes.stations.length, 5);
  await assert.rejects(snotelStations(f, {}), InputError);
  assert.ok(AWDB.startsWith('https://wcc.sc.egov.usda.gov/'));
});

test('stdio: initialize, tools/list with annotations and a tools/call error over JSON-RPC (offline)', async () => {
  const child = spawn(process.execPath, [new URL('../dist/stdio.js', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = []; let buf = '';
  const got = (id) => new Promise((res) => { const iv = setInterval(() => { const m = lines.find((l) => l.id === id); if (m) { clearInterval(iv); res(m); } }, 10); });
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal((await got(1)).result.serverInfo.name, 'snow-depth-snowpack-snotel-mcp');
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  const tools = (await got(2)).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['snow_depth', 'snowpack_by_state', 'snow_depth_history', 'snotel_stations']);
  for (const t of tools) { assert.ok(t.title); assert.equal(t.annotations.readOnlyHint, true); assert.equal(t.annotations.destructiveHint, false); assert.equal(t.annotations.openWorldHint, true); }
  send({ id: 3, method: 'tools/call', params: { name: 'snowpack_by_state', arguments: { state: 'TX' } } });
  const r3 = await got(3);
  child.kill();
  assert.equal(r3.result?.isError ?? Boolean(r3.error), true);
});
