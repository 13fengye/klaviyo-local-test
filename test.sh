#!/bin/bash

curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "profile.created",
    "tenant": "test-tenant",
    "event_datetime": "2026-09-13T12:00:00Z",
    "profile": {
      "id": "user_123",
      "first_name": "Zhentong",
      "last_name": "Peng",
      "full_name": "ZhentongPeng",
      "email": "zhentong+8@leisurelabs.co.uk",
      "is_opted_in_to_marketing": true,
      "is_opted_in_to_sms": false,
      "home_location": {
        "id": "loc_001",
        "type": "location",
        "name": "Beijing Club",
        "timezone": "Asia/Shanghai",
        "region": {
          "id": "reg_001",
          "type": "region",
          "name": "North Region"
        }
      }
    }
  }'