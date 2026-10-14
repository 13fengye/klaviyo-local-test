#!/bin/bash

curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
  "action": "test",
  "reservation": {
    "id": 2606,
    "type": "reservation",
    "class_session": {
      "id": 6573,
      "type": "class_session",
      "available_spots": 20,
      "cancellation_datetime": "2019-04-17T12:00:00-07:00",
      "class_type": {
        "id": 5889,
        "type": "class_type",
        "duration": 57,
        "is_live_stream": true,
        "name": "Class Session Type IXHooDJEIkfJ"
      },
      "class_name": "Special Class",
      "classroom_name": "SteelBlue",
      "capacity": 10,
      "direct_booking_currency_code": "USD",
      "direct_booking_price": 25,
      "direct_booking_reservation_limit": 5,
      "end_datetime": "2019-04-16T12:57:00-07:00",
      "instructors": [
        {
          "id": 6106,
          "type": "instructor",
          "name": "Amy F"
        }
      ],
      "layout_format": "first-come-first-serve",
      "live_stream_url": "https://live-stream-class-url.com",
      "location": {
        "id": "48717",
        "type": "location",
        "name": "Location swAyUrwCZhDL",
        "timezone": "US/Pacific",
        "region": {
          "id": "48541",
          "type": "region",
          "name": "Region JIpHfuOIJXDD"
        }
      },
      "start_date": "2019-04-16",
      "start_datetime": "2019-04-16T12:00:00-07:00",
      "start_time": "12:00:00"
    },
    "credit_payments": [
      {
        "expiration_date": "2027-04-19T22:33:58.630439Z",
        "is_expired": false,
        "name": "3 Sessions",
        "package_name": "3 Sessions",
        "package_source": "purchase",
        "remaining": 3
      }
    ],
    "customer": {
      "id": "35077",
      "type": "profile",
      "address_line1": "7509 Highway St",
      "address_line2": "Suite 624",
      "address_line3": "Barra",
      "address_sorting_code": "3",
      "birth_date": "1934-07-16",
      "city": "North Sandra",
      "company_name": "Boone-Turner",
      "country": "US",
      "created_datetime": "2018-11-23T13:09:26Z",
      "email": "cheryl.clark.59@marianatek.com",
      "emergency_contact_email": "robertjones@example.org",
      "emergency_contact_name": "Allison Snyder",
      "emergency_contact_phone": "+45(0)6974305901",
      "emergency_contact_relationship": "aunt",
      "first_name": "Cheryl",
      "formatted_address": [
        "1234 Main Street",
        "Washington, DC 20003",
        "United States"
      ],
      "full_name": "Cheryl Clark",
      "gender": "non_binary",
      "home_location": {
        "id": "48717",
        "type": "location",
        "name": "Location swAyUrwCZhDL",
        "timezone": "US/Pacific",
        "region": {
          "id": "48541",
          "type": "region",
          "name": "Region JIpHfuOIJXDD"
        }
      },
      "is_opted_in_to_marketing": true,
      "is_opted_in_to_sms": true,
      "last_name": "Clark",
      "phone_number": "1-273-679-3099x545",
      "postal_code": 5941,
      "pronouns": "they/them",
      "state_province": "MS",
      "customer_locations": [
        {
          "context": "home_location",
          "event_datetime": "2018-11-23T13:09:26Z",
          "location_id": "12345"
        }
      ]
    },
    "guest_email": "string",
    "membership_payments": [
      {
        "contract_name": "string",
        "end_date": "string",
        "name": "Membership XTExfoWwDDog",
        "remaining_renewals": "string"
      }
    ],
    "payer": {
      "id": "35077",
      "type": "profile",
      "address_line1": "7509 Highway St",
      "address_line2": "Suite 624",
      "address_line3": "Barra",
      "address_sorting_code": "3",
      "birth_date": "1934-07-16",
      "city": "North Sandra",
      "company_name": "Boone-Turner",
      "country": "US",
      "created_datetime": "2018-11-23T13:09:26Z",
      "email": "cheryl.clark.59@marianatek.com",
      "emergency_contact_email": "robertjones@example.org",
      "emergency_contact_name": "Allison Snyder",
      "emergency_contact_phone": "+45(0)6974305901",
      "emergency_contact_relationship": "aunt",
      "first_name": "Cheryl",
      "formatted_address": [
        "1234 Main Street",
        "Washington, DC 20003",
        "United States"
      ],
      "full_name": "Cheryl Clark",
      "gender": "non_binary",
      "home_location": {
        "id": "48717",
        "type": "location",
        "name": "Location swAyUrwCZhDL",
        "timezone": "US/Pacific",
        "region": {
          "id": "48541",
          "type": "region",
          "name": "Region JIpHfuOIJXDD"
        }
      },
      "is_opted_in_to_marketing": true,
      "is_opted_in_to_sms": true,
      "last_name": "Clark",
      "phone_number": "1-273-679-3099x545",
      "postal_code": 5941,
      "pronouns": "they/them",
      "state_province": "MS",
      "customer_locations": [
        {
          "context": "home_location",
          "event_datetime": "2018-11-23T13:09:26Z",
          "location_id": "12345"
        }
      ]
    },
    "reservation_type": "standard",
    "spot": "string",
    "status": "pending"
  },
  "tenant": "cool_yoga",
  "event_datetime": "2019-04-14T18:49:53.438830Z"
}'