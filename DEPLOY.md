# Deploying DeepClaw

## Full Deploy (all machines)

1. **Build, push, and update the control plane image reference:**

   ```bash
   ./deepclaw_deploy.sh
   ```

   This does two things:
   - Deploys the current code to `deepclaw-instance` on Fly (building and pushing a new image to the registry)
   - Sets `OPENCLAW_IMAGE` on the `deepclaw-control` app so the control plane uses this image when creating new `deepclaw-instance` machines

2. **Update all running machines to the new image:**

   ```bash
   ./update_machines.sh <tag>
   ```

   The `<tag>` argument is the image tag printed by the deploy script (e.g. `deployment-bdf5304f7`).

   This updates every running `deepclaw-instance` machine to the new image.

---

## Single Machine Update (for testing)

If you only want to update one machine (e.g. your own), skip the full deploy and do it manually:

1. **Build and push the image:**

   ```bash
   tag="my-test-tag"  # pick something unique
   fly deploy . --buildkit -a deepclaw-instance --config fly.deepclaw.toml --ha=false --image-label $tag
   ```

   This adds an image to the registry and deploys a machine. That machine will thrash and die — this is expected (blame Fly).

2. **Update just your machine:**

   ```bash
   fly machine update <machine_id> --image registry.fly.io/deepclaw-instance:$tag -a deepclaw-instance -y
   ```

   To find your machine ID, query the database:

   ```bash
   echo "SELECT u.id, u.phone_number, u.status, m.fly_machine_id, m.status AS machine_status, a.litellm_key_id, a.key_alias FROM users u LEFT JOIN machines m ON m.user_id = u.id LEFT JOIN api_keys a ON a.user_id = u.id ORDER BY u.created_at;" | fly postgres connect -a deepclaw-db -d deepclaw_control
   ```
