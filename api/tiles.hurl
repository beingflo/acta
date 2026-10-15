# The PMTiles archives the map tile reads, coarsest first: a world basemap plus
# two extracts derived from the fixes by `tools/map_regions.py`. They must be
# served with byte-range support, since the client pulls the header, directory
# and tiles via range requests.
HEAD {{host}}/tiles/world.pmtiles
HTTP 200
[Asserts]
header "Accept-Ranges" == "bytes"
header "ETag" exists
header "Cache-Control" contains "max-age"

###

HEAD {{host}}/tiles/all.pmtiles
HTTP 200
[Asserts]
header "Accept-Ranges" == "bytes"

###

HEAD {{host}}/tiles/tier1.pmtiles
HTTP 200
[Asserts]
header "Accept-Ranges" == "bytes"

###

GET {{host}}/tiles/all.pmtiles
Range: bytes=0-99
HTTP 206
[Asserts]
header "Content-Range" startsWith "bytes 0-99/"
header "Content-Length" == "100"
