FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    REDDIT_MCP_HOST=0.0.0.0 \
    REDDIT_MCP_PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3000
USER node
CMD ["node", "src/mcp.js", "--http"]
