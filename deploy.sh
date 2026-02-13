set -e

tag="deployment-"$(git describe --always)
IMAGE="registry.fly.io/deepclaw-instance:$tag"

echo "build and deploying $IMAGE"
fly deploy . -a deepclaw-instance --config fly.toml --ha=false --image-label $tag

echo "\n $IMAGE \n"

echo "Deploying"

# Make sure control plane is running
curl https://deepclaw-control.fly.dev/api/health

fly secrets set "OPENCLAW_IMAGE=$IMAGE" -a deepclaw-control
