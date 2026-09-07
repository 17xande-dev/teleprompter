# Stage 1: bundle the frontend with Deno.
FROM denoland/deno:alpine-2.9.6 AS frontend
WORKDIR /app
COPY deno.jsonc deno.lock ./
COPY bundle.ts ./
COPY tools/ ./tools/
COPY src/frontend/ ./src/frontend/
# Populate the module cache from the lockfile before running the task, so a
# bad or missing lockfile entry fails the build loudly instead of silently
# refetching.
RUN deno install --frozen
RUN deno task build

# Stage 2: compile the server, embedding the bundle stage produced above.
# go:embed reads src/backend/dist at *compile* time (see CLAUDE.md), so the
# frontend must land there before `go build` runs.
FROM golang:1.27-alpine AS backend
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY src/backend/ ./src/backend/
COPY --from=frontend /app/src/backend/dist ./src/backend/dist
RUN CGO_ENABLED=0 go build -o /teleprompter ./src/backend

# Stage 3: minimal runtime image.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=backend /teleprompter /usr/local/bin/teleprompter
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/teleprompter"]
