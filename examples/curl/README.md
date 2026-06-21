# Curl examples

> ⚠️ **Legal / ToS:** `wa-hub-demo` is an unofficial WhatsApp client (not affiliated with WhatsApp/Meta) and may violate WhatsApp's ToS. Use only against contacts who consented; bulk number-checking and programmatic group add/remove are high-risk and a common ban trigger. No warranty. See [../../DISCLAIMER.md](../../DISCLAIMER.md).

Set these once in your shell:

```bash
export HUB_URL="http://localhost:3060"   # or https://your-tunnel.com
export HUB_TOKEN="<your HUB_TOKEN>"
```

## Status & pairing

```bash
# health (no auth)
curl $HUB_URL/healthz

# connection state + paired account info
curl -H "Authorization: Bearer $HUB_TOKEN" $HUB_URL/api/instance/status

# QR as PNG — open it on your machine
curl -H "Authorization: Bearer $HUB_TOKEN" $HUB_URL/api/instance/qr.png > qr.png

# force re-pair (wipes the session)
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" $HUB_URL/api/instance/logout
```

## Sending

```bash
# Text
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{"to":"+972501234567","text":"Hello!"}' \
     $HUB_URL/api/messages/send/text

# Image (from URL)
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "to": "+972501234567",
       "imageUrl": "https://example.com/photo.jpg",
       "caption": "Look at this!"
     }' \
     $HUB_URL/api/messages/send/image

# File (PDF, doc, anything)
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "to": "+972501234567",
       "fileUrl": "https://example.com/report.pdf",
       "filename": "report.pdf",
       "mimetype": "application/pdf"
     }' \
     $HUB_URL/api/messages/send/file

# Voice note
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "to": "+972501234567",
       "audioUrl": "https://example.com/voice.ogg",
       "ptt": true
     }' \
     $HUB_URL/api/messages/send/audio

# Location
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "to": "+972501234567",
       "latitude": 32.0853,
       "longitude": 34.7818,
       "name": "Tel Aviv"
     }' \
     $HUB_URL/api/messages/send/location

# Reaction
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "to": "+972501234567",
       "messageId": "ABCD1234EFGH",
       "emoji": "👍"
     }' \
     $HUB_URL/api/messages/send/reaction
```

## Webhooks

```bash
# Configure webhook
curl -X PUT -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{
       "url": "https://your-app.com/wa-incoming",
       "events": ["message.incoming"]
     }' \
     $HUB_URL/api/instance/webhook

# Inspect current config
curl -H "Authorization: Bearer $HUB_TOKEN" $HUB_URL/api/instance/webhook

# Disable webhook
curl -X PUT -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{"url":null}' \
     $HUB_URL/api/instance/webhook
```

## Groups

```bash
# List all groups you're a member of
curl -H "Authorization: Bearer $HUB_TOKEN" $HUB_URL/api/groups

# Get a specific group's metadata
curl -H "Authorization: Bearer $HUB_TOKEN" \
     "$HUB_URL/api/groups/120363042000000000@g.us"

# Add a participant
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{"add":["+972501234567"]}' \
     "$HUB_URL/api/groups/120363042000000000@g.us/participants"
```

## Number check

```bash
curl -X POST -H "Authorization: Bearer $HUB_TOKEN" -H "Content-Type: application/json" \
     -d '{"numbers":["+972501234567","+12025550001"]}' \
     $HUB_URL/api/check/number
```
