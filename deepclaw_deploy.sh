set -e

tag="deployment-"$(git describe --always)
IMAGE="registry.fly.io/deepclaw-instance:$tag"

## Save for later
#echo "Building $IMAGE"
#docker build -t "$IMAGE" -f Dockerfile.fly .
#echo "Pushing $IMAGE"
#docker push "$IMAGE"

echo "build and deploying $IMAGE"
fly deploy . --buildkit -a deepclaw-instance --config fly.deepclaw.toml --ha=false --image-label $tag


echo "\n $IMAGE \n"


echo "Deploying"

# Make sure control plane is running
curl https://deepclaw-control.fly.dev/api/health

# echo "Truncating DB"
# printf "TRUNCATE users, machines, api_keys, pool_machines CASCADE;\n\\q\n" | fly postgres connect -a deepclaw-db -d deepclaw_control -

# curl -s -H "Authorization: Bearer $DEEPCLAW_LITELLM_MASTER_KEY" https://deepclaw-litellm.fly.dev/key/list | jq '{keys: [.[].token]}' | curl -s -X POST -H "Authorization: Bearer $DEEPCLAW_LITELLM_MASTER_KEY" -H "Content-Type: application/json" -d @- https://deepclaw-litellm.fly.dev/key/delete

# fly machines list -a deepclaw-instance --json | jq -r '.[].id' | xargs -I{} fly machines destroy {} -a deepclaw-instance --force

curl https://deepclaw-control.fly.dev/api/health

fly secrets set "OPENCLAW_IMAGE=$IMAGE" -a deepclaw-control
