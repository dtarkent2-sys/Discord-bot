# Ollama service for Railway — local LLM inference
# Uses persistent volume at /root/.ollama to store models across deploys
#
# Railway setup:
#   1. Create a new service in your Railway project
#   2. Point it to this Dockerfile (root directory: /ollama)
#   3. Add a persistent volume mounted at /root/.ollama
#   4. Enable private networking (service name: "ollama")
#   5. Set env vars: OLLAMA_MODELS=llama3.2:3b (comma-separated list)
#
# The bot connects via: http://ollama.railway.internal:11434

FROM ollama/ollama:latest

# Expose Ollama's default port for Railway private networking
EXPOSE 11434

# Copy startup script that auto-pulls models
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Health check — Ollama responds to GET /api/tags when ready
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD curl -sf http://localhost:11434/api/tags || exit 1

ENTRYPOINT ["/start.sh"]
