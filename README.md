# Project

A full-stack application with a Postgres database and a mock upstream service for local development.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/)

## Local Development Quickstart

Get a fresh clone to a running stack in under five commands:

```bash
git clone <repository-url> && cd <repository-name>   # 1. Clone and enter the repo
pnpm install                                          # 2. Install dependencies
docker compose up -d                                  # 3. Start Postgres and the mock upstream
pnpm db:migrate                                       # 4. Apply database migrations
pnpm dev                                              # 5. Start the dev servers
```

That's it — the app should now be running locally.

### What each command does

1. **Clone and enter the repo** — grabs the source and moves into the project directory.
2. **`pnpm install`** — installs all workspace dependencies.
3. **`docker compose up -d`** — starts the services defined in [`docker-compose.yml`](./docker-compose.yml):
   - **Postgres** — the local database, exposed on the default port (`5432`).
   - **Mock upstream** — a lightweight stand-in for the external upstream service, so you can develop and test without hitting real third-party endpoints.
4. **`pnpm db:migrate`** — runs the database migrations against the Postgres container.
5. **`pnpm dev`** — starts the application dev servers with hot reload.

### Stopping and cleaning up

```bash
docker compose down          # Stop the containers (keeps data)
docker compose down -v       # Stop the containers and remove volumes (wipes data)
```

## Configuration

The default environment variables are set up to work with the Docker Compose services out of the box. If you need to customize ports, credentials, or the mock upstream URL, copy the example env file and adjust as needed:

```bash
cp .env.example .env
```

See [`docker-compose.yml`](./docker-compose.yml) for the full list of services and their exposed ports.

## Scripts

| Script            | Description                                  |
| ----------------- | -------------------------------------------- |
| `pnpm dev`        | Start the dev servers with hot reload        |
| `pnpm build`      | Build the application for production         |
| `pnpm db:migrate` | Apply database migrations                    |
| `pnpm test`       | Run the test suite                           |
| `pnpm lint`       | Lint the codebase                            |