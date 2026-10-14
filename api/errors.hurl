# Malformed SQL is a client error.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT this is not valid sql"
}
HTTP 400
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.error" exists

###

# The contract requires a single VARCHAR column; a VARIANT column is rejected.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT data FROM events LIMIT 1"
}
HTTP 400
[Asserts]
jsonpath "$.error" exists

###

# A query that returns no rows violates the single-row contract.
POST {{host}}/api/data
Content-Type: application/json
{
  "sql": "SELECT 1 WHERE false"
}
HTTP 400
[Asserts]
jsonpath "$.error" exists

###

# A body that is missing the `sql` field is a client error.
POST {{host}}/api/data
Content-Type: application/json
{}
HTTP 422
