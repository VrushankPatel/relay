.PHONY: help install build test typecheck docker-build docker-up docker-down clean

# Default target
all: help

help:
	@echo "Relay Proxy - Available Commands:"
	@echo "  make install       Install npm dependencies"
	@echo "  make build         Build the TypeScript application"
	@echo "  make test          Run unit and integration tests"
	@echo "  make typecheck     Run TypeScript compiler check"
	@echo "  make docker-build  Build the Docker image locally"
	@echo "  make docker-up     Start the proxy using Docker Compose"
	@echo "  make docker-down   Stop the proxy running in Docker Compose"
	@echo "  make clean         Remove build artifacts and node_modules"

install:
	npm install

build:
	npm run build

test:
	npm run test

typecheck:
	npx tsc --noEmit

docker-build:
	docker build -t relay:latest .

docker-up:
	docker compose up -d

docker-down:
	docker compose down

clean:
	rm -rf dist coverage node_modules
