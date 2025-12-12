#!/bin/bash
# Entrypoint script to create session directory if it doesn't exist
# This avoids the overlay filesystem read-only issue when mounting volumes

# Create session directories if they don't exist
# /app/session is for main container (bind mount)
# /app/session_data is for multi-login containers (volume mount)
mkdir -p /app/session
mkdir -p /app/session_data

# Execute the main command
exec "$@"

