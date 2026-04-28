FROM oven/bun:1.3 AS builder
WORKDIR /app

COPY package*.json bun.lock ./
RUN bun install

COPY . .

# RUN bun run build


FROM oven/bun:1.3 AS runtime
WORKDIR /app

RUN groupadd -r app && useradd -r -g app app 

COPY --from=builder --chown=app:app /app /app

# With Build Step
# COPY --from=builder --chown=app:app /app/dist ./dist 
 
USER app

EXPOSE 3000

CMD ["bun", "run", "start"]
