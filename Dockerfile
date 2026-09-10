FROM node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d AS build

ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /workspace

RUN npm install --global sfw@2.0.6

COPY package.json package-lock.json ./
RUN sfw npm ci

COPY . .
RUN npm run typecheck \
  && npm run lint \
  && npm run check:source \
  && npm run check:licenses \
  && npm run test \
  && npm run build \
  && npm run check:privacy

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS acceptance

ENV HOME=/tmp/home
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /usr/local/bin/node /usr/local/bin/node

WORKDIR /workspace
COPY --from=build /workspace /workspace
RUN chmod a+rwx /workspace \
  && chmod -R a+rwX /workspace/.next /workspace/out \
  && mkdir -p /workspace/artifacts /workspace/node_modules/.vite-temp /workspace/playwright-report /workspace/test-results \
  && chmod a+rwx /workspace/artifacts /workspace/node_modules/.vite-temp /workspace/playwright-report /workspace/test-results

CMD ["npm", "run", "acceptance"]

FROM node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d AS collector

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace /workspace
USER node
CMD ["node", "--import", "tsx", "scripts/watch-observatory.ts"]

FROM node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d AS static

ENV HOST=0.0.0.0
ENV PORT=4173
ENV STATIC_ROOT=/app/out
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

WORKDIR /app
COPY --from=build --chown=node:node /workspace/out ./out
COPY --from=build --chown=node:node /workspace/scripts/serve-static.mjs ./scripts/serve-static.mjs

USER node
EXPOSE 4173

CMD ["node", "scripts/serve-static.mjs"]
