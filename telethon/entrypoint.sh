#!/bin/bash
# Entrypoint script to create session directory if it doesn't exist
# This avoids the overlay filesystem read-only issue when mounting volumes

# Create session directories if they don't exist
# /app/session is for main container (bind mount)
mkdir -p /app/session

# For multi-login containers: create symlink from /app/session_data to /tmp/session_volume
# This avoids Docker overlay filesystem read-only issue
if [ -d "/tmp/session_volume" ]; then
  # Volume is mounted, create symlink
  if [ ! -e "/app/session_data" ]; then
    ln -s /tmp/session_volume /app/session_data
    echo "✅ Created symlink: /app/session_data -> /tmp/session_volume"
  fi
else
  # No volume mounted (main container), create regular directory
  mkdir -p /app/session_data
fi

# Execute the main command
exec "$@"

