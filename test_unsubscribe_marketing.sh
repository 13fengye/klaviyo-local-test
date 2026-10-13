#!/bin/bash

curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "profile.unsubscribe_marketing",
    "tenant": "onerebel_app",
    "event_datetime": "2026-10-09T12:00:00Z",
    "unsubscribe_data": {
      "customer": {
        "email": "zhentong+9@leisurelabs.co.uk"
      },
      "channels": ["email", "whatsapp"],
      "phone_number":"+12334"
    }
  }'