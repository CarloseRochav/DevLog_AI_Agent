---
title: Security
tags:
  - security
---

# Security

## API Key

The Batch API authenticates callers with the x-api-key header. The header value is compared with the configured API key. A missing or wrong key is rejected before the payload is stored. The comparison is an exact match. Anonymous requests are rejected. The key is not written into the batch record or the queue message. Callers send the header on every request, including a repeat of the same request.
