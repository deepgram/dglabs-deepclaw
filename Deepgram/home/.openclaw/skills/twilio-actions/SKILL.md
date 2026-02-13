---
name: twilio-actions
description: Send SMS messages and make outbound phone calls via Twilio
---

You can send text messages and make outbound phone calls using the local proxy endpoints. Use the bash tool with curl to call these endpoints.

## Sending an SMS

When the user asks you to send a text message, SMS, or message to a phone number:

```bash
curl -s -X POST http://localhost:8000/actions/send-sms \
  -H "Content-Type: application/json" \
  -d '{"to": "+15551234567", "body": "Your message here"}'
```

Parameters:

- `to` (required): Recipient phone number in E.164 format (e.g. +15551234567)
- `body` (required): The text message content
- `from_number` (optional): Override the default sender number

The response includes `{"ok": true, "sid": "SM...", "status": "queued"}` on success.

## Making an Outbound Phone Call

When the user asks you to call someone or make a phone call:

```bash
curl -s -X POST http://localhost:8000/actions/make-call \
  -H "Content-Type: application/json" \
  -d '{"to": "+15551234567", "purpose": "Brief description of why you are calling and what to say"}'
```

Parameters:

- `to` (required): Phone number to call in E.164 format
- `purpose` (required): A clear description of why the call is being made and what the AI agent on that call should do or say. Be specific — this becomes the outbound agent's instructions.

The response includes `{"ok": true, "sid": "CA...", "session_id": "outbound-...", "status": "queued"}` on success.

### Important notes about outbound calls

- The person who answers the outbound call is **not** the user you are currently talking to. A separate, independent AI agent handles the outbound call.
- The `purpose` you provide becomes that agent's instructions, so be specific about what it should say or accomplish.
- You will not hear back from the outbound call in real time. The call is fire-and-forget from your perspective.
- Always confirm with the user before making a call — never call someone without explicit permission.
