#!/bin/bash
set -a; source .env; set +a

curl -X POST ${BASE_URL}/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "profile.unsubscribe_marketing",
    "tenant": "onerebel_app",
    "event_datetime": "2026-10-09T12:00:00Z",
    "unsubscribe_data": {
      "customer": {
        "email": "zhentong+test@leisurelabs.co.uk"
      },
      "channels": ["whatsapp"],
      "phone_number":"+441234567890"
    }
  }'