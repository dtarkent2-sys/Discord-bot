#!/bin/bash
# Ollama startup script for Railway
# 1. Starts Ollama server in the background
# 2. Waits for it to be ready
# 3. Auto-pulls models from OLLAMA_MODELS env var
# 4. Foregrounds the server process

set -e

echo "[Ollama] Starting Ollama server..."
ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready (up to 60 seconds)
echo "[Ollama] Waiting for server to be ready..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "[Ollama] Server is ready!"
    break
  fi
  if [ $i -eq 60 ]; then
    echo "[Ollama] ERROR: Server failed to start within 60 seconds"
    exit 1
  fi
  sleep 1
done

# Auto-pull models from OLLAMA_MODELS env var (comma-separated)
# Models are stored on the persistent volume at /root/.ollama
# Already-pulled models are skipped (no re-download)
MODELS="${OLLAMA_MODELS:-llama3.2:3b}"

echo "[Ollama] Configured models: $MODELS"

IFS=',' read -ra MODEL_LIST <<< "$MODELS"
for model in "${MODEL_LIST[@]}"; do
  model=$(echo "$model" | xargs) # trim whitespace
  if [ -z "$model" ]; then
    continue
  fi
  echo "[Ollama] Pulling model: $model"
  ollama pull "$model" || echo "[Ollama] WARNING: Failed to pull $model — may already exist or network issue"
done

# List available models
echo "[Ollama] Available models:"
ollama list

echo "[Ollama] Ready for inference. Listening on :11434"

# Keep the server running in the foreground
wait $OLLAMA_PID
