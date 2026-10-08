---
title: Storage
tags:
  - storage
---

# Storage

## Payload Upload

Batch payloads are uploaded as one blob per batch id. The upload is a single put of the raw bytes, and the content type is application/octet-stream. The API performs this upload before it enqueues the message. A failed upload leaves no message on the queue. The worker later downloads that same blob. The object key is the batch id and nothing is appended to the key. Replacing a payload writes the same key again.
