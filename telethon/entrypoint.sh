#!/bin/bash
# Entrypoint script to create session directory if it doesn't exist
# This avoids the overlay filesystem read-only issue when mounting volumes

# Create session directory if it doesn't exist
mkdir -p /app/session

# Execute the main command
exec "$@"

