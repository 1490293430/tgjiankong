#!/bin/bash
# Entrypoint script to create session directory if it doesn't exist
# This avoids the overlay filesystem read-only issue when mounting volumes

# Create session directories if they don't exist
# /app/session is for main container (bind mount)
# Only create if /app is writable (not mounted as read-only)
if [ -w "/app" ]; then
  mkdir -p /app/session
fi

# For multi-login containers: create symlink from /app/session_data to /tmp/session_volume
# This avoids Docker overlay filesystem read-only issue
if [ -d "/tmp/session_volume" ]; then
  # Volume is mounted, create symlink
  # Only create symlink if /app is writable
  if [ -w "/app" ] && [ ! -e "/app/session_data" ]; then
    ln -s /tmp/session_volume /app/session_data
    echo "✅ Created symlink: /app/session_data -> /tmp/session_volume"
  elif [ ! -w "/app" ]; then
    # /app is read-only, use /tmp/session_volume directly
    # Set environment variable to tell monitor.py to use /tmp/session_volume
    export SESSION_VOLUME_PATH=/tmp/session_volume
    echo "✅ Using session volume directly: /tmp/session_volume (read-only /app)"
  fi
else
  # No volume mounted (main container), create regular directory
  if [ -w "/app" ]; then
    mkdir -p /app/session_data
  fi
fi

# Execute the main command
exec "$@"

