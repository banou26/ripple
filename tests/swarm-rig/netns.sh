#!/bin/sh
# Runs the swarm rig in a network of its own: loopback, and one interface that leads nowhere and takes the default
# route, which a browser needs before it gathers a WebRTC candidate. Nothing the lane starts can reach another
# machine, and nothing outside reaches the proxy, which listens on every address. The interface's address is the
# tracker's, the one name that is answered: the machine's own name services are hidden (their sockets are files,
# which a network namespace alone leaves in reach).
#
#   tests/swarm-rig/netns.sh xvfb-run -a -s "-screen 0 1280x720x24" npm run test:e2e:rig
set -e
here=$(dirname "$(readlink -f "$0")")
names=$(mktemp -d)
mkdir "$names/empty"
tracker=$(node -p "const { name, address } = JSON.parse(fs.readFileSync('$here/topology.json', 'utf8')).tracker; address + ' ' + name")
printf '127.0.0.1 localhost\n::1 localhost\n%s\n' "$tracker" > "$names/hosts"
printf 'nameserver 127.0.0.1\noptions timeout:1 attempts:1\n' > "$names/resolv.conf"
export RIPPLE_RIG_NETNS=1
exec unshare -r -n -m sh -c '
  set -e
  names=$1; address=$2; shift 2
  for sockets in /run/systemd/resolve /run/nscd; do [ ! -d "$sockets" ] || mount --bind "$names/empty" "$sockets"; done
  mount --bind "$names/hosts" /etc/hosts
  mount --bind "$names/resolv.conf" /etc/resolv.conf
  rm -rf "$names"
  ip link set lo up
  ip link add rig0 type dummy
  ip addr add "$address/24" dev rig0
  ip link set rig0 up
  ip route add default dev rig0
  exec "$@"
' netns "$names" "${tracker%% *}" "$@"
