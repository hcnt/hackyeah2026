#!/usr/bin/env bash
# Runs the oracle backend on an on-demand AWS GPU instance, reachable from this laptop at localhost:8000
# through an SSH tunnel (so the Vite dev server and oracle.kindhome.io keep working unchanged).
#
#   scripts/oracle-gpu.sh up        start (or create) the instance, ship backend/, start the oracle, open the tunnel
#   scripts/oracle-gpu.sh down      close the tunnel and stop the instance (only the disk keeps costing)
#   scripts/oracle-gpu.sh status    instance state, tunnel, health
#   scripts/oracle-gpu.sh logs      follow the oracle log on the instance
#   scripts/oracle-gpu.sh ssh       shell on the instance
#   scripts/oracle-gpu.sh destroy --yes   terminate the instance and delete its security group and key pair
#
# Every AWS resource is tagged project=attend-now and found by that tag. Each `up` schedules an automatic stop
# after ORACLE_GPU_HOURS (default 4) so a forgotten instance can't run all night.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PROFILE=${AWS_PROFILE:-hackyeah}
export AWS_REGION=${AWS_REGION:-eu-central-1}
TYPE=${ORACLE_GPU_TYPE:-g4dn.xlarge}
HOURS=${ORACLE_GPU_HOURS:-4}
ORACLE_ENV=${ORACLE_ENV:-dev}
NAME=attend-now-oracle
TAG_KEY=project
TAG_VALUE=attend-now
STATE_DIR="$HOME/.cache/attend-now"
KEY_FILE="$HOME/.ssh/$NAME.pem"
TUNNEL_PID="$STATE_DIR/tunnel.pid"
LOCAL_PORT=8000
mkdir -p "$STATE_DIR"

SSH_OPTS=(-i "$KEY_FILE" -o HostKeyAlias="$NAME" -o UserKnownHostsFile="$STATE_DIR/known_hosts"
  -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o ServerAliveInterval=15)

tags() { echo "ResourceType=$1,Tags=[{Key=$TAG_KEY,Value=$TAG_VALUE},{Key=Name,Value=$NAME}]"; }

instance_id() {
  aws ec2 describe-instances \
    --filters "Name=tag:$TAG_KEY,Values=$TAG_VALUE" "Name=tag:Name,Values=$NAME" \
      "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId' --output text | awk '{print $1}' | grep -v '^None$' || true
}

instance_field() { aws ec2 describe-instances --instance-ids "$1" --query "Reservations[0].Instances[0].$2" --output text; }

sg_id() {
  aws ec2 describe-security-groups --filters "Name=tag:$TAG_KEY,Values=$TAG_VALUE" "Name=group-name,Values=$NAME" \
    --query 'SecurityGroups[0].GroupId' --output text | grep -v '^None$' || true
}

ensure_key() {
  if [[ ! -f "$KEY_FILE" ]]; then
    aws ec2 delete-key-pair --key-name "$NAME" >/dev/null 2>&1 || true
    aws ec2 create-key-pair --key-name "$NAME" --key-type ed25519 --tag-specifications "$(tags key-pair)" \
      --query KeyMaterial --output text >"$KEY_FILE"
    chmod 600 "$KEY_FILE"
    echo "Created key pair $NAME ($KEY_FILE)"
  fi
}

ensure_sg() {
  local id
  id=$(sg_id)
  if [[ -z "$id" ]]; then
    id=$(aws ec2 create-security-group --group-name "$NAME" --description "Attend Now oracle: SSH from the operator only" \
      --tag-specifications "$(tags security-group)" --query GroupId --output text)
    echo "Created security group $id" >&2
  fi
  echo "$id"
}

# SSH from this machine's current public IP only; any earlier IP is removed.
allow_my_ip() {
  local sg=$1 ip old
  ip=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
  for old in $(aws ec2 describe-security-groups --group-ids "$sg" \
      --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' --output text); do
    [[ "$old" == "$ip/32" ]] || aws ec2 revoke-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$old" >/dev/null
  done
  aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$ip/32" >/dev/null 2>&1 || true
}

latest_ami() {
  aws ec2 describe-images --owners amazon \
    --filters 'Name=name,Values=Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)*' 'Name=state,Values=available' \
    --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' --output text
}

create_instance() {
  local sg=$1 ami
  ami=$(latest_ami)
  echo "Launching $TYPE from $ami ..." >&2
  aws ec2 run-instances --image-id "$ami" --instance-type "$TYPE" --key-name "$NAME" --security-group-ids "$sg" \
    --instance-initiated-shutdown-behavior stop \
    --metadata-options HttpTokens=required \
    --tag-specifications "$(tags instance)" "$(tags volume)" "$(tags network-interface)" \
    --query 'Instances[0].InstanceId' --output text
}

remote() { ssh "${SSH_OPTS[@]}" "ubuntu@$IP" "$@"; }

wait_for_ssh() {
  for _ in $(seq 1 60); do
    remote true 2>/dev/null && return 0
    sleep 5
  done
  echo "SSH did not come up" >&2
  return 1
}

close_tunnel() {
  if [[ -f "$TUNNEL_PID" ]]; then
    kill "$(cat "$TUNNEL_PID")" 2>/dev/null || true
    rm -f "$TUNNEL_PID"
  fi
}

cmd_up() {
  ensure_key
  local sg id state
  sg=$(ensure_sg)
  allow_my_ip "$sg"
  id=$(instance_id)
  if [[ -z "$id" ]]; then
    id=$(create_instance "$sg")
  fi
  state=$(instance_field "$id" State.Name)
  if [[ "$state" == "stopping" ]]; then aws ec2 wait instance-stopped --instance-ids "$id"; state=stopped; fi
  if [[ "$state" == "stopped" ]]; then aws ec2 start-instances --instance-ids "$id" >/dev/null; fi
  aws ec2 wait instance-running --instance-ids "$id"
  IP=$(instance_field "$id" PublicIpAddress)
  echo "Instance $id running at $IP"
  wait_for_ssh

  echo "Shipping backend/ ..."
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
    --exclude .venv --exclude __pycache__ --exclude .pytest_cache --exclude .ruff_cache --exclude .env \
    backend/ "ubuntu@$IP:backend/"

  echo "Installing (first run takes a few minutes) and starting the oracle ..."
  remote "ORACLE_ENV=$ORACLE_ENV HOURS=$HOURS bash -s" <<'REMOTE'
set -euo pipefail
command -v uv >/dev/null || [ -x ~/.local/bin/uv ] || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
export PATH="$HOME/.local/bin:$PATH"
cd ~/backend
uv sync --frozen --quiet
# Swap the CPU runtime for the GPU one (same Python module); --no-sync below keeps uv from swapping it back.
if ! .venv/bin/python -c "import importlib.metadata as m; m.version('onnxruntime-gpu')" 2>/dev/null; then
  uv pip uninstall --quiet onnxruntime
  uv pip install --quiet "onnxruntime-gpu[cuda,cudnn]==1.30.0"
fi
ORACLE_DEVICE=cuda uv run --no-sync python - <<'PY'
from app.oracle.face import get_model
m = get_model()
print("detector:", m.det_model.session.get_providers()[0], "| recogniser:", m.models["recognition"].session.get_providers()[0])
PY
[ -f oracle.pid ] && kill "$(cat oracle.pid)" 2>/dev/null || true
sleep 1
ENV=$ORACLE_ENV ORACLE_DEVICE=cuda nohup .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log \
  >oracle.log 2>&1 &
echo $! >oracle.pid
sudo shutdown -c 2>/dev/null || true
sudo shutdown -h "+$((HOURS * 60))" >/dev/null 2>&1
echo "Oracle started (ENV=$ORACLE_ENV); instance stops itself in $HOURS h"
REMOTE

  close_tunnel
  if curl -fsS -m 2 "http://127.0.0.1:$LOCAL_PORT/api/health" >/dev/null 2>&1; then
    echo "Something on this laptop already answers on port $LOCAL_PORT (a local backend?). Stop it, then run 'up' again." >&2
    exit 1
  fi
  ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes -L "$LOCAL_PORT:127.0.0.1:8000" "ubuntu@$IP" &
  echo $! >"$TUNNEL_PID"
  for _ in $(seq 1 30); do
    if curl -fsS -m 2 "http://127.0.0.1:$LOCAL_PORT/api/health" >/dev/null 2>&1; then
      echo "GPU oracle reachable at http://localhost:$LOCAL_PORT  (cost while running: see 'status')"
      return 0
    fi
    sleep 2
  done
  echo "Tunnel is up but the oracle doesn't answer yet; check 'scripts/oracle-gpu.sh logs'" >&2
  return 1
}

cmd_down() {
  close_tunnel
  local id
  id=$(instance_id)
  if [[ -z "$id" ]]; then echo "No instance."; return 0; fi
  aws ec2 stop-instances --instance-ids "$id" >/dev/null
  aws ec2 wait instance-stopped --instance-ids "$id"
  echo "Instance $id stopped. Only its disk is billed now."
}

cmd_status() {
  local id
  id=$(instance_id)
  if [[ -z "$id" ]]; then echo "No instance (run 'up' to create one)."; return 0; fi
  aws ec2 describe-instances --instance-ids "$id" \
    --query 'Reservations[0].Instances[0].{id:InstanceId,state:State.Name,type:InstanceType,ip:PublicIpAddress,launched:LaunchTime}' \
    --output table
  if [[ -f "$TUNNEL_PID" ]] && kill -0 "$(cat "$TUNNEL_PID")" 2>/dev/null; then
    echo "Tunnel: open (pid $(cat "$TUNNEL_PID")) -> health: $(curl -fsS -m 3 "http://127.0.0.1:$LOCAL_PORT/api/health" 2>&1 || echo unreachable)"
  else
    echo "Tunnel: closed"
  fi
}

with_ip() {
  local id
  id=$(instance_id)
  [[ -n "$id" ]] || { echo "No instance." >&2; exit 1; }
  IP=$(instance_field "$id" PublicIpAddress)
  [[ "$IP" != "None" ]] || { echo "Instance is not running." >&2; exit 1; }
}

cmd_destroy() {
  [[ "${1:-}" == "--yes" ]] || { echo "This terminates the instance and deletes its disk. Run: $0 destroy --yes" >&2; exit 1; }
  close_tunnel
  local id sg
  id=$(instance_id)
  if [[ -n "$id" ]]; then
    aws ec2 terminate-instances --instance-ids "$id" >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$id"
    echo "Terminated $id"
  fi
  sg=$(sg_id)
  [[ -z "$sg" ]] || { aws ec2 delete-security-group --group-id "$sg" && echo "Deleted security group $sg"; }
  aws ec2 delete-key-pair --key-name "$NAME" >/dev/null 2>&1 && rm -f "$KEY_FILE" && echo "Deleted key pair $NAME"
  echo "Left over with tag $TAG_KEY=$TAG_VALUE:"
  aws ec2 describe-instances --filters "Name=tag:$TAG_KEY,Values=$TAG_VALUE" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) with_ip; remote 'tail -n 50 -f ~/backend/oracle.log' ;;
  ssh) with_ip; ssh "${SSH_OPTS[@]}" "ubuntu@$IP" ;;
  destroy) shift; cmd_destroy "$@" ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
