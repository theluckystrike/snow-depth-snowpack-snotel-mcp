// Tool registry shared by the stdio and Worker entries.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { InputError, REPO, SITE, snowDepth, snowDepthHistory, snowpackByState, snotelStations } from './core.js';
import type { FetchText } from './types.js';

export const VERSION = '1.0.0';

export const META = {
  alias: 'snow-depth',
  metaDescription: 'MCP server for snow depth and snowpack: today\'s SNOTEL snow depth, snow water equivalent and percent of the 30-year median near any western US mountain place, statewide snowpack and season history, from USDA NRCS.',
  intro: 'Snow depth and snowpack for AI assistants, read live from about 920 USDA NRCS SNOTEL mountain stations in the western US and Alaska, updated daily.',
};

export const TOOL_INFO = [
  { name: 'snow_depth', blurb: 'Snow depth, snow water equivalent, percent of median and 24 h / 7 day change at the SNOTEL stations nearest a place, ZIP or station.' },
  { name: 'snowpack_by_state', blurb: 'Statewide SNOTEL snowpack: percent of median, stations with snow, deepest sites, every station ranked.' },
  { name: 'snow_depth_history', blurb: 'One station\'s season: daily snow depth and SWE against the median, peak, first snow, melt-out and last season.' },
  { name: 'snotel_stations', blurb: 'Find SNOTEL stations by state, name, county, elevation or distance from a place.' },
];

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: Record<string, unknown> & { summary: string }) {
  return { content: [{ type: 'text' as const, text: `${data.summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: 'text' as const, text: `${e instanceof InputError ? 'Error' : 'Upstream NRCS error'}: ${msg}` }] };
}
const wrap = <A>(fn: (a: A) => unknown) => async (a: A) => { try { return ok((await fn(a)) as any); } catch (e) { return fail(e); } };

const place = {
  location: z.string().optional().describe('A place ("Breckenridge, CO", "Mount Hood", "Alta, UT"), a US ZIP code, or "lat, lon".'),
  latitude: z.number().min(-90).max(90).optional().describe('Latitude, with longitude, instead of location.'),
  longitude: z.number().min(-180).max(180).optional().describe('Longitude, with latitude.'),
};
const station = z.string().optional().describe('A SNOTEL station name ("Berthoud Summit", "Berthoud Summit, CO"), id ("335") or triplet ("335:CO:SNTL"). Overrides location.');

export function createServer(fetchText: FetchText): McpServer {
  const server = new McpServer({ name: REPO, version: VERSION, websiteUrl: SITE } as any, {
    instructions:
      'Snow depth and snowpack from the USDA NRCS SNOTEL network, read at call time (daily, provisional). A model cannot know today\'s snow depth. ' +
      'Use snow_depth for "how much snow is on the ground near X", snowpack_by_state for "how is the snowpack in Colorado this year", snow_depth_history for one station\'s season and last season, ' +
      'and snotel_stations to find a station. SNOTEL sites are automated mountain stations, not ski resort snow reports; say so when the user asks about a resort.',
  });

  server.registerTool('snow_depth', {
    title: 'Snow depth near a place',
    description:
      'Current snow depth (inches and cm), snow water equivalent, SWE as a percent of the 30-year median for the date, and the 24-hour and 7-day change in depth at the SNOTEL stations nearest a place, ZIP code or coordinates, or at a named station. ' +
      'Each station has its elevation and distance. SNOTEL covers the mountains of AK, AZ, CA, CO, ID, MT, NV, NM, OR, SD, UT, WA and WY.',
    inputSchema: {
      ...place,
      station,
      count: z.number().int().min(1).max(8).optional().describe('How many nearest stations. Default 3.'),
      max_miles: z.number().min(1).max(250).optional().describe('Search radius in miles. Default 60.'),
    },
    annotations: { title: 'Snow depth near a place', ...RO },
  }, wrap((a: any) => snowDepth(fetchText, a)));

  server.registerTool('snowpack_by_state', {
    title: 'Snowpack by state',
    description:
      'Statewide snowpack from every active SNOTEL station in one state: snow water equivalent as a percent of the 30-year median (summed over stations), the median station percent, how many stations report and have snow, the deepest site, ' +
      'and every station with its snow depth, SWE and percent of median, sorted by depth, SWE, percent of median, elevation or name.',
    inputSchema: {
      state: z.string().describe('State code or name: AK, AZ, CA, CO, ID, MT, NV, NM, OR, SD, UT, WA or WY.'),
      sort: z.enum(['depth', 'swe', 'pct_of_median', 'elevation', 'name']).optional().describe('Station order. Default depth (deepest first).'),
      top: z.number().int().min(1).max(200).optional().describe('How many stations to name in the summary. Default 10; the structured list has every station.'),
    },
    annotations: { title: 'Snowpack by state', ...RO },
  }, wrap((a: any) => snowpackByState(fetchText, a)));

  server.registerTool('snow_depth_history', {
    title: 'Snow depth season history',
    description:
      'One SNOTEL station\'s snow season (Oct 1 to Sep 30): daily snow depth, snow water equivalent and the 30-year median SWE, weekly samples, the deepest day and peak SWE so far, first snow, melt-out, ' +
      'the same day last year, last season\'s peak, and the median onset, peak and melt-out dates. Give a station, or a place to use its nearest station.',
    inputSchema: {
      station,
      ...place,
      season: z.string().optional().describe('Season such as "2025-26", or "current" (default) or "last".'),
    },
    annotations: { title: 'Snow depth season history', ...RO },
  }, wrap((a: any) => snowDepthHistory(fetchText, a)));

  server.registerTool('snotel_stations', {
    title: 'Find SNOTEL stations',
    description:
      'Search the active USDA NRCS SNOTEL stations by state, name, county, minimum elevation or distance from a place (nearest first). Returns name, triplet (for the other tools), state, county, elevation, coordinates and the NRCS station page.',
    inputSchema: {
      state: z.string().optional().describe('State code or name.'),
      name: z.string().optional().describe('Part of a station name, such as "Pass" or "Summit".'),
      county: z.string().optional().describe('County name.'),
      min_elevation_ft: z.number().optional().describe('Only stations at or above this elevation in feet.'),
      ...place,
      max_miles: z.number().min(1).max(250).optional().describe('Radius around the place in miles. Default 50.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum stations returned. Default 20.'),
    },
    annotations: { title: 'Find SNOTEL stations', ...RO },
  }, wrap((a: any) => snotelStations(fetchText, a)));

  return server;
}
