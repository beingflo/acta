GET {{host}}/healthz
HTTP 200
[Asserts]
header "Content-Type" contains "text/plain"
body == "ok"
