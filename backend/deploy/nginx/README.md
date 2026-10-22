# Serve ADDA legal pages on meet.ritzla.in

The page handlers still live in the ADDA backend. The Nginx locations in
`meet-legal-locations.conf` proxies only the legal paths to the ADDA backend
on port 3000. Keep the existing catch-all proxy to port 3010 unchanged in the
HTTPS `meet.ritzla.in` server block.

On the VPS, include the file from that server block (adjust the workspace path
to its deployed location), then validate and reload Nginx:

```nginx
include /etc/nginx/snippets/meet-legal-locations.conf;
```

```sh
sudo nginx -t && sudo systemctl reload nginx
```

The `/account-deletion` proxy accepts both GET and POST, so the web deletion
form continues to submit to the same `meet.ritzla.in` URL. The backend must be
reachable at `127.0.0.1:3000` from Nginx. The API host and MiroTalk route
remain unchanged.

After deployment, verify these HTTPS pages before using the new app links or
updating the Play Console URLs:

- `https://meet.ritzla.in/terms`
- `https://meet.ritzla.in/community-guidelines`
- `https://meet.ritzla.in/privacy`
- `https://meet.ritzla.in/account-deletion`
