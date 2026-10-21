#!/bin/bash

curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "action": "test",
    "event_datetime": "2026-10-15T06:15:18.962563Z",
    "reservation": {
      "broker_id": 294984,
      "class_session": {
        "available_spots": 26,
        "cancellation_datetime": null,
        "capacity": 80,
        "class_name": "RIDE",
        "class_type": {
          "duration": 45,
          "id": "5889",
          "is_live_stream": 0,
          "name": "RIDE",
          "type": "class_type"
        },
        "classroom_id": "6202",
        "classroom_name": "RIDE",
        "direct_booking_currency_code": null,
        "direct_booking_price": null,
        "direct_booking_reservation_limit": null,
        "end_datetime": "2026-10-15T07:15:00Z",
        "id": "619970",
        "instructors": [
          {
            "id": "6641",
            "name": "Janine",
            "type": "instructor"
          }
        ],
        "is_free_class": 0,
        "layout_format": "pick-a-spot",
        "live_stream_url": null,
        "location": {
          "id": "48725",
          "name": "VICTORIA",
          "region": {
            "id": "48541",
            "name": "UNITED KINGDOM",
            "type": "region"
          },
          "timezone": "Europe/London",
          "type": "location"
        },
        "public": 1,
        "spot_holds": [
          {
            "broker_id": 352508,
            "comment": null,
            "creation_date": "2026-10-06T09:22:48.809489Z",
            "hold_type": "admin",
            "id": "615887",
            "release_date": "2026-10-13T14:19:27.960491Z",
            "spot_id": 37921,
            "type": "spot_hold"
          },
          {
            "broker_id": null,
            "comment": null,
            "creation_date": "2026-07-17T01:02:01.990337Z",
            "hold_type": "unavailable",
            "id": "538542",
            "release_date": null,
            "spot_id": 37929,
            "type": "spot_hold"
          }
        ],
        "start_date": "2026-10-15",
        "start_datetime": "2026-10-15T06:30:00Z",
        "start_time": "07:30:00",
        "type": "class_session"
      },
      "credit_payments": [
        {
          "contract_name": null,
          "end_date": null,
          "name": "Unlimited Memberships - UK (3 Week Booking Window)",
          "remaining_renewals": null
        }
      ],
      "customer": {
        "address_line1": "49b hollingbourne road",
        "address_line2": null,
        "address_line3": null,
        "address_sorting_code": null,
        "archived_at": null,
        "birth_date": "1997-06-22",
        "city": "London",
        "company_name": null,
        "country": null,
        "created_datetime": "2020-10-24T12:00:00Z",
        "customer_locations": [
          {
            "context": "home_location",
            "event_datetime": "2024-08-27 22:55:45.221414+00:00",
            "location_id": "48725"
          },
          {
            "context": "purchase_location",
            "event_datetime": "2026-09-26 11:32:55.900097+00:00",
            "location_id": "48720"
          },
          {
            "context": "reservation_location",
            "event_datetime": "2026-09-26 11:33:28.455551+00:00",
            "location_id": "48725"
          },
          {
            "context": "reservation_location",
            "event_datetime": "2026-09-27 07:49:45.689127+00:00",
            "location_id": "48764"
          },
          {
            "context": "purchase_location",
            "event_datetime": "2026-09-28 20:35:35.812952+00:00",
            "location_id": "48725"
          }
        ],
        "email": "zhentong@leisurelabs.co.uk",
        "emergency_contact_email": null,
        "emergency_contact_name": null,
        "emergency_contact_phone": null,
        "emergency_contact_relationship": null,
        "employee": null,
        "first_name": "Hasan",
        "formatted_address": [
          "49b hollingbourne road",
          "London"
        ],
        "full_name": "Hasan Uzun",
        "gender": null,
        "home_location": {
          "id": "48725",
          "name": "VICTORIA",
          "region": {
            "id": "48541",
            "name": "UNITED KINGDOM",
            "type": "region"
          },
          "timezone": "Europe/London",
          "type": "location"
        },
        "id": "294984",
        "is_external_user": 0,
        "is_opted_in_to_marketing": 1,
        "is_opted_in_to_sms": 1,
        "last_name": "Uzun",
        "merged_datetime": null,
        "merged_into_profile": null,
        "phone_number": "7428477460",
        "postal_code": "SE24 9NB",
        "pronouns": null,
        "state_province": null,
        "type": "profile"
      },
      "guest_email": null,
      "id": "14297664",
      "membership_payments": [],
      "payer": {
        "address_line1": "49b hollingbourne road",
        "address_line2": null,
        "address_line3": null,
        "address_sorting_code": null,
        "archived_at": null,
        "birth_date": "1997-06-22",
        "city": "London",
        "company_name": null,
        "country": null,
        "created_datetime": "2020-10-24T12:00:00Z",
        "customer_locations": [
          {
            "context": "home_location",
            "event_datetime": "2024-08-27 22:55:45.221414+00:00",
            "location_id": "48725"
          },
          {
            "context": "purchase_location",
            "event_datetime": "2026-09-26 11:32:55.900097+00:00",
            "location_id": "48720"
          },
          {
            "context": "reservation_location",
            "event_datetime": "2026-09-26 11:33:28.455551+00:00",
            "location_id": "48725"
          },
          {
            "context": "reservation_location",
            "event_datetime": "2026-09-27 07:49:45.689127+00:00",
            "location_id": "48764"
          },
          {
            "context": "purchase_location",
            "event_datetime": "2026-09-28 20:35:35.812952+00:00",
            "location_id": "48725"
          }
        ],
        "email": "zhentong@leisurelabs.co.uk",
        "emergency_contact_email": null,
        "emergency_contact_name": null,
        "emergency_contact_phone": null,
        "emergency_contact_relationship": null,
        "employee": null,
        "first_name": "Hasan",
        "formatted_address": [
          "49b hollingbourne road",
          "London"
        ],
        "full_name": "Hasan Uzun",
        "gender": null,
        "home_location": {
          "id": "48725",
          "name": "VICTORIA",
          "region": {
            "id": "48541",
            "name": "UNITED KINGDOM",
            "type": "region"
          },
          "timezone": "Europe/London",
          "type": "location"
        },
        "id": "294984",
        "is_external_user": 0,
        "is_opted_in_to_marketing": 1,
        "is_opted_in_to_sms": 1,
        "last_name": "Uzun",
        "merged_datetime": null,
        "merged_into_profile": null,
        "phone_number": "7428477460",
        "postal_code": "SE24 9NB",
        "pronouns": null,
        "state_province": null,
        "type": "profile"
      },
      "reservation_type": "standard",
      "spot": {
        "id": "37872",
        "name": "24",
        "type": "spot"
      },
      "status": "check in",
      "type": "reservation",
      "used_geo_checkin": 0
    },
    "tenant": "onerebel"
  }'