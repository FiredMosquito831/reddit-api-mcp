# Notice

reddit-api-mcp takes its feature set, and several of its behaviors, from three projects. All three are MIT-licensed. No source code from them is copied. This project's code is written from scratch, and the features and endpoint choices were studied from their public code and documentation.

- [jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server): the MCP tool set, the password login mode, the write safety rules, the bot disclosure footer, the response cache, the HTTP transport with a bearer token, and the Docker setup.
- [karanb192/reddit-mcp-buddy](https://github.com/karanb192/reddit-mcp-buddy): the app-only read mode, the public RSS fallback, the user activity summary, the search and post-URL handling, the glossary, and the rate-limit check.
- [adhikasp/mcp-reddit](https://github.com/adhikasp/mcp-reddit): the environment-supplied refresh token.

Endpoint paths and form fields were also cross-checked against [PRAW](https://github.com/praw-dev/praw), the Python Reddit client, using its endpoint table and call sites.

This project depends on [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk), [commander](https://github.com/tj/commander.js), [@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node), and [zod](https://github.com/colinhacks/zod). Each is used under its own license.
