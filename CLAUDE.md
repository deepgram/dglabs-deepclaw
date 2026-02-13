# DeepClaw

## Deployment

Always use this command to deploy a new deepclaw-instance:

```bash
fly deploy . -a deepclaw-instance --config fly.deepclaw.toml
```

## SMS Proxy (Flycast)

Instances send outbound SMS via the `deepclaw-control` app's proxy endpoint over Fly's private network using Flycast.

- **Proxy URL:** `http://deepclaw-control.flycast/api/sms/send`
- Set on each machine as `TWILIO_SMS_PROXY_URL` (provisioned by `deepclaw-control`)
- Flycast requires a private IPv6 IP allocated on `deepclaw-control` (`fly ips allocate-v6 --private -a deepclaw-control`)
- `deepclaw-control` must have `force_https=false` on port 80 for Flycast HTTP traffic to work
- The proxy handles the "from" phone number — instances don't need `TWILIO_PHONE_NUMBER`

### Updating proxy URL on running machines

```bash
for id in $(fly machines list -a deepclaw-instance --json | jq -r '.[] | select(.state == "started") | .id'); do
  fly machines update "$id" -a deepclaw-instance --env TWILIO_SMS_PROXY_URL=http://deepclaw-control.flycast/api/sms/send -y
done
```
