# Data sources

All data is read at call time. No key is needed.

| Endpoint | Used for |
| --- | --- |
| `https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stationTriplets=*:*:SNTL&activeOnly=true` | every active SNOTEL station: triplet, name, state, county, elevation (ft), latitude and longitude (cached 7 days) |
| `https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data?stationTriplets=<triplets or *:CO:SNTL>&elements=SNWD,WTEQ&duration=DAILY&beginDate=<date>&endDate=<date>&centralTendencyType=MEDIAN` | daily snow depth (SNWD, inches) and snow water equivalent (WTEQ, inches) with the 30-year median for each day and the median peak, onset and melt-out dates (cached 1 hour) |
| `https://geocoding-api.open-meteo.com/v1/search?countryCode=US` | place name to latitude and longitude |
| `https://phzmapi.org/<zip>.json` | US ZIP code to latitude and longitude |

The SNOTEL network is run by the USDA Natural Resources Conservation Service (NRCS) National Water and Climate Center. Data are provisional. The station page link is `https://wcc.sc.egov.usda.gov/nwcc/site?sitenum=<id>`.
