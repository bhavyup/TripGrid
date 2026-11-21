#!/bin/bash
# Stop the TripGrid API server running inside WSL.
pkill -f "python -m api[.]app"
sleep 1
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 localhost:8000/api/health)
echo "health after stop: $code"
if pgrep -f "python -m api[.]app" > /dev/null; then
  echo "STILL RUNNING"
else
  echo "SERVER STOPPED"
fi
