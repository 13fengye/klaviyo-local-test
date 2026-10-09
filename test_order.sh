#!/bin/bash

curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "order.completed",
    "tenant": "uk",
    "event_datetime": "2026-09-13T12:00:00Z",
    "order": {
      "id": 1001,
      "type": "order",
      "currency": "EUR",
      "total": 50.00,
      "customer": {
        "id": "user_123",
        "first_name": "San",
        "last_name": "Zhang",
        "full_name": "San Zhang",
        "email": "zhentong+1@leisurelabs.co.uk",
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
      },
      "location": {
        "id": "loc_001",
        "type": "location",
        "name": "Beijing Club",
        "timezone": "Asia/Shanghai",
        "region": {
          "id": "reg_001",
          "type": "region",
          "name": "North Region"
        }
      },
      "refund_sources": [],
      "order_lines": [
        {
          "id": 501,
          "type": "order_line",
          "line_subtotal": 50.00,
          "line_total": 50.00,
          "quantity": 1,
          "status": "completed",
          "unit_subtotal": 50.00,
          "unit_total": 50.00,
          "product": {
            "id": 14969,
            "type": "product",
            "name": "1 SESSION",
            "product_type": "Credits"
          }
        }
      ]
    }
  }'