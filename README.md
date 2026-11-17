# snow-depth-snowpack-snotel-mcp

Snow depth and snowpack for AI assistants: today's snow depth, snow water equivalent and percent of the 30-year median at the USDA NRCS SNOTEL mountain stations nearest any western US place, statewide snowpack, and a station's season history, read live from the NRCS Air and Water Database. Ask how much snow is on the ground near Breckenridge, how the Colorado snowpack compares with normal, or how this season at Berthoud Summit compares with last season.

This is a Model Context Protocol (MCP) server. It reads the USDA NRCS AWDB REST API (the SNOTEL network, about 920 active automated stations in 13 states) at call time, locates place names with the Open-Meteo geocoder (US places) and ZIP codes with phzmapi.org. It needs no API key.

## Tools

| Tool | What it returns |
| --- | --- |
| `snow_depth` | Current snow depth (in and cm), snow water equivalent, SWE as a percent of the 30-year median for the date, and the 24-hour and 7-day change in depth at the SNOTEL stations nearest a place, ZIP code or coordinates, or at a named station, with elevation and distance. |
| `snowpack_by_state` | Statewide snowpack: SWE as a percent of the 30-year median summed over every reporting station, the median station percent, stations reporting and with snow, the deepest site, and every station sorted by depth, SWE, percent of median, elevation or name. |
| `snow_depth_history` | One station's season (Oct 1 to Sep 30): daily snow depth, SWE and median SWE, weekly samples, deepest day, peak SWE, first snow, melt-out, the same day last year, last season's peak, and the median onset, peak and melt-out dates. |
| `snotel_stations` | Find active SNOTEL stations by state, name, county, minimum elevation or distance from a place, with triplet, elevation, coordinates and the NRCS station page. |

Every result has structured JSON, a plain-text summary, `as_of`, `source` and `more` (a page on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=snow-depth-snowpack-snotel-mcp)). Every tool is marked read-only.

## What it knows that your model does not

- Today's snow depth and snow water equivalent at about 920 SNOTEL mountain stations, updated daily, which no model can know.
- How this snowpack compares with normal: snow water equivalent as a percent of the NRCS 30-year median for the same date, per station and summed for a whole state.
- Each station's season so far against last season and against the median dates when snow usually starts, peaks and melts out.

## Install

### Hosted (custom connector, ChatGPT developer mode, any remote MCP client)

Paste this URL. No token, no sign-up.

```
https://snow-depth-snowpack-snotel-mcp.lipmichal.workers.dev/mcp
```

### Cursor

Add to `~/.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "snow-depth": { "url": "https://snow-depth-snowpack-snotel-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`.

```json
{
  "servers": {
    "snow-depth": { "type": "http", "url": "https://snow-depth-snowpack-snotel-mcp.lipmichal.workers.dev/mcp" }
  }
}
```

### Local stdio

The npm package is not published. Build it from this repository with Node 20 or newer, then point your MCP client at `node /path/to/snow-depth-snowpack-snotel-mcp/dist/stdio.js`.

```
git clone https://github.com/theluckystrike/snow-depth-snowpack-snotel-mcp && cd snow-depth-snowpack-snotel-mcp
npm install && npm run build
node dist/stdio.js
```

## Example prompts

- "How much snow is on the ground near Breckenridge, Colorado right now?"
- "How is the Colorado snowpack compared with normal this week?"
- "How does this season at Berthoud Summit compare with last season?"
- "Which SNOTEL stations are near Alta, Utah, and how deep is the snow there?"

## Data sources

Full list in [DATA_SOURCES.md](DATA_SOURCES.md).

- USDA NRCS Air and Water Database (AWDB) REST API, SNOTEL network: https://wcc.sc.egov.usda.gov/awdbRestApi/swagger-ui/index.html
- Open-Meteo geocoding API for place names (US only): https://open-meteo.com/en/docs/geocoding-api
- phzmapi.org ZIP code coordinates: https://phzmapi.org/

## Limitations

- SNOTEL covers the mountains of Alaska, Arizona, California, Colorado, Idaho, Montana, Nevada, New Mexico, Oregon, South Dakota, Utah, Washington and Wyoming. There are no stations in the eastern US or Canada.
- SNOTEL sites are automated mountain stations, often near passes and ski areas but not at them. This is not a ski resort snow report.
- Daily values are provisional and can be revised by NRCS. The newest daily value usually lags a day; a station that has not reported for more than two days is flagged.
- The 30-year median exists for snow water equivalent only, and only at stations with a long enough record. Early in the season the median for the date can be 0, so there is no percent of median.
- The statewide percent is the sum of current SWE over the sum of the median at the same reporting stations; NRCS basin indexes use their own station sets.

## More

More MCP servers that answer questions your assistant cannot answer alone are on [mcpstamp.com](https://www.mcpstamp.com/servers/?utm_source=mcp&utm_medium=snow-depth-snowpack-snotel-mcp).

Part of the Zovo MCP collection at https://mcp.zovo.one

Built by [theluckystrike](https://github.com/theluckystrike).

## Development

```
npm install
npm test                              # builds, then runs the fixture tests and an offline stdio test
node scripts/stdio-transcript.mjs     # live stdio round trip, writes .live/stdio-transcript.jsonl
```

CI (`.github/workflows/bundle.yml`) runs the tests, the type check and `wrangler deploy --dry-run --outdir out`, and uploads the Worker bundle as an artifact.

## License

MIT
