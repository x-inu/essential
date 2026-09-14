# Essential Raw Tools

Two small shell tools served as static Cloudflare Worker assets.

## Tools

```sh
curl -fsSL https://raw.xinu.my.id/cinit | sh
curl -fsSL https://raw.xinu.my.id/sudo | sh
```

Review a tool before running it:

```sh
curl -fsSL https://raw.xinu.my.id/cinit
curl -fsSL https://raw.xinu.my.id/sudo
```

## Structure

```text
public/          static site and public tool files
  index.html     landing page
  style.css      page styles
  app.js         copy controls and small interactions
  favicon.svg    site icon
  _redirects     maps the short public URLs to the tool files
  tool/
    cinit        cloud-init tool, available at /cinit
    sudo         sudo tool, available at /sudo
src/index.js     404 fallback
wrangler.toml    Worker static-assets configuration
```

## Develop

```sh
npx wrangler dev
```

## Deploy

```sh
npx wrangler deploy
```

## License

[GPL-3.0](LICENSE)
