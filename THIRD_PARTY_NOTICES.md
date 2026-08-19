# Third-party notices

This repository contains and depends on software under licenses other than the
MIT license used for the gateway-specific code.

## Apache Guacamole JavaScript client

`public/guacamole/all.min.js` is the minified `guacamole-common-js` client from
Apache Guacamole 1.6.0. Apache Guacamole is licensed under the Apache License,
Version 2.0. The upstream project and license are available at:

- https://guacamole.apache.org/
- https://github.com/apache/guacamole-client
- [Apache License 2.0](LICENSE-APACHE-2.0)

The vendored file has this SHA-256 digest:

```text
cc89f710ecc544477dbe6bfea453fab752dafa1b1ab9770f523676e7b744b44a
```

## guacamole-lite

The Node.js dependency `guacamole-lite` 1.2.0 is licensed under the Apache
License, Version 2.0. Its transitive dependency licenses are recorded in
`package-lock.json`.

## Apache Guacamole server

The installation scripts build Apache Guacamole Server from upstream source at
the pinned commit documented in `deploy/GUACD-BUILD-MANIFEST`. The upstream
source is not copied into this repository and is licensed under the Apache
License, Version 2.0.

The upstream Apache attribution is preserved in
[`NOTICE-APACHE-GUACAMOLE`](NOTICE-APACHE-GUACAMOLE).
