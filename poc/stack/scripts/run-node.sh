#!/bin/sh
# rskj launcher. All knobs are env-driven so podman-compose can set them per node.
#   RSK_CONF     path to the node's HOCON config (default node-a.conf)
#   JVM_OPTS     JVM heap etc. (regtest is light; 2g is plenty)
#   INTENT_OPTS  -Dintent.* admission policy flags
set -eu
: "${RSK_CONF:=/config/node-a.conf}"
: "${JVM_OPTS:=-Xmx2g}"
: "${INTENT_OPTS:=}"

echo "starting rskj: conf=${RSK_CONF} jvm=${JVM_OPTS} intent=[${INTENT_OPTS}]"
exec java ${JVM_OPTS} ${INTENT_OPTS} \
  -Drsk.conf.file="${RSK_CONF}" \
  -cp /var/lib/rsk/rsk.jar co.rsk.Start --regtest
