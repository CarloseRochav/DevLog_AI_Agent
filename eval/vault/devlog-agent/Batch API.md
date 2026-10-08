---
title: Batch API
tags:
  - api
---

# Batch API

## Listener

The Batch API listens on port 8443. Clients send HTTPS requests to that port and to no other port. The listener accepts one batch description per request and returns the new batch id. Nothing else in this system binds to 8443. Health checks use the same listener and the same port. The process refuses to start if that port is already taken. Operators look for a listening socket on 8443 when the API seems down.
