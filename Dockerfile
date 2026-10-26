# The public demo (docs/DEMO.md): fictional data only, wiped and reseeded every 6 hours.
#   docker build -t bridge-runs-demo . && docker run --rm -p 3100:3100 bridge-runs-demo
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# The demo writes only under the OS temp dir (/tmp/bridge-runs-demo), never into /app.
USER node
EXPOSE 3100
CMD ["node", "scripts/run-demo.mjs"]
