Encode the image with base64 before embedding it: `base64 -w0 logo.png > logo.b64`.
Download the release archive: `curl -LO https://example.com/app-1.2.0.tar.gz`, then verify the
checksum with `sha256sum -c`. Use `ssh deploy@host` to open a shell on the server.
