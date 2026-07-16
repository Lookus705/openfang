# OpenFang on Coolify via GitHub Actions + GHCR

This setup keeps Rust compilation out of the VPS. GitHub Actions builds the full
OpenFang container image, pushes it to GitHub Container Registry (GHCR), and
Coolify only pulls and runs that pinned image.

## What is pinned

- OpenFang version: `0.6.9`
- VPS architecture checked on `2026-07-16`: `linux/amd64`
- Published image tag: `ghcr.io/Lookus705/openfang:0.6.9`
- Persistent data path in the container: `/data`
- Container port: `4200`
- Health endpoint: `GET /api/health`

The version and target platform are defined in [`deploy/coolify/image.env`](./image.env).

## What GitHub Actions builds

The workflow at [`/.github/workflows/build-coolify-ghcr.yml`](../../.github/workflows/build-coolify-ghcr.yml):

- checks out this repository
- reads the pinned OpenFang version and target platform from `deploy/coolify/image.env`
- builds the full Docker image from source in GitHub Actions
- publishes only the `linux/amd64` image to your GHCR namespace
- tags the image with:
  - `0.6.9`
  - `0.6.9-amd64`
  - `sha-<commit>`

No `latest` tag is published by this workflow.

## Before you run the workflow

1. Create a GitHub repository under the account or organization that will own the GHCR image.
2. Push this project there.
3. Open the Actions tab in `Lookus705/openfang` and run `Build Coolify GHCR Image`.

This workflow uses the built-in `GITHUB_TOKEN` to push into GHCR for the same
repository owner. If you keep the GHCR package private, Coolify will need GHCR
credentials to pull it.

## Coolify deployment settings

Create a new application in Coolify using a Docker image, not a Git repository.

### Image

- Image: `ghcr.io/Lookus705/openfang:0.6.9`
- Registry: `ghcr.io`

If the package is private, configure registry authentication with:

- Username: your GitHub username
- Password: a GitHub classic PAT with `read:packages`

If the package is public, Coolify can pull it anonymously.

### Port

- Container port: `4200`

### Persistent storage

- Mount path inside the container: `/data`
- Suggested volume name in Coolify: `openfang-data`

### Required environment variables

Use [`deploy/coolify/coolify.env.example`](./coolify.env.example) as the base.

Minimum required variables:

- `OPENFANG_LISTEN=0.0.0.0:4200`
- `OPENFANG_API_KEY=<long-random-secret>`

Optional provider variables:

- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY`
- `GROQ_API_KEY`
- `OLLAMA_HOST`
- `LMSTUDIO_HOST`
- `VLLM_HOST`

### Healthcheck

Configure the Coolify healthcheck to probe:

- Path: `/api/health`
- Port: `4200`
- Method: `GET`

The image also embeds a Docker `HEALTHCHECK` that probes
`http://127.0.0.1:4200/api/health` from inside the container.

## Verification after deploy

1. Open the Coolify-generated URL or your custom domain and confirm the dashboard loads.
2. Call the public health endpoint:

   ```bash
   curl https://your-domain.example/api/health
   ```

3. Optionally verify the authenticated detail endpoint:

   ```bash
   curl -H "Authorization: Bearer <OPENFANG_API_KEY>" \
     https://your-domain.example/api/health/detail
   ```

## Updating later

When a new OpenFang release is available:

1. Pull or merge the upstream release tag into this repository.
2. Update `OPENFANG_VERSION`, `UPSTREAM_OPENFANG_REF`, and `IMAGE_TAG` in [`deploy/coolify/image.env`](./image.env).
3. Push the change.
4. Re-run `Build Coolify GHCR Image`.
5. In Coolify, change the image tag from `0.6.9` to the new fixed version.
6. Redeploy and re-check `/api/health`.

If you ever move the app to an ARM VPS, change `TARGET_PLATFORM` to
`linux/arm64`, rerun the workflow, and update the Coolify image tag.
