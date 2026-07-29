#!/usr/bin/env bash
set -euo pipefail

# Pin the final OpenDNP3 3.1.2 source commit. The project is end-of-life, so
# floating a tag or branch would add supply-chain risk without buying updates.
readonly OPENDNP3_REPOSITORY="https://github.com/dnp3/opendnp3.git"
readonly OPENDNP3_COMMIT="26b4c01e4839bbbda8866655e086471c4917ee53"

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/oxscada-opendnp3-XXXXXX")"
readonly OUTSTATION_LOG="${WORK_DIR}/outstation.log"
readonly MASTER_LOG="${WORK_DIR}/master.log"

outstation_pid=""

cleanup() {
  if [[ -n "${outstation_pid}" ]] && kill -0 "${outstation_pid}" 2>/dev/null; then
    kill "${outstation_pid}" 2>/dev/null || true
    wait "${outstation_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

for tool in cmake c++ git node npx timeout; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "DNP3 conformance requires '${tool}' on PATH" >&2
    exit 2
  fi
done

echo "Building pinned OpenDNP3 ${OPENDNP3_COMMIT}"
git clone --quiet --no-checkout --filter=blob:none "${OPENDNP3_REPOSITORY}" "${WORK_DIR}/opendnp3"
git -C "${WORK_DIR}/opendnp3" fetch --quiet --depth 1 origin "${OPENDNP3_COMMIT}"
git -C "${WORK_DIR}/opendnp3" checkout --quiet --detach "${OPENDNP3_COMMIT}"

cmake \
  -S "${WORK_DIR}/opendnp3" \
  -B "${WORK_DIR}/build" \
  -DDNP3_EXAMPLES=ON \
  -DDNP3_STATIC_LIBS=ON \
  -DDNP3_TESTS=OFF \
  -DCMAKE_BUILD_TYPE=Release
cmake --build "${WORK_DIR}/build" --target master-demo --parallel 2

cd "${PROJECT_ROOT}"
npx tsx test/conformance/dnp3/outstation-fixture.ts >"${OUTSTATION_LOG}" 2>&1 &
outstation_pid="$!"

for _ in $(seq 1 100); do
  if grep -Fq "OUTSTATION_READY" "${OUTSTATION_LOG}"; then
    break
  fi
  if ! kill -0 "${outstation_pid}" 2>/dev/null; then
    echo "DNP3 outstation fixture exited before becoming ready" >&2
    cat "${OUTSTATION_LOG}" >&2
    exit 1
  fi
  sleep 0.1
done

if ! grep -Fq "OUTSTATION_READY" "${OUTSTATION_LOG}"; then
  echo "Timed out waiting for the DNP3 outstation fixture" >&2
  cat "${OUTSTATION_LOG}" >&2
  exit 1
fi

readonly MASTER_DEMO="${WORK_DIR}/build/cpp/examples/master/master-demo"
{
  sleep 2
  printf 'i\n'
  sleep 2
  printf 'e\n'
  sleep 3
  printf 'c\n'
  sleep 2
  printf 'x\n'
} | timeout 20s "${MASTER_DEMO}" >"${MASTER_LOG}" 2>&1

require_master_log() {
  local pattern="$1"
  local description="$2"
  if ! grep -Fq "${pattern}" "${MASTER_LOG}"; then
    echo "OpenDNP3 smoke failed: missing ${description} (${pattern})" >&2
    cat "${MASTER_LOG}" >&2
    exit 1
  fi
}

require_master_log "Begining task: Clear Restart IIN" "g80v1 restart acknowledgement"
require_master_log "001,002 Binary Input" "binary-input static data"
require_master_log "010,002 Binary Output" "binary-output status"
require_master_log "020,001 Counter" "counter static data"
require_master_log "030,005 Analog Input" "analog-input static data"
require_master_log "040,003 Analog Output Status" "analog-output status"
require_master_log "002,002 Binary Input Event" "Class 1 event data"
require_master_log "032,007 Analog Input Event" "Class 2 event data"
require_master_log "022,005 Counter Event" "Class 3 event data"
require_master_log "FUNC: UNSOLICITED_RESPONSE" "unsolicited event response"
require_master_log "State: SUCCESS Status: SUCCESS" "SELECT/OPERATE control success"

if grep -Eq "Task was explicitly rejected|summary: FAILURE|Status: (NOT_SUPPORTED|FORMAT_ERROR|NOT_AUTHORIZED)" "${MASTER_LOG}"; then
  echo "OpenDNP3 reported a rejected task or command" >&2
  cat "${MASTER_LOG}" >&2
  exit 1
fi

if ! grep -Fq "CONTROL_EXECUTED" "${OUTSTATION_LOG}"; then
  echo "The OpenDNP3 command parsed, but did not reach the outstation control sink" >&2
  cat "${OUTSTATION_LOG}" >&2
  exit 1
fi

echo "OpenDNP3 3.1.2 conformance smoke passed:"
echo "  Class 0: BI, AI, Counter, BO status, AO status"
echo "  Events: Class 1/2/3 and confirmed unsolicited responses"
echo "  Controls: SELECT/OPERATE reached the writable tag sink"
echo "  Startup: IIN byte order and WRITE g80v1 restart clear accepted"
