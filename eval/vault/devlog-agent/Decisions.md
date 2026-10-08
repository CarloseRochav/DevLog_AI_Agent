---
title: Decisions
tags:
  - storage
---

# Decisions

## Blob Storage

We chose Blob Storage over a file share because each batch payload is large, written once, and read by one worker. A file share would need a mounted drive on every machine that runs the worker, and the share lock timed out when several readers opened the same payload. Blob Storage keeps each payload as one object whose key is the batch id. Workers download that object over HTTPS and do not share a disk. The decision was recorded after those lock timeouts showed up in the load test.
