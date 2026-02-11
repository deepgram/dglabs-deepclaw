#fly deploy . -a deepclaw-instance --config fly.deepclaw.toml --build-only
IMAGE=$(fly deploy . --buildkit -a deepclaw-instance --config fly.deepclaw.toml 2>&1 | tee /dev/stderr | grep '^image:' | cut -d\  -f2)
echo $IMAGE
fly -y -a deepclaw-instance --config fly.deepclaw.toml scale count 0
