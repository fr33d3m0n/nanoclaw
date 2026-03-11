#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# --- Prepare skill-audit package for Docker build context ---
SKILL_AUDIT_SRC="${SKILL_AUDIT_SRC:-$HOME/skill-audit-v1}"
if [ -d "$SKILL_AUDIT_SRC/src/skill_audit" ]; then
  echo "Packaging skill-audit from $SKILL_AUDIT_SRC..."
  rm -rf skill-audit-pkg
  mkdir -p skill-audit-pkg/src
  cp -r "$SKILL_AUDIT_SRC/src/skill_audit" skill-audit-pkg/src/
  cp "$SKILL_AUDIT_SRC/pyproject.toml" skill-audit-pkg/
  cp "$SKILL_AUDIT_SRC/README.md" skill-audit-pkg/ 2>/dev/null || true
  echo "  skill-audit package prepared."
else
  echo "WARNING: skill-audit source not found at $SKILL_AUDIT_SRC"
  echo "  Containers will not have skill-audit. Set SKILL_AUDIT_SRC to override."
  # Create empty directory so Dockerfile COPY doesn't fail
  mkdir -p skill-audit-pkg
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Clean up build context
rm -rf skill-audit-pkg

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
