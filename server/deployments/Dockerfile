# syntax=docker/dockerfile:1
ARG GO_VERSION=1.24.3

FROM golang:${GO_VERSION}-bookworm AS build
WORKDIR /src

COPY go.mod go.sum ./
ARG GOPROXY=https://proxy.golang.org,direct
RUN go mod download

COPY . .
ARG TARGET=api
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/${TARGET}

FROM gcr.io/distroless/static-debian12:nonroot
ARG APP_SHA=development
ARG CONFIG_SHA=development
LABEL org.opencontainers.image.source="https://github.com/chenbb0128/Pic" \
      org.opencontainers.image.revision="${APP_SHA}" \
      com.zdzq.config-sha="${CONFIG_SHA}"
WORKDIR /app
COPY --from=build /out/app /app/app
COPY configs /app/configs
COPY database/migrations /app/database/migrations
COPY --chown=nonroot:nonroot storage /data/assets
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/app/app"]
