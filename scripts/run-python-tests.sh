#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."
export PYTHONPATH=".:${PYTHONPATH:-}"

python3 -m pytest tests "$@"
