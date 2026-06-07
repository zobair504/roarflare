# RoarFlare

RoarFlare is a Cloudflare Worker that generates an `.m3u` playlist from RoarZone and combines it with a few direct local channel links.

The Worker does not proxy video segments. It only builds the playlist, fetches the signed RoarZone manifests, and rewrites manifest URLs so the player can request the stream directly.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mesamirh/RoarFlare)

## Deployment

### One-click deploy

Use the button above to deploy the Worker to your own Cloudflare account.

### Manual deploy

```bash
npm install
npx wrangler deploy
```

## Usage

After deployment, use this URL in your IPTV or M3U player:

```text
https://<your-worker-domain.workers.dev>/playlist.m3u
```

This playlist includes:

- local direct links from `LOCAL_CHANNELS`
- RoarZone channels discovered by the Worker

## Notes

- The local `10.14.56.20` links are passed through directly. They only work for users who can reach that network.
- RoarZone channels depend on the upstream site staying available and keeping the same general page structure.
- If RoarZone is slow or temporarily unavailable, some channels may fail until the Worker can fetch a fresh signed manifest.

## Configuration

Edit `LOCAL_CHANNELS` in `src/index.js` if you want to add, remove, or replace the direct local channels.
