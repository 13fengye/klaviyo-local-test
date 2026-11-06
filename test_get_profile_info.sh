#!/bin/bash
set -a; source .env; set +a

curl -X POST ${BASE_URL}/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "profile.get_user_info",
    "tenant": "onerebel_app",
    "event_datetime": "2026-10-09T12:00:00Z",
    "customer": {
      "email": "zhentong+3@leisurelabs.co.uk"
    }
  }'