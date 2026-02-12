set -e

TAG=${1:?"Usage: $0 <tag>"}

fly machine list -a deepclaw-instance --json | jq -r '.[].id' | xargs -I{} fly machine update {} --image registry.fly.io/deepclaw-instance:$TAG -a deepclaw-instance -y
