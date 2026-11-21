#!/bin/sh
set -eu

for source in /seed/*/workflow.yaml; do
  [ -f "$source" ] || continue
  project=${source#/seed/}
  project=${project%/workflow.yaml}
  mkdir -p "/workflows/$project"
  if [ ! -f "/workflows/$project/workflow.yaml" ]; then
    cp "$source" "/workflows/$project/workflow.yaml"
  fi
done
chown -R 1000:1000 /workflows
