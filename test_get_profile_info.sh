#!/bin/bash

curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "profile.get_user_info",
    "tenant": "uk",
    "event_datetime": "2026-10-09T12:00:00Z",
    "customer": {
      "email": "zhentong+8@leisurelabs.co.uk"
    }
  }'