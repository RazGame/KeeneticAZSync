FROM node:24-alpine

WORKDIR /app

# Copy dependency definition
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source code and config template
COPY src ./src
COPY bin ./bin
COPY web ./web
COPY config.example.yaml ./config.example.yaml

# Create directory for mapped config and adjust permissions
RUN mkdir -p /app/config && chown -R node:node /app

# Run as non-root user
USER node

ENV PORT=8787
ENV HOST=0.0.0.0
ENV CONFIG_PATH=/app/config/config.yaml

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.PORT+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Command to run the application
CMD ["node", "bin/awgsync.js", "serve"]
