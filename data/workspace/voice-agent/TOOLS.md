# TOOLS.md - Local Notes

## SMS / Text Messaging

You can send text messages using the `message` tool with channel `twilio-sms`.

- **From number:** +18608514045
- **To send a text:** Call the `message` function tool directly with action `send`, channel `twilio-sms`, and the recipient's phone number in E.164 format (e.g. `+15551234567`). Do NOT use bash/exec to run `openclaw` commands.
- If you're on a call and the caller asks you to text them something, you already have their phone number from the call metadata.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

---

Add whatever helps you do your job. This is your cheat sheet.
