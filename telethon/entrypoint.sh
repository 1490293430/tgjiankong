#!/bin/bash
# Entrypoint script to create session directory if it doesn't exist
# This avoids the overlay filesystem read-only issue when mounting volumes

# Create session directories if they don't exist
# /app/session is for main container (bind mount)
# Only create if /app is writable (not mounted as read-only)
if [ -w "/app" ]; then
  mkdir -p /app/session
fi

# For multi-login containers: /tmp/session_volume is already mounted
# monitor.py will use SESSION_PATH environment variable directly
# No need to create symlink since we use /tmp/session_volume/user_${USER_ID} directly
if [ -d "/tmp/session_volume" ]; then
  echo "✅ Session volume mounted at /tmp/session_volume"
fi

# Execute the main command
exec "$@"

